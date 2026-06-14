/**
 * repo-context.ts — Brownfield context bootstrap.
 *
 * When a season starts on an EXISTING, in-flight project (intake = 'brownfield',
 * or any time a real repo is linked + cloned), this module bootstraps the team's
 * starting context from the repo BEFORE the cast goes to work.
 *
 * The flow (graceful + degrading at every step):
 *
 *   1. SEARCH for existing context, in order:
 *        (a) repo docs in the cloned workspace — docs/CODEBASE_MAP.md, README.md,
 *            CLAUDE.md / AGENTS.md, and a shallow listing of docs/.
 *        (b) the KB (kb-bridge → mempalace) for prior knowledge tagged to this
 *            repo. Best-effort: if mempalace isn't installed, this yields nothing
 *            and never throws.
 *        (c) prior season memory under ~/.echelon/seasons/* that referenced the
 *            same repo (their context.md / season.json).
 *
 *   2. IF context is found → consolidate it into a single `context.md` in the
 *      season dir, mirror it to the KB (best-effort), and mark the season's
 *      context status `ready`. The convener launch prompt references this file.
 *
 *   3. IF NO context is found → KICK OFF A CODE REVIEW to build it: spawn a
 *      dedicated onboarding/reviewer agent (the `principal-architect` archetype)
 *      in the cloned workspace via the SAME runtime used to cast the team
 *      (`createAgent` + provider.buildInteractiveCommand + PTY), with a prompt to
 *      map the architecture + current state and WRITE docs/CODEBASE_MAP.md plus a
 *      season `context.md`. The season is marked `reviewing` while it runs and
 *      flips to `ready` once the reviewer writes context.md (or completes).
 *
 * No shell injection: the reviewer is launched through the provider's
 * buildInteractiveCommand (the exact path used by launchSeasonAgents); the only
 * interpolated value is the season-owned workspace path, single-quote escaped.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { broadcastToAllWindows } from '../utils/broadcast';
import { createAgent, agents } from './agent-manager';
import { loadAgentConfig } from './archetype-loader';
import { resolveCharacterDir, getSoulFiles, assembleSoulPromptFile } from './character-loader';
import { mapCatalogModelToProviderModel } from './model-map';
import { trustClaudeProjects } from './claude-trust';
import { getProvider } from '../providers';
import { writeProgrammaticInput } from './pty-manager';
import * as kb from '../services/kb-bridge';
import { updateSeasonContextStatus } from './season-manager';
import type { SeasonRuntimeDeps } from './season-manager';
import type { Season, SeasonContextStatus } from '../types/echelon';

const SEASONS_DIR = path.join(DATA_DIR, 'seasons');

/** The archetype cast as the brownfield reviewer/onboarder. */
const REVIEWER_ARCHETYPE = 'principal-architect';

/** Docs we look for in the cloned workspace, in priority order. */
const REPO_DOC_CANDIDATES = [
  'docs/CODEBASE_MAP.md',
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
];

/** Max characters of any single source we fold into the consolidated context. */
const MAX_SOURCE_CHARS = 12_000;
/** Max files listed from docs/. */
const MAX_DOC_LISTING = 40;

/** A single piece of pre-existing context discovered during the search. */
interface ContextSource {
  /** Where it came from, for the consolidated file's provenance section. */
  origin: string;
  /** Markdown body (already truncated to MAX_SOURCE_CHARS). */
  body: string;
}

/** Result of {@link bootstrapRepoContext}. */
export interface BootstrapResult {
  status: SeasonContextStatus;
  /** Absolute path to the season's context.md, when one was written. */
  contextPath?: string;
  /** Whether a code-review agent was spawned (no prior context found). */
  reviewSpawned: boolean;
  /** Short human summary for the convener launch prompt. */
  summary: string;
}

/** Truncate a string to a max length with an ellipsis marker. */
function truncate(s: string, max = MAX_SOURCE_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars]`;
}

/** Normalize a repo identifier for loose cross-source matching. */
function repoKey(repoUrl: string | undefined): string {
  if (!repoUrl) return '';
  return repoUrl
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/** Update the season's context status + path and broadcast it to the UI. */
function setContextStatus(
  seasonId: string,
  status: SeasonContextStatus,
  contextPath?: string,
): void {
  updateSeasonContextStatus(seasonId, status, contextPath);
}

/**
 * Once brownfield context is `ready`, kick the PM's repo review → candidate
 * epics → "needs your direction" prompt (17c). Fire-and-forget so it never blocks
 * the bootstrap; the grooming routine is internally guarded (runs once) and
 * resilient (never throws). Re-resolves the season so it has the latest
 * contextPath set by {@link setContextStatus}.
 */
function triggerBrownfieldGrooming(seasonId: string): void {
  void (async () => {
    try {
      const { getSeason } = await import('./season-manager');
      const season = getSeason(seasonId);
      if (!season) return;
      const { reviewBrownfieldAndAskDirection } = await import('./grooming');
      await reviewBrownfieldAndAskDirection(seasonId, season.workspacePath);
    } catch (err) {
      console.error(`repo-context: brownfield grooming failed for season ${seasonId}:`, err);
    }
  })();
}

// ─── Step 1a: repo docs in the cloned workspace ───────────────────────────────

function searchRepoDocs(workspacePath: string): ContextSource[] {
  const sources: ContextSource[] = [];

  for (const rel of REPO_DOC_CANDIDATES) {
    const abs = path.join(workspacePath, rel);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const body = fs.readFileSync(abs, 'utf-8').trim();
        if (body) sources.push({ origin: `repo:${rel}`, body: truncate(body) });
      }
    } catch {
      // Unreadable file — skip without failing the whole search.
    }
  }

  // Shallow listing of docs/ so the team knows what reference material exists,
  // even when we don't inline every file.
  const docsDir = path.join(workspacePath, 'docs');
  try {
    if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
      const listed: string[] = [];
      const walk = (dir: string, prefix: string) => {
        if (listed.length >= MAX_DOC_LISTING) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (listed.length >= MAX_DOC_LISTING) break;
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(path.join(dir, entry.name), relPath);
          } else if (/\.(md|mdx|txt|rst|adoc)$/i.test(entry.name)) {
            listed.push(`docs/${relPath}`);
          }
        }
      };
      walk(docsDir, '');
      if (listed.length > 0) {
        sources.push({
          origin: 'repo:docs/ listing',
          body: listed.map((f) => `- ${f}`).join('\n'),
        });
      }
    }
  } catch {
    // docs/ unreadable — skip.
  }

  return sources;
}

// ─── Step 1b: the KB (mempalace via kb-bridge), best-effort ───────────────────

async function searchKnowledgeBase(repoUrl: string | undefined): Promise<ContextSource[]> {
  if (!repoUrl) return [];
  const key = repoKey(repoUrl);
  try {
    // kb-bridge degrades to empty results when mempalace is not installed.
    const tags = ['repo-context', `repo:${key}`];
    const result = await kb.query(tags, `existing project context for ${key}`);
    if (!result || result.entries.length === 0) return [];
    const body = result.entries
      .slice(0, 10)
      .map((e, i) => {
        const tagLine = e.tags?.length ? ` (tags: ${e.tags.join(', ')})` : '';
        return `### KB entry ${i + 1}${tagLine}\n${e.content}`;
      })
      .join('\n\n');
    return [{ origin: 'kb:mempalace', body: truncate(body) }];
  } catch {
    // Any KB error ⇒ treat as "no KB context" (graceful degrade).
    return [];
  }
}

// ─── Step 1c: prior season memory referencing the same repo ───────────────────

function searchPriorSeasons(repoUrl: string | undefined, selfId: string): ContextSource[] {
  if (!repoUrl) return [];
  const key = repoKey(repoUrl);
  const sources: ContextSource[] = [];

  if (!fs.existsSync(SEASONS_DIR)) return sources;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(SEASONS_DIR, { withFileTypes: true });
  } catch {
    return sources;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === selfId) continue;
    const seasonJsonPath = path.join(SEASONS_DIR, entry.name, 'season.json');
    try {
      if (!fs.existsSync(seasonJsonPath)) continue;
      const data = JSON.parse(fs.readFileSync(seasonJsonPath, 'utf-8')) as Season;
      if (repoKey(data.sourceControl?.repoUrl) !== key) continue;

      // Prefer a prior context.md; else a one-line reference to the prior season.
      const priorContext = path.join(SEASONS_DIR, entry.name, 'context.md');
      if (fs.existsSync(priorContext)) {
        const body = fs.readFileSync(priorContext, 'utf-8').trim();
        if (body) {
          sources.push({
            origin: `prior-season:${data.name || entry.name} (${entry.name})`,
            body: truncate(body),
          });
          continue;
        }
      }
      sources.push({
        origin: `prior-season:${data.name || entry.name} (${entry.name})`,
        body: `A prior season worked this repo (status: ${data.status}, created ${data.createdAt}). No context.md was found in that season.`,
      });
    } catch {
      // Malformed prior season — skip.
    }
  }

  return sources;
}

// ─── Consolidation ────────────────────────────────────────────────────────────

/** Assemble the discovered sources into a single context.md body. */
function buildConsolidatedContext(
  season: Season,
  repoUrl: string | undefined,
  sources: ContextSource[],
): string {
  const header =
    `# Season context — ${season.name}\n\n` +
    `_Brownfield ingestion summary. Auto-generated at season spawn._\n\n` +
    `- Season: \`${season.id}\`\n` +
    `- Repository: \`${repoUrl ?? 'local'}\`\n` +
    `- Workspace: \`${season.workspacePath}\`\n` +
    `- Generated: ${new Date().toISOString()}\n` +
    `- Sources found: ${sources.map((s) => s.origin).join(', ') || 'none'}\n`;

  const bodies = sources
    .map((s) => `\n---\n\n## Source: ${s.origin}\n\n${s.body}\n`)
    .join('');

  return `${header}${bodies}\n`;
}

/** Write the consolidated context.md into the season dir, return its abs path. */
function writeSeasonContext(seasonId: string, body: string): string {
  const seasonDir = path.join(SEASONS_DIR, seasonId);
  fs.mkdirSync(seasonDir, { recursive: true });
  const contextPath = path.join(seasonDir, 'context.md');
  fs.writeFileSync(contextPath, body, 'utf-8');
  return contextPath;
}

/** Mirror the consolidated context to the KB, best-effort (never throws). */
async function mirrorContextToKb(
  season: Season,
  repoUrl: string | undefined,
  body: string,
): Promise<void> {
  try {
    await kb.write({
      content: body.slice(0, MAX_SOURCE_CHARS),
      tags: ['repo-context', `repo:${repoKey(repoUrl)}`, `season:${season.id}`],
      type: 'repo-context',
      metadata: {
        seasonId: season.id,
        repoUrl: repoUrl ?? null,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch {
    // KB unavailable — context.md on disk is the source of truth.
  }
}

// ─── Step 3: spawn the code-review / onboarding agent ──────────────────────────

/**
 * Cast a single reviewer agent (REVIEWER_ARCHETYPE) into the cloned workspace and
 * launch it with an onboarding/code-review prompt. Reuses the exact runtime path
 * the team uses (soul assembly → createAgent worktree → provider command → PTY).
 *
 * Returns the reviewer's agentId on success, or null if it could not be cast.
 */
async function spawnReviewAgent(
  season: Season,
  repoUrl: string | undefined,
  contextPath: string,
  deps: SeasonRuntimeDeps,
): Promise<string | null> {
  const seasonDir = path.join(SEASONS_DIR, season.id);
  const charactersDir = path.join(seasonDir, 'characters');

  let cfg;
  try {
    cfg = loadAgentConfig(REVIEWER_ARCHETYPE);
  } catch (err) {
    console.error(`repo-context: cannot load reviewer archetype "${REVIEWER_ARCHETYPE}":`, err);
    return null;
  }

  const slug = cfg.character;
  if (!slug) {
    console.error(`repo-context: reviewer archetype "${REVIEWER_ARCHETYPE}" has no character`);
    return null;
  }

  // Assemble the reviewer's soul into a season-owned copy (mirrors spawnSeason).
  let soulPackagePath: string | undefined;
  try {
    const sourceCharacterDir = resolveCharacterDir(season.theme, slug);
    const seasonCharacterDir = path.join(charactersDir, slug);
    fs.mkdirSync(seasonCharacterDir, { recursive: true });
    for (const soulFile of getSoulFiles(sourceCharacterDir)) {
      fs.copyFileSync(soulFile, path.join(seasonCharacterDir, path.basename(soulFile)));
    }
    const systemPromptPath = path.join(seasonCharacterDir, 'system-prompt.md');
    assembleSoulPromptFile(seasonCharacterDir, cfg.assemblyOrder, systemPromptPath);
    soulPackagePath = seasonCharacterDir;
  } catch (err) {
    // No soul package for the reviewer character — proceed without a soul file
    // rather than abort the review (the prompt still does the work).
    console.warn(`repo-context: reviewer soul unavailable for ${slug}:`, err);
    soulPackagePath = undefined;
  }

  let agent;
  try {
    agent = await createAgent(
      {
        name: slug,
        projectPath: season.workspacePath,
        worktree: { enabled: true, branchName: `season/${season.id}/onboarding-review` },
        model: mapCatalogModelToProviderModel(cfg.modelPrimary),
        skills: cfg.skills,
        // The reviewer needs to read freely + write docs; align with the season's
        // autonomy default for the archetype (auto when autonomous, else normal).
        permissionMode: cfg.autonomy === 'autonomous' ? 'auto' : 'normal',
        seasonId: season.id,
        archetypeId: REVIEWER_ARCHETYPE,
        canonName: slug,
        theme: season.theme,
        soulPackagePath,
      },
      deps.getAppSettings,
      deps.handleStatusChangeNotification,
    );
  } catch (err) {
    console.error(`repo-context: failed to cast reviewer for season ${season.id}:`, err);
    return null;
  }

  trustClaudeProjects([agent.worktreePath, agent.projectPath].filter(Boolean) as string[]);

  // Build + launch the review command through the provider (same as the team).
  try {
    const cliProvider = getProvider('claude');
    const binaryPath = cliProvider.resolveBinaryPath(deps.getAppSettings());

    let mcpConfigPath: string | undefined;
    if (cliProvider.getMcpConfigStrategy() === 'flag') {
      const possibleMcpPath = path.join(os.homedir(), '.claude', 'mcp.json');
      if (fs.existsSync(possibleMcpPath)) mcpConfigPath = possibleMcpPath;
    }

    if (!agent.ptyId) {
      agent.ptyId = await deps.initAgentPty(agent);
    }
    const { ptyProcesses } = require('./pty-manager') as typeof import('./pty-manager');
    const ptyProcess = ptyProcesses.get(agent.ptyId!);
    if (!ptyProcess) {
      console.warn(`repo-context: no PTY for reviewer ${agent.id}`);
      return agent.id;
    }

    const systemPromptFile = soulPackagePath
      ? path.join(soulPackagePath, 'system-prompt.md')
      : undefined;

    const prompt =
      `You are the onboarding reviewer for season "${season.name}", which is starting work on an ` +
      `EXISTING, in-flight project in this repository (${repoUrl ?? 'the linked repo'}).\n\n` +
      `No prior context was found for this codebase, so your job is a focused code review to build it:\n` +
      `1. Map the architecture: top-level layout, key modules/services, entry points, data flow, ` +
      `external dependencies, and the tech stack.\n` +
      `2. Assess the CURRENT STATE: what is implemented, what is in progress, obvious TODOs/FIXMEs, ` +
      `test coverage signals, and any risks or rough edges.\n` +
      `3. WRITE two files:\n` +
      `   - \`docs/CODEBASE_MAP.md\` in this repository — the durable architecture map.\n` +
      `   - \`${contextPath}\` — a concise season context summary the team will read first ` +
      `(architecture overview + current state + recommended starting points).\n\n` +
      `Keep it practical and skimmable. When both files are written, summarize what you found.`;

    const command = cliProvider.buildInteractiveCommand({
      binaryPath,
      prompt,
      model: agent.model,
      verbose: deps.getAppSettings().verboseModeEnabled,
      permissionMode: agent.permissionMode ?? 'normal',
      mcpConfigPath,
      systemPromptFile: systemPromptFile && fs.existsSync(systemPromptFile) ? systemPromptFile : undefined,
      skills: agent.skills,
    });

    const workingPath = (agent.worktreePath || agent.projectPath).replace(/'/g, "'\\''");
    const fullCommand = `cd '${workingPath}' && ${command}`;

    agent.status = 'running';
    agent.currentTask = 'Onboarding code review (brownfield context bootstrap)';
    agent.lastActivity = new Date().toISOString();
    broadcastToAllWindows('agent:status', {
      type: 'status',
      agentId: agent.id,
      status: 'running',
      timestamp: agent.lastActivity,
    });

    // Freshly-spawned PTY: give bash a moment before writing input.
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        writeProgrammaticInput(ptyProcess, fullCommand);
        resolve();
      }, 500);
    });

    deps.saveAgents();
    return agent.id;
  } catch (err) {
    console.error(`repo-context: failed to launch reviewer for season ${season.id}:`, err);
    return agent.id;
  }
}

/**
 * Watch for the reviewer to finish producing the season context.md, then flip the
 * season's context status to `ready`. We poll for the file (the reviewer writes
 * it from its worktree, but the prompt targets the absolute season path) and also
 * watch the reviewer agent's status. Bounded so a stalled review never leaks a
 * timer forever; on timeout we leave the status as-is (still `reviewing`) so the
 * UI reflects reality.
 */
function watchReviewCompletion(
  seasonId: string,
  reviewAgentId: string | null,
  contextPath: string,
): void {
  const POLL_MS = 5_000;
  const MAX_MS = 60 * 60 * 1000; // 1h ceiling on the watcher
  const startedAt = Date.now();

  const tick = () => {
    // Context file written ⇒ ready.
    if (fs.existsSync(contextPath)) {
      setContextStatus(seasonId, 'ready', contextPath);
      triggerBrownfieldGrooming(seasonId);
      return;
    }

    // Reviewer finished but produced no context.md ⇒ mark failed (best-effort).
    if (reviewAgentId) {
      const reviewer = agents.get(reviewAgentId);
      if (reviewer && (reviewer.status === 'completed' || reviewer.status === 'error')) {
        // Give the filesystem a beat in case the write is mid-flush.
        setTimeout(() => {
          if (fs.existsSync(contextPath)) {
            setContextStatus(seasonId, 'ready', contextPath);
            triggerBrownfieldGrooming(seasonId);
          } else {
            const finalStatus = reviewer.status === 'error' ? 'failed' : 'ready';
            setContextStatus(seasonId, finalStatus, contextPath);
            if (finalStatus === 'ready') triggerBrownfieldGrooming(seasonId);
          }
        }, 1_000);
        return;
      }
    }

    if (Date.now() - startedAt > MAX_MS) return; // stop watching; stays 'reviewing'
    setTimeout(tick, POLL_MS);
  };

  setTimeout(tick, POLL_MS);
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Bootstrap a season's starting context from its (already-cloned) repo.
 *
 * Call this from spawnSeason AFTER the repo is cloned and the season is
 * registered, but BEFORE/at team launch. Only meaningful for brownfield seasons
 * or any season with a real linked repo; callers should skip it for pure
 * greenfield (local) seasons.
 *
 * Never throws — every step degrades gracefully. Returns a {@link BootstrapResult}
 * the caller folds into the convener launch prompt.
 */
export async function bootstrapRepoContext(
  season: Season,
  deps: SeasonRuntimeDeps,
): Promise<BootstrapResult> {
  const repoUrl = season.sourceControl?.repoUrl;
  const contextPath = path.join(SEASONS_DIR, season.id, 'context.md');

  setContextStatus(season.id, 'searching');

  // ── Step 1: search existing context (repo docs → KB → prior seasons) ──
  const sources: ContextSource[] = [];
  try {
    sources.push(...searchRepoDocs(season.workspacePath));
  } catch (err) {
    console.warn(`repo-context: repo-doc search failed for season ${season.id}:`, err);
  }
  try {
    sources.push(...(await searchKnowledgeBase(repoUrl)));
  } catch (err) {
    console.warn(`repo-context: KB search failed for season ${season.id}:`, err);
  }
  try {
    sources.push(...searchPriorSeasons(repoUrl, season.id));
  } catch (err) {
    console.warn(`repo-context: prior-season search failed for season ${season.id}:`, err);
  }

  // ── Step 2: context found → consolidate + mark ready ──
  if (sources.length > 0) {
    const body = buildConsolidatedContext(season, repoUrl, sources);
    let written: string | undefined;
    try {
      written = writeSeasonContext(season.id, body);
    } catch (err) {
      console.error(`repo-context: failed to write context.md for season ${season.id}:`, err);
    }
    await mirrorContextToKb(season, repoUrl, body);
    setContextStatus(season.id, 'ready', written ?? contextPath);
    // Context is ready ⇒ have the PM review the repo + ask the user for direction.
    triggerBrownfieldGrooming(season.id);

    const originList = sources.map((s) => s.origin).join(', ');
    return {
      status: 'ready',
      contextPath: written ?? contextPath,
      reviewSpawned: false,
      summary:
        `Existing context was found and consolidated into ${written ?? contextPath} ` +
        `(sources: ${originList}). Read it first to ground yourself before assigning work.`,
    };
  }

  // ── Step 3: no context → kick off a code review to build it ──
  console.log(
    `repo-context: no existing context for season ${season.id} (${repoUrl ?? 'no repo'}); ` +
      `kicking off onboarding code review`,
  );
  setContextStatus(season.id, 'reviewing');
  const reviewAgentId = await spawnReviewAgent(season, repoUrl, contextPath, deps);

  if (!reviewAgentId) {
    // Could not cast the reviewer — degrade to failed but don't block the team.
    setContextStatus(season.id, 'failed');
    return {
      status: 'failed',
      reviewSpawned: false,
      summary:
        `No existing context was found and the onboarding reviewer could not be started. ` +
        `Begin by exploring the repository directly to understand its current state.`,
    };
  }

  watchReviewCompletion(season.id, reviewAgentId, contextPath);

  return {
    status: 'reviewing',
    contextPath,
    reviewSpawned: true,
    summary:
      `No prior context was found for this existing repository, so an onboarding code review is ` +
      `IN PROGRESS to map the architecture and current state. It will write docs/CODEBASE_MAP.md ` +
      `and a season summary at ${contextPath}. Coordinate light planning while it runs; wait for ` +
      `that context before committing the team to a direction.`,
  };
}
