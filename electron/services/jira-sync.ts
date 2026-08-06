/**
 * Jira two-way sync for season-scoped kanban boards (sub-feature 17d).
 *
 * COPY-ADAPTED from `mcp-orchestrator/src/tools/automations.ts` (pollJira,
 * createKanbanTaskFromJiraItem, the jira_comment / jira_transition output
 * handlers) — NOT imported, so the mcp-orchestrator workspace/build stays
 * untouched. The Basic-auth + host-normalization pattern mirrors the
 * `jira:test` handler in `electron/handlers/ipc-handlers.ts` (~1480-1508), and
 * credentials are read from the SAME place that handler reads them: the app
 * settings file at `~/.echelon/app-settings.json` (constant `APP_SETTINGS_FILE`).
 *
 * Direction of sync:
 *   • Import (Jira → board): `importJiraToBoard(seasonId)` pulls a linked
 *     project's issues and upserts them as season-scoped kanban tasks, matched
 *     by `jiraKey`. Idempotent: re-import updates in place, never duplicates.
 *   • Push (board → Jira): `pushTaskMove` transitions the linked issue when a
 *     Jira-linked card changes column; `pushTaskComment` posts a local comment
 *     to the linked issue. Both are best-effort and NEVER throw into a kanban
 *     handler — a Jira/network failure logs (console + a system conversation
 *     entry on the season) and returns.
 *
 * Resilience contract: every exported entry point is wrapped so a Jira/network
 * failure logs and returns; none of them throw to the caller.
 */

import * as fs from 'fs';
import { APP_SETTINGS_FILE } from '../constants';
// NOTE: kanban-handlers ⇄ jira-sync is a deliberate runtime-safe circular import.
// These bindings are only ever CALLED inside function bodies (never at module-eval
// scope), so both modules are fully initialized by the time any of them runs. Do
// NOT call these at top level — under CJS circular init a module-level call would
// read `undefined`.
import {
  loadTasks,
  saveTasks,
  createTask,
  emitTaskEvent,
} from '../handlers/kanban-handlers';
import type { KanbanTask, KanbanColumn, KanbanIssueType } from '../handlers/kanban-handlers';
import { getSeason } from '../core/season-manager';
import { appendConversationEntry } from '../core/conversation-log';

// ============================================================================
// CONFIG / AUTH (reuse the jira:test source — APP_SETTINGS_FILE)
// ============================================================================

/** Resolved Jira connection config; `enabled` gates every network call. */
export interface JiraConfig {
  baseUrl: string; // e.g. "https://mycompany.atlassian.net"
  email: string;
  apiToken: string;
  enabled: boolean;
  /** When disabled, a human-readable reason for the UI/logs. */
  reason?: string;
}

/**
 * Normalize a JIRA domain value to a full hostname. Copy of `normalizeJiraHost`
 * from `electron/handlers/ipc-handlers.ts` (~32-39) so this module has no
 * dependency on the handler. Handles bare subdomains and full hostnames.
 */
function normalizeJiraHost(domain: string): string {
  let host = domain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!host.includes('.')) {
    host = `${host}.atlassian.net`;
  }
  return host;
}

/**
 * Read Jira credentials from the app settings file — the SAME source the
 * `jira:test` IPC handler reads (`jiraEnabled` / `jiraDomain` / `jiraEmail` /
 * `jiraApiToken`). Returns a disabled config (with a reason) when the file is
 * missing, Jira is not enabled, or any credential is blank. Never throws.
 */
export function getJiraConfig(): JiraConfig {
  const disabled = (reason: string): JiraConfig => ({
    baseUrl: '',
    email: '',
    apiToken: '',
    enabled: false,
    reason,
  });

  try {
    if (!fs.existsSync(APP_SETTINGS_FILE)) {
      return disabled('Jira is not configured (no app settings found).');
    }
    const settings = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf-8'));
    if (!settings.jiraEnabled) {
      return disabled('Jira integration is disabled. Enable it in Settings.');
    }
    const domain = (settings.jiraDomain || '').trim();
    const email = (settings.jiraEmail || '').trim();
    const apiToken = (settings.jiraApiToken || '').trim();
    if (!domain || !email || !apiToken) {
      return disabled('Jira domain, email, and API token are all required. Configure them in Settings.');
    }
    return {
      baseUrl: `https://${normalizeJiraHost(domain)}`,
      email,
      apiToken,
      enabled: true,
    };
  } catch (err) {
    console.error('jira-sync: failed to read Jira config:', err);
    return disabled('Failed to read Jira configuration.');
  }
}

function authHeaders(cfg: JiraConfig): Record<string, string> {
  const auth = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  return {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Basic-auth fetch against the Jira REST API. Throws on non-2xx with the status
 * text (callers wrap this; nothing here propagates to a kanban handler). Returns
 * the parsed JSON body (or `undefined` for an empty 2xx response).
 */
async function jiraFetch(
  cfg: JiraConfig,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}${apiPath}`, {
    method,
    headers: authHeaders(cfg),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jira ${method} ${apiPath} → HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  // 204 No Content (e.g. successful transition) has no JSON body.
  if (res.status === 204) return undefined;
  const raw = await res.text();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ============================================================================
// MAPPINGS
// ============================================================================

/**
 * Map a Jira issue type → kanban `issueType`. Prefers the numeric
 * `hierarchyLevel` (Epic = 1+, Story/Task = 0, Sub-task = -1); falls back to the
 * type name when the level is absent. Missing ⇒ 'task'.
 */
function mapIssueType(issuetype: { name?: string; hierarchyLevel?: number } | undefined): KanbanIssueType {
  if (issuetype) {
    const level = issuetype.hierarchyLevel;
    if (typeof level === 'number') {
      if (level >= 1) return 'epic';
      if (level === 0) return 'story';
      return 'task'; // sub-task / negative levels
    }
    const name = (issuetype.name || '').toLowerCase();
    if (name.includes('epic')) return 'epic';
    if (name.includes('sub') && name.includes('task')) return 'task';
    if (name.includes('story')) return 'story';
  }
  return 'task';
}

/**
 * Map a Jira status category key → kanban column.
 *   'new'           → 'backlog'
 *   'indeterminate' → 'ongoing'
 *   'done'          → 'done'
 * Anything unknown defaults to 'backlog'.
 */
function mapStatusCategoryToColumn(categoryKey: string | undefined): KanbanColumn {
  switch ((categoryKey || '').toLowerCase()) {
    case 'done':
      return 'done';
    case 'indeterminate':
      return 'ongoing';
    case 'new':
    default:
      return 'backlog';
  }
}

/**
 * Map a kanban column → the Jira status-category key a transition's target
 * status must belong to (the inverse of {@link mapStatusCategoryToColumn}).
 * 'planned' and 'ongoing' both target an in-progress ('indeterminate') status.
 */
function mapColumnToStatusCategory(column: KanbanColumn): string {
  switch (column) {
    case 'done':
      return 'done';
    case 'planned':
    case 'ongoing':
      return 'indeterminate';
    case 'backlog':
    default:
      return 'new';
  }
}

/** Map a Jira priority name → kanban priority. */
function mapPriority(priorityName: string | undefined): 'low' | 'medium' | 'high' {
  const p = (priorityName || '').toLowerCase();
  if (p.includes('high') || p.includes('critical') || p.includes('blocker') || p.includes('highest')) {
    return 'high';
  }
  if (p.includes('low') || p.includes('trivial') || p.includes('lowest') || p.includes('minor')) {
    return 'low';
  }
  return 'medium';
}

// ============================================================================
// NORMALIZED PULL
// ============================================================================

/** A normalized Jira issue used by the import upsert. */
interface NormalizedIssue {
  key: string;
  summary: string;
  issueType: KanbanIssueType;
  column: KanbanColumn;
  statusName: string;
  priority: 'low' | 'medium' | 'high';
  parentKey?: string;
}

interface JiraSearchIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    priority?: { name?: string };
    issuetype?: { name?: string; hierarchyLevel?: number };
    parent?: { key?: string };
    labels?: string[];
  };
}

/**
 * Pull a project's issues (copy of `pollJira`'s query shape). Uses
 * `GET /rest/api/3/search/jql` with `project = "{KEY}" ORDER BY updated DESC`,
 * bounded to 100 results, requesting the fields the import needs. Returns a
 * normalized array. Throws on a Jira/network error (the caller wraps it).
 */
async function pullProjectIssues(cfg: JiraConfig, projectKey: string): Promise<NormalizedIssue[]> {
  // Jira project keys are alphanumeric/underscore; reject anything else so the key
  // cannot break out of the quoted JQL string (JQL-injection guard).
  if (!/^[A-Za-z0-9_]+$/.test(projectKey)) {
    throw new Error(`Invalid Jira project key: ${projectKey}`);
  }
  const jql = `project = "${projectKey}" ORDER BY updated DESC`;
  const fields = ['summary', 'description', 'status', 'priority', 'issuetype', 'parent', 'labels'];
  const params = new URLSearchParams({
    jql,
    maxResults: '100',
    fields: fields.join(','),
  });

  const data = (await jiraFetch(cfg, 'GET', `/rest/api/3/search/jql?${params.toString()}`)) as
    | { issues?: JiraSearchIssue[] }
    | undefined;
  const issues = data?.issues ?? [];

  const normalized: NormalizedIssue[] = [];
  for (const issue of issues) {
    if (!issue?.key) continue;
    const f = issue.fields ?? {};
    normalized.push({
      key: issue.key,
      summary: f.summary || issue.key,
      issueType: mapIssueType(f.issuetype),
      column: mapStatusCategoryToColumn(f.status?.statusCategory?.key),
      statusName: f.status?.name || '',
      priority: mapPriority(f.priority?.name),
      parentKey: f.parent?.key,
    });
  }
  return normalized;
}

// ============================================================================
// IMPORT (Jira → board)
// ============================================================================

/** Result of an import run, surfaced to the UI. */
export interface ImportResult {
  imported: number;
  updated: number;
  /** Set when the import did not run (disabled / no linked project) or failed. */
  error?: string;
  /** True when Jira is enabled + a project is linked (i.e. the sync is wired). */
  ran: boolean;
}

/**
 * Import (upsert) a linked Jira project's issues into the season's kanban board.
 *
 * Guards: the season must exist and have a `jiraProjectKey`, and Jira must be
 * enabled with valid creds — otherwise returns a clear disabled/empty result
 * (never throws). For each pulled issue, matched by `jiraKey` within the season:
 *   • new  → create via `createTask` (seasonId, issueType, jiraKey, jiraStatus,
 *            mapped column, priority, label `jira:{KEY}`).
 *   • existing → update title / jiraStatus / column when changed (load + save).
 * A second pass sets `parentId` from the Jira parent link when that parent was
 * also imported (matched by jiraKey). Logs a system conversation entry with the
 * counts. Resilient — any failure is caught and returned as an error result.
 */
export async function importJiraToBoard(seasonId: string): Promise<ImportResult> {
  try {
    const season = getSeason(seasonId);
    if (!season) {
      return { imported: 0, updated: 0, ran: false, error: 'Season not found.' };
    }
    const projectKey = season.jiraProjectKey?.trim();
    if (!projectKey) {
      return { imported: 0, updated: 0, ran: false, error: 'No Jira project linked to this season.' };
    }

    const cfg = getJiraConfig();
    if (!cfg.enabled) {
      return { imported: 0, updated: 0, ran: false, error: cfg.reason || 'Jira is not enabled.' };
    }

    const issues = await pullProjectIssues(cfg, projectKey);

    let imported = 0;
    let updated = 0;

    // First pass: upsert each issue as a season task (no parent linkage yet).
    // We re-load the live task list each iteration via load/save so createTask's
    // own persistence is observed; for updates we mutate + save the whole list.
    for (const issue of issues) {
      const tasks = loadTasks();
      const existing = tasks.find(t => t.seasonId === seasonId && t.jiraKey === issue.key);

      if (!existing) {
        createTask({
          title: issue.summary,
          description: '',
          projectId: projectKey,
          projectPath: season.workspacePath,
          priority: issue.priority,
          labels: [`jira:${issue.key}`],
          seasonId,
          issueType: issue.issueType,
          jiraKey: issue.key,
          column: issue.column,
        });
        // createTask does not carry jiraStatus through KanbanTaskCreate; stamp it
        // and the issueType-derived column directly on the freshly-created task.
        const after = loadTasks();
        const created = after.find(t => t.seasonId === seasonId && t.jiraKey === issue.key);
        if (created) {
          created.jiraStatus = issue.statusName;
          saveTasks(after);
          emitTaskEvent('kanban:task-updated', created);
        }
        imported++;
      } else {
        let changed = false;
        if (existing.title !== issue.summary) {
          existing.title = issue.summary;
          changed = true;
        }
        if (existing.jiraStatus !== issue.statusName) {
          existing.jiraStatus = issue.statusName;
          changed = true;
        }
        // Reflect the Jira status-category column on the board, but never disturb
        // a task an Echelon agent is actively running (`ongoing` with an agent).
        const agentActive = existing.column === 'ongoing' && Boolean(existing.assignedAgentId);
        if (!agentActive && existing.column !== issue.column) {
          existing.column = issue.column;
          if (issue.column === 'done' && !existing.completedAt) {
            existing.completedAt = new Date().toISOString();
            existing.progress = 100;
          }
          changed = true;
        }
        if (existing.issueType !== issue.issueType) {
          existing.issueType = issue.issueType;
          changed = true;
        }
        if (changed) {
          existing.updatedAt = new Date().toISOString();
          saveTasks(tasks);
          emitTaskEvent('kanban:task-updated', existing);
          updated++;
        }
      }
    }

    // Second pass: wire parent links now that every imported issue exists.
    const finalTasks = loadTasks();
    const byKey = new Map<string, KanbanTask>();
    for (const t of finalTasks) {
      if (t.seasonId === seasonId && t.jiraKey) byKey.set(t.jiraKey, t);
    }
    const reparented: KanbanTask[] = [];
    for (const issue of issues) {
      if (!issue.parentKey) continue;
      const child = byKey.get(issue.key);
      const parent = byKey.get(issue.parentKey);
      if (child && parent && child.parentId !== parent.id) {
        child.parentId = parent.id;
        child.updatedAt = new Date().toISOString();
        reparented.push(child);
      }
    }
    if (reparented.length > 0) {
      saveTasks(finalTasks);
      // Emit only the tasks whose parentId actually changed (not the whole season).
      for (const t of reparented) emitTaskEvent('kanban:task-updated', t);
    }

    appendConversationEntry(seasonId, {
      agentId: 'system',
      canonName: 'Jira',
      kind: 'system',
      text: `Imported ${imported} and updated ${updated} Jira issue${imported + updated === 1 ? '' : 's'} from project ${projectKey}.`,
    });

    return { imported, updated, ran: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('jira-sync: importJiraToBoard failed:', err);
    appendConversationEntry(seasonId, {
      agentId: 'system',
      canonName: 'Jira',
      kind: 'system',
      text: `Jira import failed: ${message}`,
    });
    return { imported: 0, updated: 0, ran: false, error: message };
  }
}

// ============================================================================
// PUSH (board → Jira)
// ============================================================================

interface JiraTransition {
  id: string;
  name?: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

/**
 * Transition a Jira issue so its status matches the kanban column the card was
 * moved to. GET the issue's available transitions, pick the one whose target
 * status's category matches the column's category, then POST it. If no matching
 * transition exists (or the issue is already in that category), this logs and
 * skips — best-effort. Throws only on the underlying fetch error (the public
 * wrapper catches it).
 */
async function transitionIssueToColumn(cfg: JiraConfig, issueKey: string, column: KanbanColumn): Promise<void> {
  const targetCategory = mapColumnToStatusCategory(column);
  const data = (await jiraFetch(cfg, 'GET', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`)) as
    | { transitions?: JiraTransition[] }
    | undefined;
  const transitions = data?.transitions ?? [];

  const match = transitions.find(
    t => (t.to?.statusCategory?.key || '').toLowerCase() === targetCategory,
  );
  if (!match) {
    console.warn(
      `jira-sync: no transition on ${issueKey} targets category "${targetCategory}" (column "${column}"); skipping.`,
    );
    return;
  }
  await jiraFetch(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    transition: { id: match.id },
  });
}

/**
 * Post a comment to a Jira issue using an ADF body (copy of the `jira_comment`
 * output handler's ADF shape). Throws only on the underlying fetch error.
 */
async function addIssueComment(cfg: JiraConfig, issueKey: string, body: string): Promise<void> {
  await jiraFetch(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: body }],
        },
      ],
    },
  });
}

/**
 * Best-effort push of a card's column change to its linked Jira issue. No-op
 * unless Jira is enabled AND the task carries both `seasonId` and `jiraKey`.
 * NEVER throws into the kanban handler — failures log (console + a system
 * conversation entry on the season) and return.
 */
export async function pushTaskMove(task: KanbanTask): Promise<void> {
  if (!task.seasonId || !task.jiraKey) return;
  const cfg = getJiraConfig();
  if (!cfg.enabled) return;
  try {
    await transitionIssueToColumn(cfg, task.jiraKey, task.column);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`jira-sync: pushTaskMove failed for ${task.jiraKey}:`, err);
    appendConversationEntry(task.seasonId, {
      agentId: 'system',
      canonName: 'Jira',
      kind: 'system',
      text: `Could not transition Jira issue ${task.jiraKey}: ${message}`,
    });
  }
}

/**
 * Best-effort push of a single comment to the task's linked Jira issue. No-op
 * unless Jira is enabled AND the task carries both `seasonId` and `jiraKey`.
 * Callers must only invoke this for locally-authored comments (`source ===
 * 'local'`) so Jira-sourced comments are never echoed back (loop avoidance).
 * NEVER throws into the kanban handler — failures log and return.
 */
export async function pushTaskComment(task: KanbanTask, comment: { body: string; authorName?: string }): Promise<void> {
  if (!task.seasonId || !task.jiraKey) return;
  const cfg = getJiraConfig();
  if (!cfg.enabled) return;
  try {
    const prefix = comment.authorName ? `${comment.authorName}: ` : '';
    await addIssueComment(cfg, task.jiraKey, `${prefix}${comment.body}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`jira-sync: pushTaskComment failed for ${task.jiraKey}:`, err);
    appendConversationEntry(task.seasonId, {
      agentId: 'system',
      canonName: 'Jira',
      kind: 'system',
      text: `Could not post comment to Jira issue ${task.jiraKey}: ${message}`,
    });
  }
}

/**
 * Lightweight status for the UI's Sync button: whether Jira is enabled and the
 * season's linked project key (if any). Never throws.
 */
export function jiraStatusForSeason(seasonId: string): { enabled: boolean; projectKey?: string; reason?: string } {
  const cfg = getJiraConfig();
  const season = getSeason(seasonId);
  return {
    enabled: cfg.enabled,
    projectKey: season?.jiraProjectKey?.trim() || undefined,
    reason: cfg.enabled ? undefined : cfg.reason,
  };
}
