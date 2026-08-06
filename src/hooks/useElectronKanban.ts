'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import type { KanbanTask, KanbanColumn, KanbanTaskCreate, KanbanTaskUpdate, KanbanMoveResult, KanbanComment, KanbanScope } from '@/types/kanban';
import { isElectron } from './useElectron';

export interface UseElectronKanbanOptions {
  seasonId?: string;
  scope?: KanbanScope;
}

/**
 * Returns true if a task belongs in the active scope filter.
 * Used to keep live events (create/update) consistent with the fetched view.
 */
function taskInScope(task: { seasonId?: string }, scope: KanbanScope, seasonId?: string): boolean {
  // Mirror the backend: season scope with no seasonId yet ⇒ show all (no filter),
  // so live events aren't dropped in the transient "By season selected, none chosen" state.
  if (scope === 'season') return !seasonId || task.seasonId === seasonId;
  if (scope === 'global') return !task.seasonId;
  return true; // 'all'
}

/**
 * Hook for Kanban board management via Electron IPC.
 *
 * Optional `opts` scopes the board to a season (`scope:'season'` + `seasonId`),
 * to the global/unassigned bucket (`scope:'global'`), or all tasks (default).
 */
export function useElectronKanban(opts?: UseElectronKanbanOptions) {
  const scope: KanbanScope = opts?.scope ?? 'all';
  const seasonId = opts?.seasonId;

  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Keep the latest scope in refs so the (subscribe-once) event handlers
  // can filter incoming tasks without re-subscribing on every scope change.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const seasonIdRef = useRef(seasonId);
  seasonIdRef.current = seasonId;

  // Fetch tasks for the active scope
  const fetchTasks = useCallback(async () => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      setIsLoading(false);
      return;
    }

    try {
      const result = await window.electronAPI.kanban.list({ scope, seasonId });
      if (result.error) {
        setError(result.error);
      } else {
        setTasks(result.tasks as KanbanTask[]);
        setError(null);
      }
    } catch (err) {
      console.error('Failed to fetch kanban tasks:', err);
      setError('Failed to fetch tasks');
    } finally {
      setIsLoading(false);
    }
  }, [scope, seasonId]);

  // Create a new task
  // Note: State is updated via onTaskCreated event to avoid duplicates
  const createTask = useCallback(async (params: KanbanTaskCreate) => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      throw new Error('Electron API not available');
    }

    const result = await window.electronAPI.kanban.create(params);
    return result;
  }, []);

  // Update a task
  // Note: State is updated via onTaskUpdated event
  const updateTask = useCallback(async (params: KanbanTaskUpdate) => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      throw new Error('Electron API not available');
    }

    const result = await window.electronAPI.kanban.update(params);
    return result;
  }, []);

  // Move a task to a different column
  // Note: State is updated via onTaskUpdated event
  const moveTask = useCallback(async (
    id: string,
    column: KanbanColumn,
    order?: number
  ): Promise<KanbanMoveResult> => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      throw new Error('Electron API not available');
    }

    const result = await window.electronAPI.kanban.move({ id, column, order });
    return result as KanbanMoveResult;
  }, []);

  // Delete a task
  // Note: State is updated via onTaskDeleted event
  const deleteTask = useCallback(async (id: string) => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      throw new Error('Electron API not available');
    }

    const result = await window.electronAPI.kanban.delete(id);
    return result;
  }, []);

  // Reorder tasks within a column
  // Note: State is updated via onTaskUpdated events
  const reorderTasks = useCallback(async (taskIds: string[], column: KanbanColumn) => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      throw new Error('Electron API not available');
    }

    const result = await window.electronAPI.kanban.reorder({ taskIds, column });
    return result;
  }, []);

  // Add a comment to a task (state updated via onTaskUpdated broadcast)
  const addComment = useCallback(async (
    taskId: string,
    body: string,
    author: string,
    authorName?: string
  ) => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      throw new Error('Electron API not available');
    }
    return window.electronAPI.kanban.commentAdd(taskId, { author, authorName, body });
  }, []);

  // List a task's comments
  const listComments = useCallback(async (taskId: string): Promise<KanbanComment[]> => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      return [];
    }
    const result = await window.electronAPI.kanban.commentList(taskId);
    return (result.comments ?? []) as KanbanComment[];
  }, []);

  // Delete a comment from a task
  const deleteComment = useCallback(async (taskId: string, commentId: string) => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      throw new Error('Electron API not available');
    }
    return window.electronAPI.kanban.commentDelete(taskId, commentId);
  }, []);

  // Get tasks by column
  const getTasksByColumn = useCallback((column: KanbanColumn): KanbanTask[] => {
    return tasks
      .filter(t => t.column === column)
      .sort((a, b) => a.order - b.order);
  }, [tasks]);

  // Subscribe to real-time events
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.kanban) return;

    const unsubCreated = window.electronAPI.kanban.onTaskCreated((task) => {
      const t = task as KanbanTask;
      // Ignore tasks that fall outside the active scope filter.
      if (!taskInScope(t, scopeRef.current, seasonIdRef.current)) return;
      setTasks(prev => {
        // Check if task already exists (might have been added by our own action)
        if (prev.some(existing => existing.id === t.id)) {
          return prev;
        }
        return [...prev, t];
      });
    });

    const unsubUpdated = window.electronAPI.kanban.onTaskUpdated((task) => {
      const t = task as KanbanTask;
      setTasks(prev => {
        const inScope = taskInScope(t, scopeRef.current, seasonIdRef.current);
        const exists = prev.some(existing => existing.id === t.id);
        // A task that drifted out of scope (or never belonged) should be dropped.
        if (!inScope) {
          return exists ? prev.filter(existing => existing.id !== t.id) : prev;
        }
        // In-scope: update if present, otherwise add (e.g. just assigned a seasonId).
        if (exists) {
          return prev.map(existing => existing.id === t.id ? t : existing);
        }
        return [...prev, t];
      });
    });

    const unsubDeleted = window.electronAPI.kanban.onTaskDeleted((event: { id: string }) => {
      setTasks(prev => prev.filter(t => t.id !== event.id));
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
    };
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  return {
    tasks,
    isLoading,
    error,
    isElectron: isElectron(),
    createTask,
    updateTask,
    moveTask,
    deleteTask,
    reorderTasks,
    addComment,
    listComments,
    deleteComment,
    getTasksByColumn,
    refresh: fetchTasks,
  };
}

/**
 * Hook to sync agent events with kanban tasks
 * Updates task progress and moves to "done" when agent completes
 */
export function useKanbanAgentSync(
  tasks: KanbanTask[],
  updateTask: (params: KanbanTaskUpdate) => Promise<unknown>,
  moveTask: (id: string, column: KanbanColumn) => Promise<unknown>
) {
  // Use ref to always have latest tasks without re-subscribing
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const updateTaskRef = useRef(updateTask);
  updateTaskRef.current = updateTask;

  const moveTaskRef = useRef(moveTask);
  moveTaskRef.current = moveTask;

  // In-flight set: tracks tasks that have already had a progress:50 update
  // dispatched but may not yet be reflected in `tasks` state (server round-trip).
  // Without this, bursts of onStatus events between issue and echo trigger
  // duplicate IPC writes — cascading kanban SQLite updates during busy agents.
  const progress50SentRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isElectron()) return;

    console.log('[Kanban Sync] Setting up agent event listeners');

    // Listen to agent status changes - only for progress updates, NOT for completion
    // The detectAgentStatus patterns are too broad and trigger false "completed" states
    const unsubStatus = window.electronAPI?.agent.onStatus?.((event: {
      agentId: string;
      status: string;
      timestamp: string;
    }) => {
      // Find task assigned to this agent
      const task = tasksRef.current.find(t => t.assignedAgentId === event.agentId);
      if (!task || task.column !== 'ongoing') return;

      // Only update progress for running status, NOT for completion
      // Completion is handled by onComplete (PTY exit) which is more reliable.
      // Dedup via in-flight Set so rapid status events don't storm the API.
      if (
        event.status === 'running' &&
        task.progress < 50 &&
        !progress50SentRef.current.has(task.id)
      ) {
        progress50SentRef.current.add(task.id);
        updateTaskRef.current({ id: task.id, progress: 50 });
      }
    });

    // onComplete fires when PTY actually exits - this is the reliable completion signal
    const unsubComplete = window.electronAPI?.agent.onComplete(async (event) => {
      console.log(`[Kanban Sync] Received complete event:`, event);

      const task = tasksRef.current.find(t => t.assignedAgentId === event.agentId);
      if (!task) {
        console.log(`[Kanban Sync] No task found for agent ${event.agentId}`);
        return;
      }

      console.log(`[Kanban Sync] Agent ${event.agentId} completed with exit code: ${event.exitCode} for task "${task.title}"`);

      if (task.column === 'ongoing') {
        const isSuccess = event.exitCode === 0;
        console.log(`[Kanban Sync] Moving task ${task.id} to done (success: ${isSuccess})`);

        // Get agent output for completion summary
        let completionSummary = isSuccess ? 'Task completed successfully.' : 'Task completed with errors.';
        try {
          const agent = await window.electronAPI?.agent.get(event.agentId);
          if (agent?.output && agent.output.length > 0) {
            // Get last 50 lines of output as summary (or less if not available)
            const outputLines = agent.output.slice(-50);
            completionSummary = outputLines.join('');
          }
        } catch (err) {
          console.error('[Kanban Sync] Failed to get agent output:', err);
        }

        updateTaskRef.current({ id: task.id, progress: 100, completionSummary });
        moveTaskRef.current(task.id, 'done');
        // Task is done — allow future progress:50 dispatches if agent
        // is ever re-assigned.
        progress50SentRef.current.delete(task.id);
      }
    });

    return () => {
      unsubStatus?.();
      unsubComplete?.();
    };
  }, []); // Empty deps - we use refs to avoid re-subscribing
}
