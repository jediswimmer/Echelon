/**
 * git-pr.ts — Branch-per-Epic + PR-on-completion for season workspaces
 * (sub-feature 17e).
 *
 * Scott's requirement (verbatim): "creating a echelon-team-factory branch for
 * whatever EPIC/story that is to be worked on. When this EPIC/story/feature is
 * complete, it should be submitted for PR against main, gated by a human team
 * member (if a human hybrid dev team is present)."
 *
 * What this module does, with graceful degradation at every step:
 *
 *   1. BRANCH PER EPIC/STORY — when an epic/story is chosen to work on, create an
 *      `echelon-team-factory/<slug>` branch in the season workspace WITHOUT
 *      disturbing the working copy or the cast's agent worktrees (a bare
 *      `git branch <name> <base>`, never a checkout). Recorded on the epic/story
 *      kanban task ({@link KanbanTask.branch}).
 *
 *   2. PR ON COMPLETION — when ALL of an epic's descendant tasks reach `done`,
 *      the branch has commits ahead of the base, AND the repo is a GitHub repo
 *      with `gh` available + authed, open a PR `echelon-team-factory/<slug>` →
 *      the repo's default branch. Never auto-merges (merging to main is the
 *      human's call / #22's gate). Degrades with a logged reason for
 *      local-only / Azure-DevOps repos, a missing `gh`, or zero commits ahead.
 *
 *   3. HUMAN-APPROVAL GATE (seam for #22) — {@link evaluateReviewGate} returns
 *      `auto-approved` while no human team is configured (always, for now) and
 *      reserves `pending-human` for when #22 populates `season.humanTeam.seats`.
 *
 * Security: EVERY git/gh invocation uses `execFile` with an args array (NO
 * shell), so branch names / titles / paths are never interpolated into a shell
 * string — mirroring `git-validate.ts` / `cloneWorkspaceFromRepo`. PATH is
 * resolved via {@link buildFullPath} (plus any user-configured CLI dirs) so
 * `git`/`gh` are found even when the app launched without a login-shell PATH.
 * Network-touching calls run with GIT_TERMINAL_PROMPT=0 and bounded timeouts so a
 * credential prompt or a dead network can never hang.
 *
 * Resilience contract: NOTHING here throws into a kanban handler or the season
 * direction flow. Failures log (console + a best-effort `system` conversation
 * entry) and return a safe value (undefined / 0 / false).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { APP_SETTINGS_FILE } from '../constants';
import { buildFullPath } from '../utils/path-builder';
// NOTE: kanban-handlers ⇄ git-pr is a deliberate runtime-safe circular import
// (same pattern jira-sync uses). These bindings are only ever CALLED inside
// function bodies, never at module-eval scope, so both modules are fully
// initialized by the time any of them runs.
import { loadTasks, saveTasks, emitTaskEvent } from '../handlers/kanban-handlers';
import type { KanbanTask } from '../handlers/kanban-handlers';
import { getSeason } from '../core/season-manager';
import { appendConversationEntry } from '../core/conversation-log';
import type { Season } from '../types/echelon';

const execFileAsync = promisify(execFile);

/**
 * Epics with completion currently in flight — a synchronous guard so two
 * concurrent done-moves to the SAME epic don't both push + open a PR.
 */
const epicCompletionInFlight = new Set<string>();

/** Prefix for every team-factory epic/story branch. */
export const BRANCH_PREFIX = 'echelon-team-factory/';

/** Timeout (ms) for local-only git operations (branch/rev-list/symbolic-ref). */
const LOCAL_GIT_TIMEOUT_MS = 15_000;
/** Timeout (ms) for network-touching operations (push, gh pr create). */
const NETWORK_TIMEOUT_MS = 120_000;

/** Human-approval gate status recorded on a completed epic/story task. */
export type ReviewGate = 'pending-human' | 'auto-approved' | 'approved';

// ─── PATH / env helpers (mirror git-validate.ts) ──────────────────────────────

/**
 * Read the user-configured CLI paths from the app settings file so child git/gh
 * invocations find the binaries even when the app launched without a login-shell
 * PATH. Best-effort: a missing/unreadable settings file yields no extra paths.
 */
function readCliExtraPaths(): { extraPaths: string[]; ghBinary: string } {
  const extraPaths: string[] = [];
  let ghBinary = 'gh';
  try {
    if (fs.existsSync(APP_SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf-8'));
      const cliPaths = settings?.cliPaths;
      if (cliPaths) {
        for (const key of ['gh', 'node'] as const) {
          const p = cliPaths[key];
          if (p) extraPaths.push(path.dirname(p));
        }
        if (Array.isArray(cliPaths.additionalPaths)) {
          extraPaths.push(...cliPaths.additionalPaths.filter(Boolean));
        }
        if (cliPaths.gh) ghBinary = cliPaths.gh;
      }
    }
  } catch {
    // Fall through to the defaults — buildFullPath still adds sensible dirs.
  }
  return { extraPaths, ghBinary };
}

/** Build the child-process env: resolved PATH + non-interactive git. */
function buildEnv(): NodeJS.ProcessEnv {
  const { extraPaths } = readCliExtraPaths();
  return {
    ...process.env,
    PATH: buildFullPath(extraPaths),
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Run a git command against the workspace (execFile, no shell). */
async function git(
  workspacePath: string,
  args: string[],
  timeout = LOCAL_GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('git', ['-C', workspacePath, ...args], {
    env: buildEnv(),
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

/** Log a `system` conversation entry for the season (best-effort, never throws). */
function logSystem(seasonId: string, text: string): void {
  try {
    appendConversationEntry(seasonId, {
      agentId: 'system',
      canonName: 'Release',
      kind: 'system',
      text,
    });
  } catch {
    // Logging must never break the release flow.
  }
}

// ─── slug / default-branch / branch creation ──────────────────────────────────

/**
 * Turn a title into a safe branch segment: lowercased, `[a-z0-9-]` only,
 * collapsed dashes, bounded length. Falls back to `epic` when nothing survives,
 * so the result is always a valid, non-empty branch segment.
 */
export function slugify(title: string): string {
  const slug = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'epic';
}

/** The full `echelon-team-factory/<slug>` branch name for a title. */
export function branchNameFor(title: string): string {
  return `${BRANCH_PREFIX}${slugify(title)}`;
}

/**
 * Detect the repo's default branch:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` → strip `refs/remotes/origin/`.
 *   2. fall back to whichever of `main` / `master` exists as a local branch.
 *   3. final fallback: `main`.
 * Never throws — always returns a usable branch name.
 */
export async function defaultBranch(workspacePath: string): Promise<string> {
  try {
    const { stdout } = await git(workspacePath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const ref = stdout.trim(); // e.g. "refs/remotes/origin/main"
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name && name !== ref) return name;
  } catch {
    // No origin/HEAD symbolic ref — fall through to local-branch detection.
  }

  for (const candidate of ['main', 'master']) {
    try {
      await git(workspacePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      // Not present — try the next candidate.
    }
  }
  return 'main';
}

/**
 * Create the `echelon-team-factory/<slug>` branch for an epic/story WITHOUT
 * disturbing the working copy or any agent worktree: a bare
 * `git branch <branch> <defaultBranch>`, never a checkout. If the branch already
 * exists, it is reused (returned as-is). Resilient — returns `undefined` on any
 * failure (logged), never throws.
 *
 * @returns the branch name on success, or `undefined` if it could not be created.
 */
export async function createEpicBranch(
  workspacePath: string,
  title: string,
): Promise<string | undefined> {
  const branch = branchNameFor(title);
  try {
    // Already exists? Reuse it (idempotent) — don't error on a re-run.
    try {
      await git(workspacePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return branch;
    } catch {
      // Doesn't exist yet — create it below.
    }

    const base = await defaultBranch(workspacePath);
    // `git branch <new> <base>` creates the ref without touching HEAD / the
    // working tree / any worktree. If <base> is missing, fall back to HEAD.
    try {
      await git(workspacePath, ['branch', branch, base]);
    } catch {
      // Base ref unresolved (e.g. a bare init with an odd default) — branch from
      // current HEAD instead so we still record a usable branch.
      await git(workspacePath, ['branch', branch]);
    }
    return branch;
  } catch (err) {
    console.error(`git-pr: createEpicBranch failed for "${title}" in ${workspacePath}:`, err);
    return undefined;
  }
}

/**
 * Count commits on `branch` that are not on `base`
 * (`git rev-list --count <base>..<branch>`). Returns 0 on any error (including a
 * missing branch/base), so a no-commits state and an error both correctly gate
 * out an empty PR.
 */
export async function commitsAhead(
  workspacePath: string,
  branch: string,
  base: string,
): Promise<number> {
  try {
    const { stdout } = await git(workspacePath, ['rev-list', '--count', `${base}..${branch}`]);
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (err) {
    console.warn(`git-pr: commitsAhead(${base}..${branch}) failed in ${workspacePath}:`, err);
    return 0;
  }
}

// ─── gh availability + GitHub detection ───────────────────────────────────────

/** Cached result of {@link ghAvailable} (resolved once per process). */
let ghAvailableCache: boolean | undefined;

/**
 * Whether the `gh` CLI is available (resolves `gh --version`). Cached for the
 * process lifetime. Never throws — `false` on ENOENT / any spawn failure.
 */
export async function ghAvailable(): Promise<boolean> {
  // Cache only the positive result (gh won't vanish mid-session); a negative is
  // re-probed each call so installing gh mid-session is picked up without a restart.
  if (ghAvailableCache === true) return true;
  const { ghBinary } = readCliExtraPaths();
  try {
    await execFileAsync(ghBinary, ['--version'], {
      env: buildEnv(),
      timeout: LOCAL_GIT_TIMEOUT_MS,
      maxBuffer: 1 * 1024 * 1024,
    });
    ghAvailableCache = true;
  } catch {
    ghAvailableCache = false;
  }
  return ghAvailableCache === true;
}

/**
 * Whether the season's repo is hosted on GitHub: the source-control type is
 * `github`, OR a `repoUrl` whose host is github.com. (Local-clone seasons that
 * happen to point at a GitHub remote are NOT treated as GitHub here — the
 * source-control type is the contract; this keeps PR behavior predictable.)
 */
export function isGitHub(season: Season): boolean {
  const sc = season.sourceControl;
  if (!sc) return false;
  if (sc.type === 'github') return true;
  const repoUrl = sc.repoUrl?.trim();
  if (!repoUrl) return false;
  return /(^|@|\/\/)github\.com[/:]/i.test(repoUrl);
}

// ─── #22 human-approval gate seam ─────────────────────────────────────────────

/**
 * Evaluate the human-approval review gate for a completed epic/story.
 *
 * Pure, no side effects. Returns `pending-human` when the season has a human
 * team configured (#22 will populate `season.humanTeam.seats`); otherwise
 * `auto-approved`. (`approved` is reserved for when a human later signs off.)
 *
 * This is the seam #22 plugs into: today there is never a human team, so this
 * always returns `auto-approved`.
 */
export function evaluateReviewGate(season: Season, _epicTask: KanbanTask): ReviewGate {
  const seats = season.humanTeam?.seats;
  if (Array.isArray(seats) && seats.length > 0) return 'pending-human';
  return 'auto-approved';
}

// ─── PR open ──────────────────────────────────────────────────────────────────

/**
 * Open a GitHub PR for a completed epic's branch → the repo's default branch.
 *
 * Guards (all must hold, else this no-ops gracefully with a logged reason):
 *   • the repo is a GitHub repo (`isGitHub`),
 *   • `gh` is available + authed,
 *   • the epic task has a `branch`,
 *   • that branch has > 0 commits ahead of the default branch (no empty PRs).
 *
 * On success it pushes the branch (`git push -u origin <branch>`) and runs
 * `gh pr create --head <branch> --base <default> --title <title> --body <body>`,
 * then resolves the PR url/number. NEVER auto-merges. Resilient — ANY failure
 * (no gh, push denied, PR already exists, …) logs a system entry and returns
 * `undefined`; it never throws.
 *
 * @returns `{ url, number }` on success, or `undefined` when skipped/failed.
 */
export async function openEpicPR(
  season: Season,
  epicTask: KanbanTask,
): Promise<{ url: string; number?: number } | undefined> {
  const seasonId = season.id;
  const workspacePath = season.workspacePath;
  const branch = epicTask.branch;

  // ── Guard: GitHub-hosted repo ──
  if (!isGitHub(season)) {
    const repoType = season.sourceControl?.type ?? 'local';
    logSystem(
      seasonId,
      `Epic "${epicTask.title}" is complete, but no PR was opened: this season's workspace is "${repoType}", not a GitHub repo. Review and merge the "${branch ?? 'work'}" branch in your tooling.`,
    );
    return undefined;
  }

  // ── Guard: branch recorded ──
  if (!branch) {
    logSystem(
      seasonId,
      `Epic "${epicTask.title}" is complete, but no PR was opened: no team-factory branch was recorded for it.`,
    );
    return undefined;
  }

  // ── Guard: gh available ──
  if (!(await ghAvailable())) {
    logSystem(
      seasonId,
      `Epic "${epicTask.title}" is complete, but no PR was opened: the GitHub CLI (gh) is not available. Install + authenticate gh, or open the PR for "${branch}" manually.`,
    );
    return undefined;
  }

  // ── Guard: commits ahead (no empty PRs) ──
  const base = await defaultBranch(workspacePath);
  const ahead = await commitsAhead(workspacePath, branch, base);
  if (ahead === 0) {
    logSystem(
      seasonId,
      `Epic "${epicTask.title}" is complete, but no PR was opened: branch "${branch}" has no commits ahead of "${base}" (nothing to review).`,
    );
    return undefined;
  }

  const { ghBinary } = readCliExtraPaths();
  const env = buildEnv();

  // ── Push the branch (set upstream) ──
  try {
    await git(workspacePath, ['push', '-u', 'origin', branch], NETWORK_TIMEOUT_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`git-pr: push failed for ${branch} (season ${seasonId}):`, err);
    logSystem(
      seasonId,
      `Epic "${epicTask.title}" is complete, but pushing branch "${branch}" failed: ${message.slice(0, 200)}. The PR was not opened.`,
    );
    return undefined;
  }

  // ── Open the PR (never merge) ──
  const title = epicTask.title;
  const body =
    `Automated PR opened by Echelon for completed epic **${epicTask.title}**.\n\n` +
    (epicTask.description ? `${epicTask.description}\n\n` : '') +
    `- Branch: \`${branch}\`\n` +
    `- Base: \`${base}\`\n` +
    `- Commits ahead: ${ahead}\n\n` +
    `All tasks under this epic are done. This PR is awaiting human review — Echelon never merges to ${base} automatically.`;

  try {
    const { stdout } = await execFileAsync(
      ghBinary,
      [
        'pr',
        'create',
        '--repo',
        ghRepoArg(season),
        '--base',
        base,
        '--head',
        branch,
        '--title',
        title,
        '--body',
        body,
      ],
      { env, cwd: workspacePath, timeout: NETWORK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    // `gh pr create` prints the PR URL on the last non-empty stdout line.
    const url = lastUrl(String(stdout));
    if (!url) {
      // PR likely created but URL unparsed — try to resolve it via `gh pr view`.
      const resolved = await resolvePrViaView(ghBinary, env, workspacePath, branch);
      if (resolved) {
        logSystem(
          seasonId,
          `Epic "${epicTask.title}" complete → PR opened: ${resolved.url} (gate: ${epicTask.reviewGate ?? 'auto-approved'}). Awaiting human review.`,
        );
        return resolved;
      }
      logSystem(
        seasonId,
        `Epic "${epicTask.title}" complete → a PR was created for "${branch}" but its URL could not be parsed. Check GitHub.`,
      );
      return undefined;
    }
    const number = parsePrNumber(url);
    logSystem(
      seasonId,
      `Epic "${epicTask.title}" complete → PR opened: ${url} (gate: ${epicTask.reviewGate ?? 'auto-approved'}). Awaiting human review — Echelon never merges to ${base} automatically.`,
    );
    return { url, number };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`git-pr: gh pr create failed for ${branch} (season ${seasonId}):`, err);
    // A common, benign case: a PR already exists for this head. Try to resolve it
    // so we still record the URL instead of treating it as a hard failure.
    const resolved = await resolvePrViaView(ghBinary, env, workspacePath, branch);
    if (resolved) {
      logSystem(
        seasonId,
        `Epic "${epicTask.title}" complete → an open PR already exists: ${resolved.url}. Awaiting human review.`,
      );
      return resolved;
    }
    logSystem(
      seasonId,
      `Epic "${epicTask.title}" is complete, but opening the PR for "${branch}" failed: ${message.slice(0, 200)}.`,
    );
    return undefined;
  }
}

/** The `--repo` argument for gh: `owner/repo` or full URL when known, else "." */
function ghRepoArg(season: Season): string {
  const repoUrl = season.sourceControl?.repoUrl?.trim();
  if (repoUrl) {
    // Normalize https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git)
    // to the `owner/repo` slug gh expects; pass through anything already in that form.
    const m = repoUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (m) return m[1];
    return repoUrl;
  }
  // Fall back to the workspace's git context (gh infers owner/repo from origin).
  return '.';
}

/** Extract the last http(s) URL token from gh stdout (the PR URL). */
function lastUrl(stdout: string): string | undefined {
  const matches = stdout.match(/https?:\/\/\S+/g);
  if (!matches || matches.length === 0) return undefined;
  return matches[matches.length - 1].trim();
}

/** Parse the trailing PR number out of a GitHub PR URL (…/pull/123). */
function parsePrNumber(url: string): number | undefined {
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve an existing PR for `branch` via `gh pr view <branch> --json url,number`.
 * Best-effort; returns undefined on any failure.
 */
async function resolvePrViaView(
  ghBinary: string,
  env: NodeJS.ProcessEnv,
  workspacePath: string,
  branch: string,
): Promise<{ url: string; number?: number } | undefined> {
  try {
    const { stdout } = await execFileAsync(
      ghBinary,
      ['pr', 'view', branch, '--json', 'url,number'],
      { env, cwd: workspacePath, timeout: NETWORK_TIMEOUT_MS, maxBuffer: 1 * 1024 * 1024 },
    );
    const parsed = JSON.parse(String(stdout)) as { url?: string; number?: number };
    if (parsed?.url) {
      return { url: parsed.url, number: typeof parsed.number === 'number' ? parsed.number : undefined };
    }
  } catch {
    // No resolvable PR — caller handles the undefined.
  }
  return undefined;
}

// ─── Epic-completion orchestration ────────────────────────────────────────────

/**
 * Walk a task's `parentId` chain to the top-most ancestor (the epic, normally).
 * Defensive against cycles via a bounded hop count + a visited set.
 */
function findTopEpic(taskId: string, tasks: KanbanTask[]): KanbanTask | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let current = byId.get(taskId);
  if (!current) return undefined;
  const visited = new Set<string>();
  let hops = 0;
  while (current.parentId && byId.has(current.parentId) && !visited.has(current.id) && hops < 50) {
    visited.add(current.id);
    current = byId.get(current.parentId)!;
    hops++;
  }
  return current;
}

/** All descendant `task`-type issues under an epic/story (recursive). */
function descendantLeafTasks(epicId: string, tasks: KanbanTask[]): KanbanTask[] {
  const children = new Map<string, KanbanTask[]>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const list = children.get(t.parentId) ?? [];
    list.push(t);
    children.set(t.parentId, list);
  }
  const out: KanbanTask[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of children.get(id) ?? []) {
      // A 'task' (or a missing issueType, treated as task) is a leaf unit of work.
      const type = child.issueType ?? 'task';
      if (type === 'task') {
        out.push(child);
      } else if (type === 'story') {
        // A story with no child tasks of its own is itself a leaf deliverable —
        // otherwise its 'ongoing' state would be ignored when gating completion.
        const hasChildTasks = (children.get(child.id) ?? []).some(
          (g) => (g.issueType ?? 'task') === 'task',
        );
        if (!hasChildTasks) out.push(child);
      }
      walk(child.id);
    }
  };
  walk(epicId);
  return out;
}

/**
 * Completion orchestration. Called fire-and-forget when a task moves to `done`.
 *
 * Finds the top epic the done-task belongs to; if ALL of that epic's descendant
 * tasks are `done` and the epic has no `prUrl` yet, it:
 *   1. ensures the epic has a team-factory branch (creates one lazily if absent),
 *   2. evaluates the #22 review gate ({@link evaluateReviewGate}),
 *   3. opens a PR via {@link openEpicPR} (graceful skip when not GitHub / no gh /
 *      zero commits ahead — never merges),
 *   4. records `branch` / `reviewGate` / `prUrl` / `prNumber` / `prState` on the
 *      epic task and broadcasts the update.
 *
 * Idempotent (the `prUrl`-absent guard prevents duplicate PRs) and resilient
 * (never throws). No-op when the done-task is itself an epic with no children,
 * or when the epic still has unfinished descendants.
 */
export async function tryCompleteEpic(seasonId: string, doneTaskId: string): Promise<void> {
  try {
    const season = getSeason(seasonId);
    if (!season) return;

    let tasks = loadTasks();
    const seasonTasks = tasks.filter((t) => t.seasonId === seasonId);

    const epic = findTopEpic(doneTaskId, seasonTasks);
    if (!epic) return;
    // Only epics/stories carry release state; a lone top-level task is not an epic.
    const epicType = epic.issueType ?? 'task';
    if (epicType !== 'epic' && epicType !== 'story') return;

    // Idempotency: a PR already opened ⇒ nothing to do.
    if (epic.prUrl) return;

    // All descendant leaf tasks must be done. If there are NO descendant tasks
    // (bare brownfield epic/story), gate on the epic itself being done.
    const leaves = descendantLeafTasks(epic.id, seasonTasks);
    const allDone =
      leaves.length > 0
        ? leaves.every((t) => t.column === 'done')
        : epic.column === 'done';
    if (!allDone) return;

    // Synchronous in-flight guard so two concurrent done-moves to the same epic
    // don't both push + open a PR (the post-await prUrl re-check below is the
    // second line of defense for the persisted record).
    const guardKey = `${seasonId}::${epic.id}`;
    if (epicCompletionInFlight.has(guardKey)) return;
    epicCompletionInFlight.add(guardKey);
    try {
      // ── Ensure a branch (lazy create if the eager path in 17c didn't run) ──
      let branch = epic.branch;
      if (!branch) {
        branch = await createEpicBranch(season.workspacePath, epic.title);
      }

      // ── Evaluate the #22 human-approval gate ──
      const reviewGate = evaluateReviewGate(season, epic);

      // ── Open the PR (graceful skip handled inside openEpicPR) ──
      const epicForPr: KanbanTask = { ...epic, branch, reviewGate };
      const pr = await openEpicPR(season, epicForPr);

      // ── Persist the release state on the epic task ──
      // Re-load to avoid clobbering concurrent edits; re-check the PR guard.
      tasks = loadTasks();
      const idx = tasks.findIndex((t) => t.id === epic.id);
      if (idx === -1) return;
      const live = tasks[idx];
      if (live.prUrl) return; // raced with another completion — keep the first PR.

      if (branch) live.branch = branch;
      live.reviewGate = reviewGate;
      if (pr) {
        live.prUrl = pr.url;
        if (typeof pr.number === 'number') live.prNumber = pr.number;
        live.prState = 'open';
      }
      live.updatedAt = new Date().toISOString();
      saveTasks(tasks);
      emitTaskEvent('kanban:task-updated', live);
    } finally {
      epicCompletionInFlight.delete(guardKey);
    }
  } catch (err) {
    console.error(`git-pr: tryCompleteEpic failed for season ${seasonId} / task ${doneTaskId}:`, err);
  }
}

/** Result returned to the UI by {@link forceOpenEpicPR}. */
export interface OpenPrResult {
  /** True when a PR url was recorded (newly opened or already existing). */
  opened: boolean;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  reviewGate?: ReviewGate;
  /** Set when no PR was opened — a human-readable skip/failure reason. */
  reason?: string;
}

/**
 * Manually open (or resolve) the team-factory PR for a specific epic/story,
 * triggered from the UI ("Open PR"). Unlike {@link tryCompleteEpic} it does NOT
 * require every descendant task to be done — the user is explicitly asking — but
 * it still:
 *   • ensures a branch (lazy-creates one if absent),
 *   • evaluates the #22 review gate,
 *   • opens the PR via {@link openEpicPR} (same GitHub/gh/commits-ahead guards,
 *     never merges), and
 *   • persists branch/gate/prUrl/prNumber/prState on the epic task.
 * Idempotent (an existing `prUrl` short-circuits) and resilient (never throws).
 */
export async function forceOpenEpicPR(seasonId: string, epicTaskId: string): Promise<OpenPrResult> {
  try {
    const season = getSeason(seasonId);
    if (!season) return { opened: false, reason: 'Season not found.' };

    let tasks = loadTasks();
    let idx = tasks.findIndex((t) => t.id === epicTaskId && t.seasonId === seasonId);
    if (idx === -1) return { opened: false, reason: 'Epic/story not found in this season.' };

    const epic = tasks[idx];
    const epicType = epic.issueType ?? 'task';
    if (epicType !== 'epic' && epicType !== 'story') {
      return { opened: false, reason: 'Only epics and stories can have a PR.' };
    }

    // Already has a PR ⇒ return it (idempotent, no duplicate).
    if (epic.prUrl) {
      return {
        opened: true,
        prUrl: epic.prUrl,
        prNumber: epic.prNumber,
        branch: epic.branch,
        reviewGate: epic.reviewGate,
      };
    }

    // Ensure a branch.
    let branch = epic.branch;
    if (!branch) {
      branch = await createEpicBranch(season.workspacePath, epic.title);
    }

    const reviewGate = evaluateReviewGate(season, epic);
    const pr = await openEpicPR(season, { ...epic, branch, reviewGate });

    // Persist (re-load + re-check the guard for raced completions).
    tasks = loadTasks();
    idx = tasks.findIndex((t) => t.id === epicTaskId);
    if (idx === -1) return { opened: false, reason: 'Epic/story disappeared while opening the PR.' };
    const live = tasks[idx];
    if (live.prUrl) {
      return { opened: true, prUrl: live.prUrl, prNumber: live.prNumber, branch: live.branch, reviewGate: live.reviewGate };
    }
    if (branch) live.branch = branch;
    live.reviewGate = reviewGate;
    if (pr) {
      live.prUrl = pr.url;
      if (typeof pr.number === 'number') live.prNumber = pr.number;
      live.prState = 'open';
    }
    live.updatedAt = new Date().toISOString();
    saveTasks(tasks);
    emitTaskEvent('kanban:task-updated', live);

    if (pr) {
      return { opened: true, prUrl: pr.url, prNumber: pr.number, branch, reviewGate };
    }
    // openEpicPR logged the specific skip reason; surface a generic one to the UI.
    return {
      opened: false,
      branch,
      reviewGate,
      reason: 'No PR was opened — see the conversation log for the reason (e.g. not a GitHub repo, gh unavailable, or no commits to review).',
    };
  } catch (err) {
    console.error(`git-pr: forceOpenEpicPR failed for season ${seasonId} / epic ${epicTaskId}:`, err);
    return { opened: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
