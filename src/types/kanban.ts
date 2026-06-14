/**
 * Kanban Board Types
 *
 * Task management with automatic agent spawning when tasks move to "planned" column.
 */

export type KanbanColumn = 'backlog' | 'planned' | 'ongoing' | 'done';

/** Jira-style issue hierarchy. A missing value is treated as `'task'` everywhere. */
export type KanbanIssueType = 'epic' | 'story' | 'task';

/** Scope filter for season-aware board queries. */
export type KanbanScope = 'all' | 'season' | 'global';

export interface TaskAttachment {
  path: string;                  // Full file path
  name: string;                  // Display name (filename)
  type: 'image' | 'pdf' | 'document' | 'other';
  size?: number;                 // File size in bytes
}

/** A single comment on a kanban task (local or mirrored from Jira). */
export interface KanbanComment {
  id: string;
  author: string;                // agentId | 'user' | jira accountId
  authorName?: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
  source: 'local' | 'jira';
  jiraCommentId?: string;
}

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  column: KanbanColumn;
  projectId: string;
  projectPath: string;           // For agent spawning
  assignedAgentId: string | null;
  agentCreatedForTask: boolean;  // If true, delete agent when task completes
  requiredSkills: string[];      // For agent matching
  priority: 'low' | 'medium' | 'high';
  progress: number;              // 0-100, synced from agent
  createdAt: string;
  updatedAt: string;
  completedAt?: string;          // When task was marked done
  order: number;                 // Position in column
  labels: string[];
  completionSummary?: string;    // Summary of what was done by the agent
  attachments: TaskAttachment[]; // Files attached to the task

  // --- Season + Jira-style hierarchy (all optional, back-compatible) ---
  seasonId?: string;             // Owning season (undefined = global/manual/legacy)
  issueType?: KanbanIssueType;   // Treat missing as 'task' everywhere
  parentId?: string;             // story → epic id; task → story id
  comments?: KanbanComment[];    // Comment thread
  jiraKey?: string;              // Reserved for Jira sync (display only)
  jiraStatus?: string;           // Reserved for Jira sync (display only)
  epicColor?: string;            // Optional grouping color for epics
}

export interface KanbanTaskCreate {
  title: string;
  description: string;
  projectId: string;
  projectPath: string;
  requiredSkills?: string[];
  priority?: 'low' | 'medium' | 'high';
  labels?: string[];
  attachments?: TaskAttachment[];
  // Season + Jira-style hierarchy (all optional, back-compatible)
  seasonId?: string;
  issueType?: KanbanIssueType;
  parentId?: string;
  jiraKey?: string;
}

/** Options for filtering the kanban list by season scope. */
export interface KanbanListOptions {
  seasonId?: string;
  scope?: KanbanScope;
}

/** Input shape for adding a comment to a task. */
export interface KanbanCommentCreate {
  author: string;
  authorName?: string;
  body: string;
  source?: 'local' | 'jira';
}

export interface KanbanTaskUpdate {
  id: string;
  title?: string;
  description?: string;
  requiredSkills?: string[];
  priority?: 'low' | 'medium' | 'high';
  labels?: string[];
  progress?: number;
  assignedAgentId?: string | null;
  completionSummary?: string;
}

export interface KanbanMoveResult {
  success: boolean;
  task?: KanbanTask;
  agentSpawned?: boolean;
  agentId?: string;
  error?: string;
}

export const COLUMN_CONFIG: Record<KanbanColumn, { title: string; description: string; color: string }> = {
  backlog: {
    title: 'Backlog',
    description: 'Tasks waiting to be planned',
    color: 'gray',
  },
  planned: {
    title: 'Planned',
    description: 'Ready for agent assignment',
    color: 'blue',
  },
  ongoing: {
    title: 'Ongoing',
    description: 'Agent is working on it',
    color: 'amber',
  },
  done: {
    title: 'Done',
    description: 'Completed tasks',
    color: 'green',
  },
};

export const COLUMN_ORDER: KanbanColumn[] = ['backlog', 'planned', 'ongoing', 'done'];
