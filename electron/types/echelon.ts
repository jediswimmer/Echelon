import type { AgentStatus } from './index';

export type SeasonStatus = 'spawning' | 'active' | 'paused' | 'archived' | 'restoring';

/** Where the season workspace lives / is linked to. */
export type SourceControlType = 'local' | 'github' | 'azure-devops' | 'local-clone';

/**
 * Optional source-control linkage for a season. `local` (or undefined) is the
 * default empty-git-init behavior. `github` / `azure-devops` clone the named
 * repo as the season workspace at spawn time. `local-clone` points at a folder
 * that is ALREADY a local git clone: Echelon validates its git connection and
 * uses it in place (no re-clone) as the season workspace, casting worktrees off
 * it — the user's checked-out files are never mutated.
 */
export interface SeasonSourceControl {
  type: SourceControlType;
  /** Repo identifier — `owner/repo` or full URL for GitHub, clone URL for AzDO. */
  repoUrl?: string;
  /**
   * Absolute path to an existing local git clone, used as the season workspace
   * in-place (only for `type: 'local-clone'`). Resolved to a realpath at spawn.
   */
  localPath?: string;
}

/**
 * How a season is started:
 *   • `greenfield` — a brand-new project (the default). No prior repo state to
 *     ingest; the PRD describes what to build from scratch.
 *   • `brownfield` — an existing, in-flight project found in a linked repo. On
 *     spawn, Echelon bootstraps the team's context from that repo (see
 *     {@link SeasonContextStatus}).
 */
export type SeasonIntake = 'greenfield' | 'brownfield';

/**
 * Lifecycle of the brownfield context bootstrap, surfaced on the control board.
 *   • `greenfield` — not a brownfield season; no context bootstrap runs.
 *   • `searching`  — searching repo docs / KB / prior seasons for existing context.
 *   • `reviewing`  — no context found; a code-review/onboarding agent is mapping
 *     the codebase to build it.
 *   • `ready`      — a consolidated `context.md` is available to the team.
 *   • `failed`     — the bootstrap could not complete (e.g. review agent failed).
 */
export type SeasonContextStatus =
  | 'greenfield'
  | 'searching'
  | 'reviewing'
  | 'ready'
  | 'failed';

/**
 * One candidate direction the team surfaced for the user to choose from when a
 * brownfield season needs a starting point (17c). Each option maps to a kanban
 * epic/story created at review time (`id` = that task id).
 */
export interface SeasonDirectionOption {
  id: string;
  title: string;
  kind: 'epic' | 'story';
}

/**
 * A pending "the team needs your direction" prompt, surfaced on the control
 * board for brownfield seasons. After the PM reviews the repo it proposes
 * candidate epics/stories and asks which to tackle first; answering moves the
 * chosen epic's children into the `planned` column (17c).
 */
export interface SeasonDirectionRequest {
  id: string;
  question: string;
  /** Candidate epics/stories from the review (each maps to a created task). */
  options: SeasonDirectionOption[];
  status: 'open' | 'answered';
  /** Chosen option id OR free-text the user typed. */
  answer?: string;
  chosenOptionId?: string;
  createdAt: string;
  answeredAt?: string;
}

export interface Season {
  id: string;
  name: string;
  theme: string;
  status: SeasonStatus;
  rosterManifestPath: string;
  workspacePath: string;
  characterIds: string[];
  createdAt: string;
  archivedAt?: string;
  /** Source-control linkage chosen at kickoff. Omitted ⇒ local-only. */
  sourceControl?: SeasonSourceControl;
  /** Linked Jira project key (e.g. "SD"). Capture + display only (no sync yet). */
  jiraProjectKey?: string;
  /** Greenfield (new) vs brownfield (existing, in-flight repo). Defaults greenfield. */
  intake?: SeasonIntake;
  /** State of the brownfield context bootstrap (see {@link SeasonContextStatus}). */
  contextStatus?: SeasonContextStatus;
  /** Absolute path to the consolidated `context.md` once written (within ~/.echelon). */
  contextPath?: string;
  /**
   * Set once the PM has groomed the starting backlog for this season (17c).
   * Guards against re-grooming on every app restart / season relaunch.
   */
  groomedAt?: string;
  /**
   * Pending "the team needs your direction" prompt for brownfield seasons (17c).
   * Present + `status: 'open'` ⇒ the control board renders a direction card.
   */
  directionRequest?: SeasonDirectionRequest;
}

export interface Character extends AgentStatus {
  seasonId: string;
  archetypeId: string;
  soulPackagePath: string;
  canonName: string;
  theme: string;
}

export interface SoulPackage {
  soul: string;
  agents: string;
  heartbeat: string;
  memorySeed: string;
  persona: string;
  user?: string;
  commitments?: string;
  deployChecklist?: string;
  frontmatter: Record<string, unknown>;
}

export interface RosterEntry {
  characterSlug: string;
  archetypeId: string;
  canonName: string;
  theme: string;
  soulPackagePath: string;
  capabilities: string[];
}

export interface RosterManifest {
  seasonId: string;
  theme: string;
  tier: 'small' | 'medium' | 'large' | 'enterprise';
  characters: RosterEntry[];
}
