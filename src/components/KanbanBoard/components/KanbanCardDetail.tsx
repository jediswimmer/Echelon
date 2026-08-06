'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  X,
  Trash2,
  Save,
  Bot,
  Clock,
  Plus,
  MessageSquare,
  Send,
  Link2,
  GitBranch,
  GitPullRequest,
  UserCheck,
} from 'lucide-react';
import type { KanbanTask } from '@/types/kanban';
import { COLUMN_CONFIG, getLabelColor, ISSUE_TYPE_CONFIG, getIssueType } from '../constants';

interface KanbanCardDetailProps {
  task: KanbanTask;
  /** Title of the parent epic/story, if this is a child issue. */
  parentTitle?: string;
  onClose: () => void;
  onUpdate: (data: Partial<KanbanTask>) => Promise<void>;
  onDelete: () => void;
  /** Append a comment (author = 'user'). State refreshes via task broadcast. */
  onAddComment?: (taskId: string, body: string) => Promise<void>;
  /** Remove a comment by id. */
  onDeleteComment?: (taskId: string, commentId: string) => Promise<unknown>;
}

/** Human-friendly relative time (e.g. "5m ago", "2h ago", "3d ago"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function KanbanCardDetail({ task, parentTitle, onClose, onUpdate, onDelete, onAddComment, onDeleteComment }: KanbanCardDetailProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState(task.priority);
  const [requiredSkills, setRequiredSkills] = useState<string[]>(task.requiredSkills);
  const [skillInput, setSkillInput] = useState('');
  const [labels, setLabels] = useState<string[]>(task.labels);
  const [labelInput, setLabelInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [commentInput, setCommentInput] = useState('');
  const [isCommenting, setIsCommenting] = useState(false);
  const [isOpeningPR, setIsOpeningPR] = useState(false);
  const [prMessage, setPrMessage] = useState<string | null>(null);

  const columnConfig = COLUMN_CONFIG[task.column];
  const issueType = getIssueType(task.issueType);
  const issueConfig = ISSUE_TYPE_CONFIG[issueType];
  const comments = task.comments ?? [];

  // 17e: branch-per-epic + PR-on-completion is only meaningful for epics/stories.
  const isEpicOrStory = issueType === 'epic' || issueType === 'story';
  const reviewGateLabel =
    task.reviewGate === 'pending-human'
      ? 'Awaiting human review'
      : task.reviewGate === 'approved'
        ? 'Approved'
        : task.reviewGate === 'auto-approved'
          ? 'Auto-approved (no human team)'
          : undefined;

  // Manually open the team-factory PR for this epic/story (never auto-merges).
  const handleOpenPR = async () => {
    if (!task.seasonId || isOpeningPR) return;
    setIsOpeningPR(true);
    setPrMessage(null);
    try {
      const api = (window as unknown as { electronAPI?: { season?: { epic?: { openPR?: (s: string, t: string) => Promise<{ opened: boolean; prUrl?: string; reason?: string }> } } } }).electronAPI;
      const result = await api?.season?.epic?.openPR?.(task.seasonId, task.id);
      if (result?.opened && result.prUrl) {
        setPrMessage(`PR opened: ${result.prUrl}`);
      } else {
        setPrMessage(result?.reason ?? 'Could not open a PR for this epic.');
      }
    } catch (err) {
      setPrMessage(err instanceof Error ? err.message : 'Failed to open PR.');
    } finally {
      setIsOpeningPR(false);
    }
  };

  const hasChanges =
    title !== task.title ||
    description !== task.description ||
    priority !== task.priority ||
    JSON.stringify(requiredSkills) !== JSON.stringify(task.requiredSkills) ||
    JSON.stringify(labels) !== JSON.stringify(task.labels);

  const handleAddSkill = () => {
    if (skillInput.trim() && !requiredSkills.includes(skillInput.trim())) {
      setRequiredSkills([...requiredSkills, skillInput.trim()]);
      setSkillInput('');
    }
  };

  const handleRemoveSkill = (skill: string) => {
    setRequiredSkills(requiredSkills.filter((s) => s !== skill));
  };

  const handleAddLabel = () => {
    if (labelInput.trim() && !labels.includes(labelInput.trim())) {
      setLabels([...labels, labelInput.trim()]);
      setLabelInput('');
    }
  };

  const handleRemoveLabel = (label: string) => {
    setLabels(labels.filter((l) => l !== label));
  };

  const handleSave = async () => {
    if (!title.trim()) return;

    setIsSaving(true);
    try {
      await onUpdate({
        title: title.trim(),
        description: description.trim(),
        priority,
        requiredSkills,
        labels,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddComment = async () => {
    const body = commentInput.trim();
    if (!body || !onAddComment || isCommenting) return;
    setIsCommenting(true);
    try {
      await onAddComment(task.id, body);
      setCommentInput('');
    } finally {
      setIsCommenting(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
      />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-xl"
      >
        <div className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <div className="flex items-center gap-2 flex-wrap">
              <div className={`w-3 h-3 rounded-full ${columnConfig.accentColor}`} />
              <span className="text-sm font-medium text-muted-foreground">
                {columnConfig.title}
              </span>
              {/* Issue type badge */}
              <span
                className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border ${issueConfig.bg} ${issueConfig.text} ${issueConfig.border}`}
              >
                {issueConfig.label}
              </span>
              {/* Jira key chip (display only — no API call) */}
              {task.jiraKey && (
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground font-mono">
                  <Link2 className="w-3 h-3 shrink-0" />
                  {task.jiraKey}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={onDelete}
                className="p-2 rounded-lg hover:bg-red-500/10 transition-colors text-muted-foreground hover:text-red-500"
                title="Delete task"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                onClick={onClose}
                className="p-2 rounded-lg hover:bg-secondary transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="p-6 space-y-5 max-h-[60vh] overflow-y-auto">
            {/* Title */}
            <div>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title..."
                className="w-full text-lg font-semibold bg-transparent border-none focus:outline-none focus:ring-0 p-0 placeholder:text-muted-foreground/50"
              />
              {/* Parent linkage (story → epic, task → story) */}
              {task.parentId && parentTitle && (
                <p className="text-xs text-muted-foreground/80 mt-1 truncate" title={parentTitle}>
                  ↳ in {parentTitle}
                </p>
              )}
            </div>

            {/* Description */}
            <div>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add a description..."
                rows={4}
                className="w-full text-sm bg-secondary/30 border border-border/50 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none placeholder:text-muted-foreground/50"
              />
            </div>

            {/* Priority */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Priority
              </label>
              <div className="flex gap-2">
                {(['low', 'medium', 'high'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`
                      flex-1 px-3 py-2 text-sm rounded-lg border-2 transition-all font-medium
                      ${priority === p
                        ? p === 'high'
                          ? 'bg-red-500/10 border-red-500/50 text-red-500'
                          : p === 'medium'
                          ? 'bg-amber-500/10 border-amber-500/50 text-amber-500'
                          : 'bg-zinc-500/10 border-zinc-500/50 text-zinc-500'
                        : 'bg-transparent border-border/50 text-muted-foreground hover:border-border'
                      }
                    `}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Labels */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Labels
              </label>
              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddLabel();
                    }
                  }}
                  placeholder="Add label..."
                  className="flex-1 px-3 py-2 bg-secondary/30 border border-border/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  type="button"
                  onClick={handleAddLabel}
                  className="px-3 py-2 bg-secondary/50 border border-border/50 rounded-lg hover:bg-secondary transition-colors"
                >
                  <Plus className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {labels.map((label) => {
                  const colors = getLabelColor(label);
                  return (
                    <span
                      key={label}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${colors.bg} ${colors.text}`}
                    >
                      {label}
                      <button
                        type="button"
                        onClick={() => handleRemoveLabel(label)}
                        className="hover:opacity-70"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  );
                })}
                {labels.length === 0 && (
                  <span className="text-xs text-muted-foreground/50">No labels</span>
                )}
              </div>
            </div>

            {/* Skills */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Required Skills
              </label>
              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={skillInput}
                  onChange={(e) => setSkillInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddSkill();
                    }
                  }}
                  placeholder="Add skill..."
                  className="flex-1 px-3 py-2 bg-secondary/30 border border-border/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  type="button"
                  onClick={handleAddSkill}
                  className="px-3 py-2 bg-secondary/50 border border-border/50 rounded-lg hover:bg-secondary transition-colors"
                >
                  <Plus className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {requiredSkills.map((skill) => (
                  <span
                    key={skill}
                    className="flex items-center gap-1.5 px-3 py-1 bg-blue-500/10 text-blue-500 rounded-full text-xs font-medium"
                  >
                    {skill}
                    <button
                      type="button"
                      onClick={() => handleRemoveSkill(skill)}
                      className="hover:opacity-70"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {requiredSkills.length === 0 && (
                  <span className="text-xs text-muted-foreground/50">No skills required</span>
                )}
              </div>
            </div>

            {/* Release: branch / review gate / PR (17e — epics & stories only) */}
            {isEpicOrStory && (task.branch || task.reviewGate || task.prUrl || task.seasonId) && (
              <div className="pt-4 border-t border-border/50">
                <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                  <GitBranch className="w-3.5 h-3.5" />
                  Release
                </label>
                <div className="space-y-2">
                  {/* Branch */}
                  {task.branch ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <GitBranch className="w-3.5 h-3.5 shrink-0" />
                      <span className="font-mono truncate" title={task.branch}>{task.branch}</span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground/60">No branch yet — created when this epic is started.</p>
                  )}

                  {/* Review gate */}
                  {reviewGateLabel && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <UserCheck className="w-3.5 h-3.5 shrink-0" />
                      <span>{reviewGateLabel}</span>
                    </div>
                  )}

                  {/* PR link or Open-PR action */}
                  {task.prUrl ? (
                    <a
                      href={task.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 text-xs text-purple-500 hover:underline"
                    >
                      <GitPullRequest className="w-3.5 h-3.5 shrink-0" />
                      View PR{task.prNumber ? ` #${task.prNumber}` : ''}
                      {task.prState && task.prState !== 'open' ? ` (${task.prState})` : ''}
                    </a>
                  ) : (
                    task.seasonId && (
                      <button
                        type="button"
                        onClick={handleOpenPR}
                        disabled={isOpeningPR}
                        className="inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-500 hover:bg-purple-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <GitPullRequest className="w-3.5 h-3.5" />
                        {isOpeningPR ? 'Opening PR…' : 'Open PR'}
                      </button>
                    )
                  )}

                  {/* Open-PR result / skip reason */}
                  {prMessage && (
                    <p className="text-[11px] text-muted-foreground/80 break-words">{prMessage}</p>
                  )}
                </div>
              </div>
            )}

            {/* Comments */}
            <div className="pt-4 border-t border-border/50">
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                <MessageSquare className="w-3.5 h-3.5" />
                Comments
                {comments.length > 0 && (
                  <span className="text-muted-foreground/70 normal-case tracking-normal">({comments.length})</span>
                )}
              </label>

              {/* Thread */}
              <div className="space-y-3 max-h-52 overflow-y-auto mb-3">
                {comments.length === 0 && (
                  <p className="text-xs text-muted-foreground/50">No comments yet</p>
                )}
                {comments.map((comment) => (
                  <div key={comment.id} className="group/comment flex gap-2.5">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-medium text-primary uppercase">
                        {(comment.authorName || comment.author || '?').charAt(0)}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-foreground truncate">
                          {comment.authorName || comment.author}
                        </span>
                        <span className="text-[11px] text-muted-foreground/70 shrink-0">
                          {relativeTime(comment.createdAt)}
                        </span>
                        {comment.source === 'jira' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground shrink-0">
                            Jira
                          </span>
                        )}
                        {onDeleteComment && (
                          <button
                            type="button"
                            onClick={() => onDeleteComment(task.id, comment.id)}
                            className="ml-auto p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors opacity-0 group-hover/comment:opacity-100"
                            title="Delete comment"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words mt-0.5">
                        {comment.body}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add comment */}
              {onAddComment && (
                <div className="flex gap-2 items-end">
                  <textarea
                    value={commentInput}
                    onChange={(e) => setCommentInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        handleAddComment();
                      }
                    }}
                    placeholder="Add a comment... (⌘↵ to send)"
                    rows={2}
                    className="flex-1 text-sm bg-secondary/30 border border-border/50 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none placeholder:text-muted-foreground/50"
                  />
                  <button
                    type="button"
                    onClick={handleAddComment}
                    disabled={!commentInput.trim() || isCommenting}
                    className="p-2.5 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                    title="Add comment"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>

            {/* Meta info */}
            <div className="flex items-center gap-4 pt-4 border-t border-border/50 text-xs text-muted-foreground">
              {task.assignedAgentId && (
                <div className="flex items-center gap-1.5 text-green-500">
                  <Bot className="w-3.5 h-3.5" />
                  <span>Agent assigned</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span>Created {new Date(task.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-border bg-secondary/20">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges || !title.trim() || isSaving}
              className="flex items-center gap-2 px-5 py-2 bg-primary text-primary-foreground text-sm rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              <Save className="w-4 h-4" />
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </motion.div>
    </>
  );
}
