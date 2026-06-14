'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import dynamic from 'next/dynamic';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Loader2, RefreshCw, Search, ChevronDown, FolderOpen, Globe, Layers } from 'lucide-react';
import { useElectronKanban, useKanbanAgentSync } from '@/hooks/useElectronKanban';
import { isElectron as checkIsElectron } from '@/hooks/useElectron';
import type { KanbanTask, KanbanColumn as KanbanColumnType, KanbanTaskCreate, KanbanScope } from '@/types/kanban';
import type { AgentStatus } from '@/types/electron';
import { KanbanColumn } from './components/KanbanColumn';
import { KanbanCard } from './components/KanbanCard';
import { NewTaskModal } from './components/NewTaskModal';
import { KanbanCardDetail } from './components/KanbanCardDetail';
import { KanbanDoneSummary } from './components/KanbanDoneSummary';
import { COLUMN_ORDER } from './constants';

// Lazy load the terminal dialog
const AgentTerminalDialog = dynamic(
  () => import('@/components/AgentWorld/AgentTerminalDialog'),
  { ssr: false }
);

interface KanbanBoardProps {
  /** When set, scope the board to this season's tickets. */
  seasonId?: string;
  /** When true (with seasonId), hide the global/season switch and lock to the season. */
  lockScope?: boolean;
}

interface SeasonOption {
  id: string;
  name: string;
}

export default function KanbanBoard({ seasonId, lockScope }: KanbanBoardProps = {}) {
  // Scope state. A locked, season-embedded board starts in 'season' scope and
  // cannot be switched; a standalone board defaults to 'all' (global kanban).
  const [scope, setScope] = useState<KanbanScope>(seasonId && lockScope ? 'season' : 'all');
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | undefined>(seasonId);
  const [seasons, setSeasons] = useState<SeasonOption[]>([]);
  const [scopeDropdownOpen, setScopeDropdownOpen] = useState(false);

  // Resolve the effective scope/season passed to the hook.
  const effectiveSeasonId = lockScope ? seasonId : selectedSeasonId;
  const effectiveScope: KanbanScope = scope === 'season' && !effectiveSeasonId ? 'all' : scope;

  const {
    tasks,
    isLoading,
    error,
    isElectron,
    createTask,
    updateTask,
    moveTask,
    deleteTask,
    reorderTasks,
    addComment,
    deleteComment,
    getTasksByColumn,
    refresh,
  } = useElectronKanban({ scope: effectiveScope, seasonId: effectiveSeasonId });

  // Load seasons for the selector (only when the switch is available).
  useEffect(() => {
    if (lockScope || !checkIsElectron()) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI?.season?.list();
        if (cancelled) return;
        const list = (result?.seasons ?? []) as Array<{ id: string; name: string }>;
        setSeasons(list.map(s => ({ id: s.id, name: s.name })));
      } catch (err) {
        console.error('Failed to load seasons for kanban scope:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [lockScope]);

  // Enable agent sync
  useKanbanAgentSync(tasks, updateTask, moveTask);

  // Modal states
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [editingTask, setEditingTask] = useState<KanbanTask | null>(null);

  // Terminal dialog state
  const [terminalAgentId, setTerminalAgentId] = useState<string | null>(null);
  const [terminalAgent, setTerminalAgent] = useState<AgentStatus | null>(null);

  // Fetch agent when terminal is opened
  useEffect(() => {
    if (!terminalAgentId || !checkIsElectron()) {
      setTerminalAgent(null);
      return;
    }

    const fetchAgent = async () => {
      try {
        const agent = await window.electronAPI?.agent?.get(terminalAgentId);
        setTerminalAgent(agent || null);
      } catch (err) {
        console.error('Failed to fetch agent:', err);
        setTerminalAgent(null);
      }
    };

    fetchAgent();
  }, [terminalAgentId]);

  // Handle opening terminal for an agent
  const handleOpenTerminal = useCallback((agentId: string) => {
    setTerminalAgentId(agentId);
  }, []);

  // Handle closing terminal
  const handleCloseTerminal = useCallback(() => {
    setTerminalAgentId(null);
    setTerminalAgent(null);
  }, []);

  // Agent start/stop handlers for terminal dialog
  const handleAgentStart = useCallback(async (agentId: string, prompt: string) => {
    if (checkIsElectron() && window.electronAPI?.agent?.start) {
      await window.electronAPI.agent.start({ id: agentId, prompt });
      // Refresh agent state
      const agent = await window.electronAPI?.agent?.get(agentId);
      setTerminalAgent(agent || null);
    }
  }, []);

  const handleAgentStop = useCallback(async (agentId: string) => {
    if (checkIsElectron() && window.electronAPI?.agent?.stop) {
      await window.electronAPI.agent.stop(agentId);
      // Refresh agent state
      const agent = await window.electronAPI?.agent?.get(agentId);
      setTerminalAgent(agent || null);
    }
  }, []);

  // Filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [filterProject, setFilterProject] = useState<string | null>(null);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refresh();
    } finally {
      setTimeout(() => setIsRefreshing(false), 600);
    }
  }, [refresh, isRefreshing]);

  // Drag state
  const [activeTask, setActiveTask] = useState<KanbanTask | null>(null);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Filter tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesSearch =
          task.title.toLowerCase().includes(query) ||
          task.description.toLowerCase().includes(query) ||
          task.labels.some((l) => l.toLowerCase().includes(query));
        if (!matchesSearch) return false;
      }

      // Project filter
      if (filterProject && task.projectId !== filterProject) {
        return false;
      }

      return true;
    });
  }, [tasks, searchQuery, filterProject]);

  // Get filtered tasks by column
  const getFilteredTasksByColumn = useCallback(
    (column: KanbanColumnType) => {
      return filteredTasks
        .filter((t) => t.column === column)
        .sort((a, b) => a.order - b.order);
    },
    [filteredTasks]
  );

  // Get unique projects for filter
  const projects = useMemo(() => {
    const uniqueProjects = new Map<string, string>();
    tasks.forEach((task) => {
      if (!uniqueProjects.has(task.projectId)) {
        uniqueProjects.set(task.projectId, task.projectPath.split('/').pop() || task.projectId);
      }
    });
    return Array.from(uniqueProjects.entries()).map(([id, name]) => ({ id, name }));
  }, [tasks]);

  // Map task id → title so child cards can show their parent epic/story linkage.
  const parentTitleById = useMemo(() => {
    const map = new Map<string, string>();
    tasks.forEach((task) => map.set(task.id, task.title));
    return map;
  }, [tasks]);

  // Drag handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find((t) => t.id === active.id);
    if (task) {
      setActiveTask(task);
    }
  }, [tasks]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    // Could add visual feedback here
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeTask = tasks.find((t) => t.id === activeId);
    if (!activeTask) return;

    // Check if dropped on a column
    const overColumn = COLUMN_ORDER.find((c) => c === overId);
    if (overColumn) {
      // Moving to a different column
      if (activeTask.column !== overColumn) {
        console.log(`Moving task to column: ${overColumn}`);
        const result = await moveTask(activeId, overColumn);
        if (result.agentSpawned) {
          console.log(`Agent ${result.agentId} spawned for task`);
        }
      }
      return;
    }

    // Check if dropped on another task
    const overTask = tasks.find((t) => t.id === overId);
    if (overTask) {
      if (activeTask.column === overTask.column) {
        // Reorder within same column
        const columnTasks = getFilteredTasksByColumn(activeTask.column);
        const oldIndex = columnTasks.findIndex((t) => t.id === activeId);
        const newIndex = columnTasks.findIndex((t) => t.id === overId);

        if (oldIndex !== newIndex) {
          const newOrder = [...columnTasks];
          const [removed] = newOrder.splice(oldIndex, 1);
          newOrder.splice(newIndex, 0, removed);
          await reorderTasks(
            newOrder.map((t) => t.id),
            activeTask.column
          );
        }
      } else {
        // Move to different column at specific position
        await moveTask(activeId, overTask.column, overTask.order);
      }
    }
  }, [tasks, moveTask, reorderTasks, getFilteredTasksByColumn]);

  // Task handlers
  const handleCreateTask = async (data: KanbanTaskCreate) => {
    // Stamp the owning season when the board is scoped to one so the new task
    // shows up in (and is filtered to) that season.
    const seasonScopedId = effectiveScope === 'season' ? effectiveSeasonId : undefined;
    await createTask(seasonScopedId ? { ...data, seasonId: seasonScopedId } : data);
    setShowNewTaskModal(false);
  };

  // Comment handler for the card detail modal.
  const handleAddComment = useCallback(async (taskId: string, body: string) => {
    await addComment(taskId, body, 'user', 'You');
  }, [addComment]);

  const handleEditTask = (task: KanbanTask) => {
    setEditingTask(task);
  };

  const handleDeleteTask = async (taskId: string) => {
    if (confirm('Are you sure you want to delete this task?')) {
      await deleteTask(taskId);
    }
  };

  const handleUpdateTask = async (data: Partial<KanbanTask>) => {
    if (editingTask) {
      await updateTask({ id: editingTask.id, ...data });
      setEditingTask(null);
    }
  };

  // Non-Electron fallback
  if (!isElectron) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>Kanban board is only available in the desktop app</p>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4">
        <p className="text-red-400">{error}</p>
        <button
          onClick={handleRefresh}
          className="flex items-center gap-2 px-3 py-2 bg-secondary rounded-md hover:bg-secondary/80 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 lg:pt-6 mb-4">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">Task Board</h1>
          <p className="text-muted-foreground text-xs lg:text-sm mt-1 hidden sm:block">
            Drag to Planned to auto-assign agents
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Scope: Global ⟷ By season (+ season selector). Hidden when locked. */}
          {!lockScope && (
            <div className="flex items-center gap-2">
              {/* Segmented Global / By season toggle */}
              <div className="inline-flex items-center rounded-lg border border-border bg-secondary/50 p-0.5">
                <button
                  onClick={() => setScope('global')}
                  className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                    scope === 'global'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="Tasks not owned by any season"
                >
                  <Globe className="w-3.5 h-3.5" />
                  Global
                </button>
                <button
                  onClick={() => setScope('all')}
                  className={`inline-flex items-center text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                    scope === 'all'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="All tasks across every season"
                >
                  All
                </button>
                <button
                  onClick={() => setScope('season')}
                  className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                    scope === 'season'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="Filter to a single season"
                >
                  <Layers className="w-3.5 h-3.5" />
                  By season
                </button>
              </div>

              {/* Season selector (only meaningful in 'season' scope) */}
              {scope === 'season' && (
                <div className="relative">
                  <button
                    onClick={() => setScopeDropdownOpen(v => !v)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors text-sm min-w-[150px]"
                  >
                    <Layers className="w-4 h-4 shrink-0" />
                    <span className="truncate">
                      {seasons.find(s => s.id === selectedSeasonId)?.name || 'Select season'}
                    </span>
                    <ChevronDown className="w-4 h-4 ml-auto shrink-0" />
                  </button>

                  <AnimatePresence>
                    {scopeDropdownOpen && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setScopeDropdownOpen(false)} />
                        <motion.div
                          initial={{ opacity: 0, y: 5 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 5 }}
                          className="absolute top-full mt-2 right-0 w-56 max-h-72 overflow-y-auto bg-card border border-border rounded-lg shadow-lg z-20 py-2"
                        >
                          {seasons.length === 0 && (
                            <div className="px-4 py-2 text-sm text-muted-foreground">No seasons</div>
                          )}
                          {seasons.map((s) => {
                            const isSelected = s.id === selectedSeasonId;
                            return (
                              <button
                                key={s.id}
                                onClick={() => { setSelectedSeasonId(s.id); setScopeDropdownOpen(false); }}
                                className={`w-full text-left px-4 py-2 text-sm hover:bg-secondary truncate ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`}
                              >
                                {s.name}
                              </button>
                            );
                          })}
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 py-2 bg-secondary/50 border border-border/50 rounded-lg text-sm w-52 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all"
            />
          </div>

          {/* Project filter */}
          {projects.length > 1 && (
            <div className="relative">
              <button
                onClick={() => setProjectDropdownOpen(v => !v)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-none bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors text-sm min-w-[160px]"
              >
                <FolderOpen className="w-4 h-4" />
                {filterProject ? projects.find(p => p.id === filterProject)?.name : 'All Projects'}
                <ChevronDown className="w-4 h-4 ml-auto" />
              </button>

              <AnimatePresence>
                {projectDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setProjectDropdownOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 5 }}
                      className="absolute top-full mt-2 right-0 w-48 bg-card border border-border rounded-none shadow-lg z-20 py-2"
                    >
                      {[{ id: '', name: 'All Projects' }, ...projects].map((p) => {
                        const isSelected = (p.id === '' && !filterProject) || filterProject === p.id;
                        return (
                          <button
                            key={p.id}
                            onClick={() => { setFilterProject(p.id || null); setProjectDropdownOpen(false); }}
                            className={`w-full text-left px-4 py-2 text-sm hover:bg-secondary ${isSelected ? 'text-white' : 'text-muted-foreground'}`}
                          >
                            {p.name}
                          </button>
                        );
                      })}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Refresh button */}
          <button
            onClick={handleRefresh}
            className="p-2 rounded-lg hover:bg-secondary/50 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 text-muted-foreground transition-transform ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>

          {/* Add task button */}
          <button
            onClick={() => setShowNewTaskModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium text-sm"
          >
            New Task
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Board */}
      <div className="flex-1 overflow-x-auto px-6 pb-6">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 h-full w-full">
            {COLUMN_ORDER.map((column) => (
              <KanbanColumn
                key={column}
                column={column}
                tasks={getFilteredTasksByColumn(column)}
                onAddTask={column === 'backlog' ? () => setShowNewTaskModal(true) : undefined}
                onEditTask={handleEditTask}
                onDeleteTask={handleDeleteTask}
                onStartTask={moveTask}
                onOpenTerminal={handleOpenTerminal}
                parentTitleById={parentTitleById}
                activeTaskId={activeTask?.id}
              />
            ))}
          </div>

          {/* Drag overlay */}
          <DragOverlay>
            {activeTask && (
              <div className="w-[280px]">
                <KanbanCard task={activeTask} isDragging />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {/* New task modal */}
      <AnimatePresence>
        {showNewTaskModal && (
          <NewTaskModal
            onClose={() => setShowNewTaskModal(false)}
            onCreate={handleCreateTask}
          />
        )}
      </AnimatePresence>

      {/* Edit task modal (for backlog/planned tasks only) */}
      <AnimatePresence>
        {editingTask && editingTask.column !== 'done' && editingTask.column !== 'ongoing' && (
          <KanbanCardDetail
            // Re-read the live task from state so comments added via broadcast appear instantly.
            task={tasks.find(t => t.id === editingTask.id) ?? editingTask}
            parentTitle={editingTask.parentId ? parentTitleById.get(editingTask.parentId) : undefined}
            onClose={() => setEditingTask(null)}
            onUpdate={handleUpdateTask}
            onDelete={() => {
              handleDeleteTask(editingTask.id);
              setEditingTask(null);
            }}
            onAddComment={handleAddComment}
            onDeleteComment={deleteComment}
          />
        )}
      </AnimatePresence>

      {/* Done task summary modal */}
      <AnimatePresence>
        {editingTask && editingTask.column === 'done' && (
          <KanbanDoneSummary
            task={editingTask}
            onClose={() => setEditingTask(null)}
            onDelete={() => {
              handleDeleteTask(editingTask.id);
              setEditingTask(null);
            }}
          />
        )}
      </AnimatePresence>

      {/* Agent Terminal Dialog - skip historical output to avoid display issues */}
      {terminalAgentId && terminalAgent && (
        <AgentTerminalDialog
          agent={terminalAgent}
          open={!!terminalAgentId}
          onClose={handleCloseTerminal}
          onStart={handleAgentStart}
          onStop={handleAgentStop}
          skipHistoricalOutput={true}
        />
      )}
    </div>
  );
}
