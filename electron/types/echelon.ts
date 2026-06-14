import type { AgentStatus } from './index';

export type SeasonStatus = 'spawning' | 'active' | 'paused' | 'archived' | 'restoring';

/** Where the season workspace lives / is linked to. */
export type SourceControlType = 'local' | 'github' | 'azure-devops';

/**
 * Optional source-control linkage for a season. `local` (or undefined) is the
 * default empty-git-init behavior. `github` / `azure-devops` clone the named
 * repo as the season workspace at spawn time.
 */
export interface SeasonSourceControl {
  type: SourceControlType;
  /** Repo identifier — `owner/repo` or full URL for GitHub, clone URL for AzDO. */
  repoUrl?: string;
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
