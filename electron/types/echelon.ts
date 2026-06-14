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

/**
 * Per-season operating mode (#22a).
 *   • `autonomous`    — the agent team runs the whole show. Fully-autonomous
 *     scheduling (usage windows + cron) lands with #18; until then this is the
 *     default and only affects which control-board affordances render.
 *   • `collaborative` — a human hybrid dev team works alongside the agents. Real
 *     GitHub/Jira users are mapped onto archetype roles ({@link HumanSeat}); the
 *     agents cover only the non-human seats, and epic-completion PRs are gated
 *     `pending-human` (see `evaluateReviewGate` in `electron/services/git-pr.ts`).
 * Treat a missing `mode` as `'autonomous'`.
 */
export type SeasonMode = 'autonomous' | 'collaborative';

/**
 * One human-owned seat in a collaborative season (#22a): a real person mapped
 * onto an archetype role. When a season has ≥1 seat, that role's cast agent is
 * stopped (the human owns it) and re-spawns skip casting an agent for it.
 */
export interface HumanSeat {
  /** Stable id (uuid) for this seat assignment. */
  id: string;
  /** The archetype/role this human owns — matches a cast agent's `archetypeId`. */
  archetypeId: string;
  /** Display name of the role/character this seat covers. */
  roleName?: string;
  /** Where the human was sourced from. */
  source: 'github' | 'jira' | 'manual';
  /** GitHub login, Jira accountId/email, or a freeform handle. */
  handle: string;
  /** Human-friendly display name (when known). */
  displayName?: string;
}

/**
 * A recurring (or one-off) team ceremony for a Collaborative-mode season (#22b /
 * Scott's requirement #11): standups, grooming, sprint reviews, team meetings.
 *   • `standup`      — a daily/weekly sync.
 *   • `grooming`     — backlog refinement.
 *   • `sprint-end`   — end-of-sprint review/retro.
 *   • `team-meeting` — a general team meeting.
 *   • `custom`       — anything else (free-form title).
 */
export type CeremonyKind = 'standup' | 'grooming' | 'sprint-end' | 'team-meeting' | 'custom';

/** How often a ceremony repeats. `once` is a single dated occurrence. */
export type CeremonyCadence = 'daily' | 'weekly' | 'biweekly' | 'once';

/**
 * One configured ceremony on a season's calendar (#22b). Stores the cadence +
 * timing + an optional join link; the renderer computes the next occurrence and
 * an "Add to Google Calendar" template URL from these fields. Auto-firing these
 * on schedule (the Autonomous-mode cron) is deferred to #18 — this only stores
 * the schedule + meeting link.
 */
export interface SeasonCeremony {
  /** Stable id (uuid). */
  id: string;
  kind: CeremonyKind;
  /** Display title, e.g. "Daily Standup". */
  title: string;
  cadence: CeremonyCadence;
  /** 0-6 (Sun-Sat) — used for `weekly`/`biweekly`. */
  dayOfWeek?: number;
  /** 'HH:MM' 24h local time. */
  time?: string;
  /** ISO date (YYYY-MM-DD) — the date for `once`, or the anchor for `biweekly`. */
  startDate?: string;
  /** Meeting duration in minutes (default 30). */
  durationMins?: number;
  /** The join URL (Zoom / Google Meet / Teams / …). */
  meetingLink?: string;
  /** Free-form notes / agenda. */
  notes?: string;
  createdAt: string;
}

/**
 * A discussion item / open question the primary-contact agent raised after
 * absorbing a meeting transcript (#22c / Scott's requirement #11), surfaced back
 * to the user on the control board. Mirrors the 17c direction-request
 * "surface a question to the user" pattern.
 */
export interface MeetingFollowUp {
  /** Stable id (uuid). */
  id: string;
  /** A discussion item / question for the user. */
  question: string;
  status: 'open' | 'resolved';
  /** The ceremony this follow-up came out of (when attached to one). */
  ceremonyId?: string;
  createdAt: string;
  resolvedAt?: string;
}

/**
 * The structured result of the primary-contact agent absorbing one meeting
 * transcript (#22c): a short summary, the decisions reached, and the kanban task
 * ids created from the meeting's action items. A bounded history of these is kept
 * on the season.
 */
export interface MeetingAbsorption {
  /** Stable id (uuid). */
  id: string;
  /** The ceremony this meeting maps to (when attached to one). */
  ceremonyId?: string;
  /** ISO timestamp when the transcript was absorbed. */
  at: string;
  summary: string;
  decisions: string[];
  /** Kanban task ids created (issueType 'task', season-scoped) from action items. */
  actionItemTaskIds: string[];
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
  /**
   * Operating mode for this season (#22a): `autonomous` (agents run the show,
   * the default) vs `collaborative` (a human hybrid dev team works alongside the
   * agents). Missing ⇒ treated as `'autonomous'`.
   */
  mode?: SeasonMode;
  /**
   * The human hybrid dev team for a collaborative season (#22a). When `seats` is
   * non-empty, epic-completion PRs are gated `pending-human` instead of
   * `auto-approved` (see `evaluateReviewGate` in `electron/services/git-pr.ts`),
   * each seat's archetype is owned by a real person (its cast agent is stopped),
   * and re-spawns skip casting an agent for it. Absent/empty ⇒ no human team ⇒
   * auto-approved, all seats agent-run.
   */
  humanTeam?: { seats: HumanSeat[] };
  /**
   * The team's ceremony calendar for a collaborative season (#22b): standups,
   * grooming, sprint reviews, team meetings — each with a cadence, a time, and an
   * optional meeting link. Shown on the control board in Collaborative mode.
   * Auto-firing on schedule is deferred to #18; this only stores the config.
   */
  ceremonies?: SeasonCeremony[];
  /**
   * The designated primary-contact agent for this season (#22c): the agent that
   * attends + summarizes meetings (e.g. a scrum-master / user-handler). Stores a
   * cast agentId; when unset, {@link getPrimaryContact} falls back to the
   * convener's agentId.
   */
  primaryContactAgentId?: string;
  /**
   * Open/resolved discussion items the primary-contact agent raised after
   * absorbing meeting transcripts (#22c), surfaced on the control board.
   */
  meetingFollowUps?: MeetingFollowUp[];
  /**
   * A bounded history (most-recent last, capped) of meeting transcripts the
   * primary-contact agent has absorbed (#22c): summary, decisions, and the
   * action-item task ids it created.
   */
  meetingAbsorptions?: MeetingAbsorption[];
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
