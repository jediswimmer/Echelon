'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Users, Shield, Settings, Archive, RotateCcw, MessagesSquare, KanbanSquare, Github, GitBranch, FolderGit2, FileText, Loader2, Search, ScanSearch, CheckCircle2, AlertTriangle } from 'lucide-react';
import ThemeBadge from '@/components/Echelon/ThemeBadge';
import Link from 'next/link';

interface SeasonSourceControl {
  type: 'local' | 'github' | 'azure-devops';
  repoUrl?: string;
}

type SeasonIntake = 'greenfield' | 'brownfield';
type SeasonContextStatus = 'greenfield' | 'searching' | 'reviewing' | 'ready' | 'failed';

interface Season {
  id: string;
  name: string;
  theme: string;
  status: string;
  characterIds: string[];
  createdAt: string;
  archivedAt?: string;
  workspacePath: string;
  rosterManifestPath: string;
  sourceControl?: SeasonSourceControl;
  jiraProjectKey?: string;
  intake?: SeasonIntake;
  contextStatus?: SeasonContextStatus;
  contextPath?: string;
}

/** Chip metadata for the brownfield context-bootstrap status. */
function contextStatusMeta(status?: SeasonContextStatus): {
  label: string;
  Icon: typeof Search;
  className: string;
} | null {
  switch (status) {
    case 'searching':
      return { label: 'Searching for context', Icon: Search, className: 'text-blue-500 border-blue-500/30 bg-blue-500/10' };
    case 'reviewing':
      return { label: 'Code review in progress', Icon: ScanSearch, className: 'text-amber-500 border-amber-500/30 bg-amber-500/10' };
    case 'ready':
      return { label: 'Context ready', Icon: CheckCircle2, className: 'text-green-500 border-green-500/30 bg-green-500/10' };
    case 'failed':
      return { label: 'Context bootstrap failed', Icon: AlertTriangle, className: 'text-red-500 border-red-500/30 bg-red-500/10' };
    case 'greenfield':
    default:
      // Greenfield (or unset) seasons show no context chip.
      return null;
  }
}

/** Human label + icon for a source-control linkage. */
function sourceControlMeta(sc?: SeasonSourceControl): { label: string; Icon: typeof Github } {
  switch (sc?.type) {
    case 'github': return { label: 'GitHub', Icon: Github };
    case 'azure-devops': return { label: 'Azure DevOps', Icon: GitBranch };
    default: return { label: 'Local workspace', Icon: FolderGit2 };
  }
}

type Tab = 'cast' | 'conversation' | 'tickets' | 'gates' | 'settings';

export default function SeasonDetailPage() {
  const params = useParams();
  const router = useRouter();
  const seasonId = params.seasonId as string;

  const [season, setSeason] = useState<Season | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('cast');
  const [actionLoading, setActionLoading] = useState(false);

  const api = typeof window !== 'undefined'
    ? (window as unknown as { electronAPI: any }).electronAPI
    : null;

  useEffect(() => {
    const fetchSeason = async () => {
      if (!api) return;
      try {
        setLoading(true);
        const result = await api.season.get(seasonId);
        if (result.season) {
          setSeason(result.season);
        }
      } catch (err) {
        console.error('Failed to fetch season:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchSeason();

    if (api) {
      const unsub = api.season.onUpdated((updated: Season) => {
        if (updated.id === seasonId) {
          setSeason(updated);
        }
      });
      return () => { unsub(); };
    }
  }, [seasonId]);

  const handleArchive = async () => {
    if (!api || !season) return;
    setActionLoading(true);
    try {
      await api.season.archive(season.id);
    } catch (err) {
      console.error('Failed to archive season:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!api || !season) return;
    setActionLoading(true);
    try {
      await api.season.restore(season.id);
    } catch (err) {
      console.error('Failed to restore season:', err);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] flex items-center justify-center text-muted-foreground text-sm">
        Loading season...
      </div>
    );
  }

  if (!season) {
    return (
      <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] flex flex-col items-center justify-center text-muted-foreground">
        <p className="text-sm">Season not found</p>
        <Link href="/seasons" className="text-xs text-primary mt-2 hover:underline">
          Back to Seasons
        </Link>
      </div>
    );
  }

  const createdDate = new Date(season.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const tabs: { key: Tab; label: string; icon: typeof Users }[] = [
    { key: 'cast', label: 'Cast', icon: Users },
    { key: 'conversation', label: 'Conversation log', icon: MessagesSquare },
    {
      key: 'tickets',
      // Surface the linked Jira project right in the tab label when set.
      label: season.jiraProjectKey ? `Tickets → JIRA ${season.jiraProjectKey.toUpperCase()}` : 'Tickets',
      icon: KanbanSquare,
    },
    { key: 'gates', label: 'Review Gates', icon: Shield },
    { key: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] flex flex-col pt-4 lg:pt-6">
      {/* Back + header */}
      <div className="flex items-center gap-3 mb-4">
        <Link
          href="/seasons"
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground truncate">
              {season.name}
            </h1>
            <ThemeBadge theme={season.theme} />
          </div>
          <p className="text-muted-foreground text-xs mt-0.5">
            Created {createdDate} &middot; {season.characterIds.length} character{season.characterIds.length !== 1 ? 's' : ''}
          </p>
          {/* Source-control + Jira + context-status chips */}
          {(season.sourceControl || season.jiraProjectKey || contextStatusMeta(season.contextStatus)) && (
            <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
              {(() => {
                const meta = contextStatusMeta(season.contextStatus);
                if (!meta) return null;
                return (
                  <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${meta.className}`}>
                    {season.contextStatus === 'searching' || season.contextStatus === 'reviewing' ? (
                      <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
                    ) : (
                      <meta.Icon className="w-3 h-3 shrink-0" />
                    )}
                    <span className="font-medium">{meta.label}</span>
                  </span>
                );
              })()}
              {season.sourceControl && (() => {
                const meta = sourceControlMeta(season.sourceControl);
                return (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground max-w-full"
                    title={season.sourceControl.repoUrl || meta.label}
                  >
                    <meta.Icon className="w-3 h-3 shrink-0" />
                    <span className="font-medium text-foreground">{meta.label}</span>
                    {season.sourceControl.repoUrl && (
                      <span className="font-mono truncate max-w-[14rem]">{season.sourceControl.repoUrl}</span>
                    )}
                  </span>
                );
              })()}
              {season.jiraProjectKey && (
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground">
                  <KanbanSquare className="w-3 h-3 shrink-0" />
                  <span className="font-medium text-foreground">JIRA {season.jiraProjectKey.toUpperCase()}</span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {season.status === 'archived' ? (
            <button
              onClick={handleRestore}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Restore
            </button>
          ) : (
            <button
              onClick={handleArchive}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-secondary text-muted-foreground rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-50"
            >
              <Archive className="w-3.5 h-3.5" />
              Archive
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 mb-4 border-b border-border">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`
              flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-all border-b-2 -mb-px
              ${activeTab === tab.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
              }
            `}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto pb-4">
        {activeTab === 'cast' && <CastTab season={season} />}
        {activeTab === 'conversation' && <ConversationLogTab />}
        {activeTab === 'tickets' && <TicketsTab season={season} />}
        {activeTab === 'gates' && <GatesTab season={season} />}
        {activeTab === 'settings' && <SettingsTab season={season} />}
      </div>
    </div>
  );
}

/* ─── Cast Tab (control board) ───────────────────────────────── */

interface CastAgent {
  id: string;
  name?: string;
  canonName?: string;
  archetypeId?: string;
  status: string;
  model?: string;
  permissionMode?: 'normal' | 'auto' | 'bypass';
  output?: string[];
}

/** Strip ANSI escape codes for plain-text preview. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Human label for a season permission posture. */
function postureLabel(mode?: string): string {
  switch (mode) {
    case 'bypass': return 'Autonomous';
    case 'auto': return 'Auto-approve';
    case 'normal': return 'Approve each';
    default: return '—';
  }
}

/* ─── Context panel (brownfield ingestion) ───────────────────── */

/**
 * Surfaces the brownfield context-bootstrap state on the control board:
 *   • searching/reviewing → a live status banner explaining what's happening.
 *   • ready → a preview of the consolidated context.md plus an "Open" action.
 *   • greenfield/unset → renders nothing (no panel for new projects).
 */
function ContextPanel({ season }: { season: Season }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const api = typeof window !== 'undefined'
    ? (window as unknown as { electronAPI: any }).electronAPI
    : null;

  const status = season.contextStatus;
  const meta = contextStatusMeta(status);

  // Load a preview of context.md once it's ready and we have a path.
  useEffect(() => {
    let cancelled = false;
    if (status !== 'ready' || !season.contextPath || !api?.shell?.readFileAbs) {
      setPreview(null);
      return;
    }
    setLoadingPreview(true);
    (async () => {
      try {
        const res = await api.shell.readFileAbs({ absolutePath: season.contextPath, maxLines: 120 });
        if (cancelled) return;
        setPreview(res?.success ? (res.output || '').trim() : null);
      } catch {
        if (!cancelled) setPreview(null);
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => { cancelled = true; };
  }, [status, season.contextPath]);

  // Nothing to show for greenfield / unset seasons.
  if (!meta) return null;

  const openContext = () => {
    if (season.contextPath && api?.shell?.openPath) {
      api.shell.openPath({ path: season.contextPath });
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
          <h3 className="text-sm font-semibold text-foreground">Context</h3>
          <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${meta.className}`}>
            {status === 'searching' || status === 'reviewing' ? (
              <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
            ) : (
              <meta.Icon className="w-3 h-3 shrink-0" />
            )}
            <span className="font-medium">{meta.label}</span>
          </span>
        </div>
        {status === 'ready' && season.contextPath && (
          <button
            onClick={openContext}
            className="text-xs text-primary hover:underline shrink-0"
            title={season.contextPath}
          >
            Open context.md
          </button>
        )}
      </div>

      {status === 'searching' && (
        <p className="text-xs text-muted-foreground">
          Searching repo docs, the knowledge base, and prior seasons for existing context on this project…
        </p>
      )}

      {status === 'reviewing' && (
        <p className="text-xs text-muted-foreground">
          No prior context was found, so an onboarding code review is mapping the architecture and current
          state. It writes <span className="font-mono">docs/CODEBASE_MAP.md</span> and a season{' '}
          <span className="font-mono">context.md</span>; this panel updates to a preview when it&apos;s ready.
        </p>
      )}

      {status === 'failed' && (
        <p className="text-xs text-muted-foreground">
          The context bootstrap could not complete. The team can still proceed by exploring the repository
          directly. Check the cast output below for details.
        </p>
      )}

      {status === 'ready' && (
        <>
          {loadingPreview ? (
            <p className="text-xs text-muted-foreground">Loading context preview…</p>
          ) : preview ? (
            <pre className="mt-1 text-[11px] leading-relaxed font-mono bg-background/60 border border-border rounded p-3 max-h-60 overflow-y-auto whitespace-pre-wrap text-muted-foreground">
              {preview}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">
              Context is ready{season.contextPath ? (
                <> at <span className="font-mono">{season.contextPath}</span></>
              ) : null}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function CastTab({ season }: { season: Season }) {
  const [agents, setAgents] = useState<Record<string, CastAgent>>({});
  // Per-agent rolling output buffer (live PTY stream).
  const outputs = useRef<Record<string, string>>({});
  const [, forceRender] = useState(0);

  const api = typeof window !== 'undefined'
    ? (window as unknown as { electronAPI: any }).electronAPI
    : null;

  useEffect(() => {
    if (!api?.agent) return;
    let cancelled = false;

    // Load the cast agents (characterIds are now real agent ids).
    (async () => {
      try {
        const all: CastAgent[] = await api.agent.list();
        if (cancelled) return;
        const map: Record<string, CastAgent> = {};
        for (const a of all) {
          if (season.characterIds.includes(a.id)) {
            map[a.id] = a;
            outputs.current[a.id] = (a.output || []).join('');
          }
        }
        setAgents(map);
      } catch (err) {
        console.error('Failed to load cast agents:', err);
      }
    })();

    // Subscribe to the already-firing PTY broadcasts (no new IPC).
    const unsubOutput = api.agent.onOutput((event: { agentId: string; data: string }) => {
      if (!season.characterIds.includes(event.agentId)) return;
      const prev = outputs.current[event.agentId] || '';
      // Keep a bounded tail so the DOM stays light.
      outputs.current[event.agentId] = (prev + event.data).slice(-4000);
      forceRender(n => n + 1);
    });

    const unsubStatus = api.agent.onStatus((event: { agentId: string; status: string }) => {
      if (!season.characterIds.includes(event.agentId)) return;
      setAgents(prev => {
        const existing = prev[event.agentId];
        if (!existing) return prev;
        return { ...prev, [event.agentId]: { ...existing, status: event.status } };
      });
    });

    return () => {
      cancelled = true;
      unsubOutput?.();
      unsubStatus?.();
    };
  }, [season.characterIds.join(',')]);

  if (season.characterIds.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
        <Users className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-sm">No cast members in this season</p>
        <p className="text-xs mt-1">The team is auto-composed and cast when the season is spawned</p>
      </div>
    );
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'running': return 'bg-green-500';
      case 'waiting': return 'bg-yellow-500';
      case 'completed': return 'bg-blue-500';
      case 'error': return 'bg-red-500';
      default: return 'bg-muted-foreground/40';
    }
  };

  return (
    <div className="space-y-3">
      {/* Brownfield context bootstrap status + context.md preview. */}
      <ContextPanel season={season} />

      {/* Cast header: surface the season's source-control + Jira linkage. */}
      {(season.sourceControl || season.jiraProjectKey) && (
        <div className="flex items-center flex-wrap gap-2 text-xs text-muted-foreground bg-card border border-border rounded-lg px-3 py-2">
          {season.sourceControl && (() => {
            const meta = sourceControlMeta(season.sourceControl);
            return (
              <span className="inline-flex items-center gap-1.5 min-w-0" title={season.sourceControl.repoUrl || meta.label}>
                <meta.Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="font-medium text-foreground">{meta.label}</span>
                {season.sourceControl.repoUrl && (
                  <span className="font-mono truncate max-w-[18rem]">{season.sourceControl.repoUrl}</span>
                )}
              </span>
            );
          })()}
          {season.sourceControl && season.jiraProjectKey && <span className="text-muted-foreground/40">·</span>}
          {season.jiraProjectKey && (
            <span className="inline-flex items-center gap-1.5">
              <KanbanSquare className="w-3.5 h-3.5 shrink-0" />
              <span className="font-medium text-foreground">JIRA {season.jiraProjectKey.toUpperCase()}</span>
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {season.characterIds.map(charId => {
        const agent = agents[charId];
        const label = agent?.canonName || agent?.name || charId;
        const tail = stripAnsi(outputs.current[charId] || '').trim();
        return (
          <div
            key={charId}
            className="bg-card border border-border rounded-lg p-4 hover:border-primary/30 transition-colors flex flex-col"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <Users className="w-4 h-4 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">{label}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {agent?.archetypeId || 'Character'}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${statusColor(agent?.status || 'idle')}`} />
                <span className="text-xs text-muted-foreground capitalize">{agent?.status || 'idle'}</span>
              </div>
            </div>
            {/* Model + posture chips */}
            <div className="flex items-center flex-wrap gap-1.5 mb-2">
              {agent?.model && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">
                  {agent.model}
                </span>
              )}
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">
                {postureLabel(agent?.permissionMode)}
              </span>
            </div>
            <pre className="text-[10px] leading-relaxed font-mono bg-background/60 border border-border rounded p-2 h-32 overflow-y-auto whitespace-pre-wrap text-muted-foreground">
              {tail || 'Waiting for output…'}
            </pre>
          </div>
        );
      })}
      </div>
    </div>
  );
}

/* ─── Conversation Log Tab (next build placeholder) ──────────── */

function ConversationLogTab() {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
      <MessagesSquare className="w-8 h-8 mb-2 opacity-50" />
      <p className="text-sm">Conversation log</p>
      <p className="text-xs mt-1">Agent crosstalk + convener coordination stream lands in the next build</p>
    </div>
  );
}

/* ─── Tickets Tab (next build placeholder) ───────────────────── */

function TicketsTab({ season }: { season: Season }) {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
      <KanbanSquare className="w-8 h-8 mb-2 opacity-50" />
      {season.jiraProjectKey ? (
        <>
          <p className="text-sm">
            Linked to JIRA <span className="font-mono text-foreground">{season.jiraProjectKey.toUpperCase()}</span>
          </p>
          <p className="text-xs mt-1">Ticket sync with this Jira project lands in the next build</p>
        </>
      ) : (
        <>
          <p className="text-sm">Tickets</p>
          <p className="text-xs mt-1">The Jira-style kanban of season tasks lands in the next build</p>
        </>
      )}
    </div>
  );
}

/* ─── Review Gates Tab ───────────────────────────────────────── */

function GatesTab({ season }: { season: Season }) {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
      <Shield className="w-8 h-8 mb-2 opacity-50" />
      <p className="text-sm">Review gates are not yet configured</p>
      <p className="text-xs mt-1">Gates define quality checkpoints for season outputs</p>
    </div>
  );
}

/* ─── Settings Tab ───────────────────────────────────────────── */

function SettingsTab({ season }: { season: Season }) {
  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">Season Details</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">ID</span>
            <span className="text-foreground font-mono text-xs">{season.id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <span className="text-foreground capitalize">{season.status}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Theme</span>
            <span className="text-foreground">{season.theme}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Intake</span>
            <span className="text-foreground capitalize">
              {season.intake === 'brownfield' ? 'Existing project (in flight)' : 'New project'}
            </span>
          </div>
          {contextStatusMeta(season.contextStatus) && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Context</span>
              <span className="text-foreground">{contextStatusMeta(season.contextStatus)!.label}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Source control</span>
            <span className="text-foreground flex items-center gap-1.5 min-w-0">
              {(() => {
                const meta = sourceControlMeta(season.sourceControl);
                return <meta.Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />;
              })()}
              <span>{sourceControlMeta(season.sourceControl).label}</span>
              {season.sourceControl?.repoUrl && (
                <span
                  className="font-mono text-xs text-muted-foreground truncate max-w-[14rem]"
                  title={season.sourceControl.repoUrl}
                >
                  {season.sourceControl.repoUrl}
                </span>
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Jira project</span>
            <span className="text-foreground">
              {season.jiraProjectKey ? (
                <span className="font-mono">{season.jiraProjectKey.toUpperCase()}</span>
              ) : (
                <span className="text-muted-foreground">Not linked</span>
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Workspace</span>
            <span className="text-foreground font-mono text-xs truncate max-w-[60%]" title={season.workspacePath}>
              {season.workspacePath}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Roster Manifest</span>
            <span className="text-foreground font-mono text-xs truncate max-w-[60%]" title={season.rosterManifestPath}>
              {season.rosterManifestPath}
            </span>
          </div>
          {season.archivedAt && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Archived</span>
              <span className="text-foreground">
                {new Date(season.archivedAt).toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

