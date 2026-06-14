/**
 * grooming.ts — Season backlog grooming + brownfield direction (sub-feature 17c).
 *
 * At season kickoff the PM/convener auto-generates the starting backlog so the
 * team "self-drives":
 *
 *   • GREENFIELD (a PRD is in hand): one PM one-shot turns the PRD into an
 *     Epic → Story → Task hierarchy, seeded into the season's kanban board
 *     (reusing 17a's `issueType` + `parentId` + `seasonId` model).
 *
 *   • BROWNFIELD (existing repo, context bootstrapped by #20): the PM reviews the
 *     git history (recent commits + branches) and the consolidated `context.md`,
 *     proposes candidate Epics/Stories, seeds them as kanban epics/stories, and
 *     raises a `directionRequest` on the season asking the user which to tackle
 *     first. It does NOT auto-start work — it waits for the user's answer.
 *
 * Both paths are resilient: any model/parse failure logs a `system` conversation
 * entry and returns; nothing throws into the spawn path. The git review uses
 * `execFile` with an args array (no shell) so the workspace path is never
 * interpolated into a shell string.
 *
 * Out of scope here (17d/17e): two-way Jira sync and git branch-per-epic/PRs.
 * We use git history + context.md only and leave Jira ticket review to fold in
 * with 17d.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { invokeModel } from './model-invoke';
import { createTask, loadTasks } from '../handlers/kanban-handlers';
import { appendConversationEntry } from './conversation-log';
import { getSeason, saveSeason, broadcastSeasonUpdated } from './season-manager';
import type { SeasonDirectionOption } from '../types/echelon';

const execFileAsync = promisify(execFile);

/** Optional grooming context (e.g. an explicit model for the PM one-shot). */
export interface GroomingContext {
  /** Provider model id for the one-shot; defaults to the provider default. */
  model?: string;
}

/** Hard cap on the number of created tasks to keep a runaway model in check. */
const MAX_EPICS = 12;
const MAX_STORIES_PER_EPIC = 12;
const MAX_TASKS_PER_STORY = 20;
const MAX_CANDIDATES = 6;

/**
 * Seasons with grooming currently in flight — a synchronous guard closing the
 * async window between the `groomedAt` check and its (post-model) write, so
 * concurrent kickoff hooks (e.g. multiple #20 `ready` transitions, or a
 * double-spawn) can't both pass the guard and seed duplicate epics.
 */
const groomingInFlight = new Set<string>();

/** Run `fn` for a season at most once concurrently (in-flight de-dupe). */
async function onceInFlight(seasonId: string, fn: () => Promise<void>): Promise<void> {
  if (groomingInFlight.has(seasonId)) return;
  groomingInFlight.add(seasonId);
  try {
    await fn();
  } finally {
    groomingInFlight.delete(seasonId);
  }
}

/** True if this season already owns any kanban task (grooming has effectively run). */
function seasonHasTasks(seasonId: string): boolean {
  try {
    return loadTasks().some(t => t.seasonId === seasonId);
  } catch {
    return false;
  }
}

/** Log a `system` conversation entry for the season (best-effort, never throws). */
function logSystem(seasonId: string, text: string): void {
  try {
    appendConversationEntry(seasonId, { agentId: 'system', canonName: 'PM', kind: 'system', text });
  } catch {
    // Logging must never break grooming.
  }
}

/** Coerce an unknown value to a trimmed non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t || undefined;
}

/** Coerce a model-provided priority to a valid kanban priority. */
function priority(v: unknown): 'low' | 'medium' | 'high' {
  return v === 'low' || v === 'high' ? v : 'medium';
}

/** Coerce a model-provided labels value to a clean string[]. */
function labels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter((s): s is string => Boolean(s)).slice(0, 8);
}

// ─── Greenfield: PRD → Epic/Story/Task hierarchy ──────────────────────────────

interface GroomedTask {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  labels?: unknown;
}
interface GroomedStory {
  title?: unknown;
  description?: unknown;
  tasks?: unknown;
}
interface GroomedEpic {
  title?: unknown;
  description?: unknown;
  stories?: unknown;
}

/**
 * Greenfield grooming: turn the season's PRD into an Epic → Story → Task
 * hierarchy on the season's kanban board. Guarded to run once (season.groomedAt
 * OR the season already has tasks). Never throws into the spawn path.
 */
export function groomBacklogFromPRD(
  seasonId: string,
  prd: string,
  ctx?: GroomingContext,
): Promise<void> {
  return onceInFlight(seasonId, () => groomBacklogFromPRDImpl(seasonId, prd, ctx));
}

async function groomBacklogFromPRDImpl(
  seasonId: string,
  prd: string,
  ctx?: GroomingContext,
): Promise<void> {
  const season = getSeason(seasonId);
  if (!season) return;
  if (season.groomedAt) return;
  if (seasonHasTasks(seasonId)) return;
  if (!prd || !prd.trim()) return;

  const prompt =
    `You are the project manager for a software team. Turn the following product brief / PRD ` +
    `into a concrete starting backlog as a strict JSON object.\n\n` +
    `Respond with ONLY this JSON shape (no prose, no markdown fences):\n` +
    `{\n` +
    `  "epics": [\n` +
    `    {\n` +
    `      "title": "string",\n` +
    `      "description": "string",\n` +
    `      "stories": [\n` +
    `        {\n` +
    `          "title": "string",\n` +
    `          "description": "string",\n` +
    `          "tasks": [\n` +
    `            { "title": "string", "description": "string", "priority": "low|medium|high", "labels": ["string"] }\n` +
    `          ]\n` +
    `        }\n` +
    `      ]\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `Aim for 2-5 epics, each with a few stories, each with a few concrete, actionable tasks. ` +
    `Keep titles short and imperative. Here is the PRD:\n\n---\n${prd}\n---`;

  let json: Record<string, unknown> | null;
  try {
    const result = await invokeModel({ prompt, model: ctx?.model });
    json = result.json;
  } catch (err) {
    console.error(`grooming: PRD one-shot failed for season ${seasonId}:`, err);
    logSystem(seasonId, 'PM grooming failed: the backlog generation model call errored. The team can still plan manually.');
    return;
  }

  const epics = json && Array.isArray((json as { epics?: unknown }).epics)
    ? ((json as { epics: unknown[] }).epics as GroomedEpic[])
    : null;
  if (!epics) {
    logSystem(seasonId, 'PM grooming failed to parse the PRD into a backlog. The team can still plan manually.');
    return;
  }

  const projectPath = season.workspacePath;
  let epicCount = 0;
  let storyCount = 0;
  let taskCount = 0;

  for (const epic of epics.slice(0, MAX_EPICS)) {
    const epicTitle = str(epic.title);
    if (!epicTitle) continue;
    const epicTask = createTask({
      title: epicTitle,
      description: str(epic.description) || '',
      projectId: projectPath,
      projectPath,
      seasonId,
      issueType: 'epic',
    });
    epicCount++;

    const stories = Array.isArray(epic.stories) ? (epic.stories as GroomedStory[]) : [];
    for (const story of stories.slice(0, MAX_STORIES_PER_EPIC)) {
      const storyTitle = str(story.title);
      if (!storyTitle) continue;
      const storyTask = createTask({
        title: storyTitle,
        description: str(story.description) || '',
        projectId: projectPath,
        projectPath,
        seasonId,
        issueType: 'story',
        parentId: epicTask.id,
      });
      storyCount++;

      const tasks = Array.isArray(story.tasks) ? (story.tasks as GroomedTask[]) : [];
      for (const t of tasks.slice(0, MAX_TASKS_PER_STORY)) {
        const taskTitle = str(t.title);
        if (!taskTitle) continue;
        createTask({
          title: taskTitle,
          description: str(t.description) || '',
          projectId: projectPath,
          projectPath,
          seasonId,
          issueType: 'task',
          parentId: storyTask.id,
          priority: priority(t.priority),
          labels: labels(t.labels),
        });
        taskCount++;
      }
    }
  }

  if (epicCount === 0 && storyCount === 0 && taskCount === 0) {
    logSystem(seasonId, 'PM grooming produced no usable backlog items from the PRD. The team can still plan manually.');
    return;
  }

  logSystem(
    seasonId,
    `PM groomed ${epicCount} epic${epicCount === 1 ? '' : 's'} / ${storyCount} stor${storyCount === 1 ? 'y' : 'ies'} / ${taskCount} task${taskCount === 1 ? '' : 's'} from the PRD.`,
  );

  season.groomedAt = new Date().toISOString();
  saveSeason(seasonId);
  broadcastSeasonUpdated(seasonId);
}

// ─── Brownfield: repo review → candidate epics + a direction request ──────────

interface GroomedCandidate {
  title?: unknown;
  kind?: unknown;
  rationale?: unknown;
}

/**
 * Run a git command (log/branch) against the workspace via execFile (no shell).
 * Returns trimmed stdout, or '' on any failure (a stale/odd repo must not break
 * the review).
 */
async function gitOutput(workspacePath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspacePath, ...args], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  } catch (err) {
    console.warn(`grooming: git ${args.join(' ')} failed for ${workspacePath}:`, err);
    return '';
  }
}

/**
 * Brownfield grooming: review the repo (recent commits + branches) and the
 * consolidated `context.md` (from #20), propose 3-6 candidate Epics/Stories,
 * seed them as kanban epics/stories, and raise a `directionRequest` on the season
 * asking the user which to tackle first. Does NOT auto-start work. Guarded to run
 * once (season.groomedAt). Never throws into the spawn path.
 */
export function reviewBrownfieldAndAskDirection(
  seasonId: string,
  workspacePath: string,
  ctx?: GroomingContext,
): Promise<void> {
  return onceInFlight(seasonId, () =>
    reviewBrownfieldAndAskDirectionImpl(seasonId, workspacePath, ctx),
  );
}

async function reviewBrownfieldAndAskDirectionImpl(
  seasonId: string,
  workspacePath: string,
  ctx?: GroomingContext,
): Promise<void> {
  const season = getSeason(seasonId);
  if (!season) return;
  if (season.groomedAt) return;

  // Gather repo context: recent history + branches (execFile, no shell) + context.md.
  const recentCommits = await gitOutput(workspacePath, ['log', '--oneline', '-50']);
  const branches = await gitOutput(workspacePath, ['branch', '-a']);

  let contextMd = '';
  if (season.contextPath) {
    try {
      if (fs.existsSync(season.contextPath)) {
        contextMd = fs.readFileSync(season.contextPath, 'utf-8').slice(0, 12_000);
      }
    } catch {
      contextMd = '';
    }
  }

  const prompt =
    `You are the project manager onboarding onto an EXISTING software project. Using the repo ` +
    `context, recent commit history, and branches below, propose the candidate Epics (and notable ` +
    `Stories) the team could tackle next.\n\n` +
    `Respond with ONLY this strict JSON shape (no prose, no markdown fences), ordered by your ` +
    `recommended priority (most important first):\n` +
    `{ "candidates": [ { "title": "string", "kind": "epic|story", "rationale": "string" } ] }\n\n` +
    `Aim for 3-6 candidates. Keep titles short and actionable.\n\n` +
    `--- CONTEXT.md ---\n${contextMd || '(none available)'}\n\n` +
    `--- RECENT COMMITS (git log --oneline -50) ---\n${recentCommits || '(none)'}\n\n` +
    `--- BRANCHES (git branch -a) ---\n${branches || '(none)'}\n`;

  let json: Record<string, unknown> | null;
  try {
    const result = await invokeModel({ prompt, model: ctx?.model });
    json = result.json;
  } catch (err) {
    console.error(`grooming: brownfield one-shot failed for season ${seasonId}:`, err);
    logSystem(seasonId, 'PM brownfield review failed: the candidate-generation model call errored. Explore the repo directly to choose a starting point.');
    return;
  }

  const rawCandidates = json && Array.isArray((json as { candidates?: unknown }).candidates)
    ? ((json as { candidates: unknown[] }).candidates as GroomedCandidate[])
    : null;
  if (!rawCandidates) {
    logSystem(seasonId, 'PM brownfield review failed to parse candidate epics. Explore the repo directly to choose a starting point.');
    return;
  }

  const projectPath = season.workspacePath;
  const options: SeasonDirectionOption[] = [];

  for (const cand of rawCandidates.slice(0, MAX_CANDIDATES)) {
    const title = str(cand.title);
    if (!title) continue;
    const kind: 'epic' | 'story' = cand.kind === 'story' ? 'story' : 'epic';
    const rationale = str(cand.rationale);
    const task = createTask({
      title,
      description: rationale || '',
      projectId: projectPath,
      projectPath,
      seasonId,
      issueType: kind,
    });
    options.push({ id: task.id, title, kind });
  }

  if (options.length === 0) {
    logSystem(seasonId, 'PM brownfield review produced no candidate epics. Explore the repo directly to choose a starting point.');
    return;
  }

  season.directionRequest = {
    id: uuidv4(),
    question: 'We reviewed the repo. Which Epic should the team tackle first?',
    options,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  season.groomedAt = new Date().toISOString();
  saveSeason(seasonId);
  broadcastSeasonUpdated(seasonId);

  logSystem(
    seasonId,
    `PM reviewed the repo and proposed ${options.length} candidate epic${options.length === 1 ? '' : 's'}. Awaiting your direction on where to start.`,
  );
}
