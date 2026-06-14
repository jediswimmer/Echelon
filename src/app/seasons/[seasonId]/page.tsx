'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Users, Shield, Settings, Archive, RotateCcw, MessagesSquare, KanbanSquare, Github, GitBranch, FolderGit2, FolderSearch, FileText, Loader2, Search, ScanSearch, CheckCircle2, AlertTriangle, Compass, UserCog, Bot } from 'lucide-react';
import ThemeBadge from '@/components/Echelon/ThemeBadge';
import KanbanBoard from '@/components/KanbanBoard';
import ConversationLogTab from './ConversationLogTab';
import Link from 'next/link';

interface SeasonSourceControl {
  type: 'local' | 'github' | 'azure-devops' | 'local-clone';
  repoUrl?: string;
  /** Absolute path to the adopted existing clone (only for `local-clone`). */
  localPath?: string;
}

type SeasonIntake = 'greenfield' | 'brownfield';
type SeasonContextStatus = 'greenfield' | 'searching' | 'reviewing' | 'ready' | 'failed';
type SeasonMode = 'autonomous' | 'collaborative';

/** One human-owned seat in a collaborative season (#22a). */
interface HumanSeat {
  id: string;
  archetypeId: string;
  roleName?: string;
  source: 'github' | 'jira' | 'manual';
  handle: string;
  displayName?: string;
}

interface SeasonDirectionOption {
  id: string;
  title: string;
  kind: 'epic' | 'story';
}

interface SeasonDirectionRequest {
  id: string;
  question: string;
  options: SeasonDirectionOption[];
  status: 'open' | 'answered';
  answer?: string;
  chosenOptionId?: string;
  createdAt: string;
  answeredAt?: string;
}

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
  /** PM grooming completed timestamp (17c). */
  groomedAt?: string;
  /** Pending "needs your direction" prompt for brownfield seasons (17c). */
  directionRequest?: SeasonDirectionRequest;
  /** Operating mode (#22a): autonomous (default) vs collaborative. */
  mode?: SeasonMode;
  /** Human hybrid dev team (#22a) — populated in collaborative mode. */
  humanTeam?: { seats: HumanSeat[] };
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
    case 'local-clone': return { label: 'Local clone', Icon: FolderSearch };
    default: return { label: 'Local workspace', Icon: FolderGit2 };
  }
}

/**
 * The displayable location for a source-control linkage: the repo URL for
 * remote clones, or the adopted folder path for an existing local clone.
 */
function sourceControlLocation(sc?: SeasonSourceControl): string | undefined {
  return sc?.type === 'local-clone' ? sc.localPath : sc?.repoUrl;
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
                const location = sourceControlLocation(season.sourceControl);
                return (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground max-w-full"
                    title={location || meta.label}
                  >
                    <meta.Icon className="w-3 h-3 shrink-0" />
                    <span className="font-medium text-foreground">{meta.label}</span>
                    {location && (
                      <span className="font-mono truncate max-w-[14rem]">{location}</span>
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

      {/* Direction request (17c): the team needs the user to pick a starting point. */}
      <DirectionCard season={season} />

      {/* Season mode (#22a): autonomous vs collaborative + the human-team panel. */}
      <SeasonModeCard season={season} />

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
        {activeTab === 'conversation' && (
          <ConversationLogTab seasonId={season.id} characterIds={season.characterIds} />
        )}
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

/* ─── Direction card (17c — brownfield "needs your direction") ── */

/**
 * Prominent prompt shown when a brownfield season's PM has reviewed the repo and
 * needs the user to pick the first Epic/Story to tackle. The user selects a
 * candidate (or types free-text) and submits; on answer the season broadcasts an
 * update and this card collapses to a "Working on: …" confirmation.
 */
function DirectionCard({ season }: { season: Season }) {
  const request = season.directionRequest;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [freeText, setFreeText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const api = typeof window !== 'undefined'
    ? (window as unknown as { electronAPI: any }).electronAPI
    : null;

  if (!request) return null;

  // Answered → a compact confirmation of what the team was directed to start.
  if (request.status === 'answered') {
    const chosen = request.options.find(o => o.id === request.chosenOptionId);
    const startedLabel = chosen?.title || request.answer;
    if (!startedLabel) return null;
    return (
      <div className="mb-4 bg-card border border-border rounded-lg p-3 flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
        <span className="text-sm text-muted-foreground">
          Working on: <span className="font-medium text-foreground">{startedLabel}</span>
        </span>
      </div>
    );
  }

  const submit = async () => {
    if (!api?.season?.direction?.answer || submitting) return;
    const answer = freeText.trim() || undefined;
    if (!selectedId && !answer) return;
    setSubmitting(true);
    try {
      await api.season.direction.answer(season.id, {
        chosenOptionId: selectedId || undefined,
        answer,
      });
      // The card collapses when the `season:updated` broadcast flips status to
      // 'answered'; no local state change needed.
    } catch (err) {
      console.error('Failed to submit direction:', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mb-4 bg-card border border-primary/40 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <Compass className="w-4 h-4 text-primary shrink-0" />
        <h3 className="text-sm font-semibold text-foreground">Team needs your direction</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-3">{request.question}</p>

      <div className="space-y-1.5 mb-3">
        {request.options.map(opt => (
          <button
            key={opt.id}
            type="button"
            onClick={() => { setSelectedId(opt.id); setFreeText(''); }}
            className={`
              w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors
              ${selectedId === opt.id
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground hover:border-primary/30'
              }
            `}
          >
            <span className="text-[10px] uppercase font-medium px-1.5 py-0.5 rounded bg-secondary border border-border shrink-0">
              {opt.kind}
            </span>
            <span className="truncate">{opt.title}</span>
          </button>
        ))}
      </div>

      <input
        type="text"
        value={freeText}
        onChange={e => { setFreeText(e.target.value); if (e.target.value) setSelectedId(null); }}
        placeholder="…or describe a different starting point"
        className="w-full mb-3 px-3 py-2 text-sm rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
      />

      <button
        type="button"
        onClick={submit}
        disabled={submitting || (!selectedId && !freeText.trim())}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Compass className="w-3.5 h-3.5" />}
        Start the team
      </button>
    </div>
  );
}

/* ─── Season mode + human team (#22a) ────────────────────────── */

/** A role derived from the season's cast (one per archetype). */
interface SeasonRole {
  archetypeId: string;
  roleName: string;
}

interface HumanTeamCandidates {
  github: Array<{ login: string; name?: string }>;
  jira: Array<{ accountId: string; displayName: string; email?: string }>;
  reasons: { github?: string; jira?: string };
}

/**
 * Prominent card with the Autonomous ⟷ Collaborative segmented switch (bound to
 * `season.mode`, default autonomous). In Collaborative mode it renders the
 * {@link HumanTeamPanel} to map real GitHub/Jira users onto roles. In Autonomous
 * mode it notes that fully-autonomous scheduling (usage windows + cron) lands
 * with #18 (no cron is built here).
 */
function SeasonModeCard({ season }: { season: Season }) {
  const api = typeof window !== 'undefined'
    ? (window as unknown as { electronAPI: any }).electronAPI
    : null;

  const mode: SeasonMode = season.mode ?? 'autonomous';
  const [switching, setSwitching] = useState(false);

  const setMode = async (next: SeasonMode) => {
    if (!api?.season?.mode?.set || switching || next === mode) return;
    setSwitching(true);
    try {
      await api.season.mode.set(season.id, next);
      // The `season:updated` broadcast re-renders with the new mode.
    } catch (err) {
      console.error('Failed to set season mode:', err);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="mb-4 bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          {mode === 'collaborative' ? (
            <UserCog className="w-4 h-4 text-primary shrink-0" />
          ) : (
            <Bot className="w-4 h-4 text-primary shrink-0" />
          )}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Team mode</h3>
            <p className="text-xs text-muted-foreground">
              {mode === 'collaborative'
                ? 'A human hybrid dev team works alongside the agents.'
                : 'The agent team runs the show.'}
            </p>
          </div>
        </div>

        {/* Segmented Autonomous ⟷ Collaborative switch. */}
        <div className="inline-flex items-center rounded-lg border border-border bg-secondary/40 p-0.5 shrink-0">
          {(['autonomous', 'collaborative'] as const).map(opt => {
            const active = mode === opt;
            const Icon = opt === 'collaborative' ? UserCog : Bot;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setMode(opt)}
                disabled={switching}
                className={`
                  flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50
                  ${active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                  }
                `}
              >
                {switching && active ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
                {opt === 'collaborative' ? 'Collaborative' : 'Autonomous'}
              </button>
            );
          })}
        </div>
      </div>

      {mode === 'autonomous' ? (
        <p className="mt-3 text-[11px] text-muted-foreground border-t border-border pt-3">
          Fully-autonomous scheduling (usage windows + cron) lands with #18.
        </p>
      ) : (
        <HumanTeamPanel season={season} />
      )}
    </div>
  );
}

/**
 * Collaborative-mode panel (#22a): lists the season's roles (derived from the
 * cast), shows whether each is Agent-run or Human-run, and lets the user assign a
 * human per role from GitHub/Jira candidates (or a manual handle). "Save team"
 * persists the seats via `season.humanTeam.set`; human-owned roles' agents are
 * stopped backend-side, and the summary reflects human vs agent counts.
 */
function HumanTeamPanel({ season }: { season: Season }) {
  const api = typeof window !== 'undefined'
    ? (window as unknown as { electronAPI: any }).electronAPI
    : null;

  const [roles, setRoles] = useState<SeasonRole[]>([]);
  const [candidates, setCandidates] = useState<HumanTeamCandidates | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [saving, setSaving] = useState(false);

  // archetypeId → the chosen seat (or undefined ⇒ agent-run). Seeded from the
  // season's persisted humanTeam, then edited locally until "Save team".
  const [assignments, setAssignments] = useState<Record<string, HumanSeat | undefined>>({});
  // Per-role free-text manual handle entry (only applied if no picker choice).
  const [manualHandles, setManualHandles] = useState<Record<string, string>>({});

  // Derive the roles from the cast agents (one entry per archetype).
  useEffect(() => {
    if (!api?.agent?.list) return;
    let cancelled = false;
    (async () => {
      try {
        const all: Array<{ id: string; archetypeId?: string; canonName?: string; name?: string }> =
          await api.agent.list();
        if (cancelled) return;
        const byArchetype = new Map<string, SeasonRole>();
        for (const a of all) {
          if (!season.characterIds.includes(a.id)) continue;
          const archetypeId = a.archetypeId;
          if (!archetypeId) continue;
          if (!byArchetype.has(archetypeId)) {
            byArchetype.set(archetypeId, { archetypeId, roleName: a.canonName || a.name || archetypeId });
          }
        }
        // Also surface any human-owned archetype that no longer has a cast agent
        // (its agent was stopped) so the role stays visible + reassignable.
        for (const seat of season.humanTeam?.seats ?? []) {
          if (!byArchetype.has(seat.archetypeId)) {
            byArchetype.set(seat.archetypeId, {
              archetypeId: seat.archetypeId,
              roleName: seat.roleName || seat.archetypeId,
            });
          }
        }
        setRoles(Array.from(byArchetype.values()));
      } catch (err) {
        console.error('Failed to derive season roles:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [season.characterIds.join(','), (season.humanTeam?.seats ?? []).length]);

  // Seed local assignments from the persisted human team.
  useEffect(() => {
    const seeded: Record<string, HumanSeat | undefined> = {};
    for (const seat of season.humanTeam?.seats ?? []) {
      seeded[seat.archetypeId] = seat;
    }
    setAssignments(seeded);
  }, [season.id, (season.humanTeam?.seats ?? []).map(s => `${s.archetypeId}:${s.handle}`).join(',')]);

  // Fetch GitHub/Jira candidates once (best-effort).
  useEffect(() => {
    if (!api?.season?.humanTeam?.candidates) return;
    let cancelled = false;
    setLoadingCandidates(true);
    (async () => {
      try {
        const res: HumanTeamCandidates = await api.season.humanTeam.candidates(season.id);
        if (!cancelled) setCandidates(res);
      } catch (err) {
        console.error('Failed to fetch human-team candidates:', err);
        if (!cancelled) {
          setCandidates({ github: [], jira: [], reasons: { github: 'Fetch failed.', jira: 'Fetch failed.' } });
        }
      } finally {
        if (!cancelled) setLoadingCandidates(false);
      }
    })();
    return () => { cancelled = true; };
  }, [season.id]);

  // Apply a picker selection (value format: "github:<login>" / "jira:<accountId>" / "").
  const assignFromPicker = (role: SeasonRole, value: string) => {
    setManualHandles(prev => ({ ...prev, [role.archetypeId]: '' }));
    if (!value) {
      setAssignments(prev => ({ ...prev, [role.archetypeId]: undefined }));
      return;
    }
    const [source, key] = value.split(/:(.+)/) as ['github' | 'jira', string];
    let seat: HumanSeat | undefined;
    if (source === 'github') {
      const c = candidates?.github.find(g => g.login === key);
      if (c) {
        seat = { id: makeId(), archetypeId: role.archetypeId, roleName: role.roleName, source: 'github', handle: c.login, displayName: c.name || c.login };
      }
    } else if (source === 'jira') {
      const c = candidates?.jira.find(j => j.accountId === key);
      if (c) {
        seat = { id: makeId(), archetypeId: role.archetypeId, roleName: role.roleName, source: 'jira', handle: c.accountId, displayName: c.displayName };
      }
    }
    if (seat) setAssignments(prev => ({ ...prev, [role.archetypeId]: seat }));
  };

  const setManual = (role: SeasonRole, handle: string) => {
    setManualHandles(prev => ({ ...prev, [role.archetypeId]: handle }));
    const trimmed = handle.trim();
    setAssignments(prev => ({
      ...prev,
      [role.archetypeId]: trimmed
        ? { id: prev[role.archetypeId]?.id || makeId(), archetypeId: role.archetypeId, roleName: role.roleName, source: 'manual', handle: trimmed, displayName: trimmed }
        : undefined,
    }));
  };

  const humanCount = roles.filter(r => assignments[r.archetypeId]).length;
  const agentCount = roles.length - humanCount;

  const saveTeam = async () => {
    if (!api?.season?.humanTeam?.set || saving) return;
    setSaving(true);
    try {
      const seats: HumanSeat[] = roles
        .map(r => assignments[r.archetypeId])
        .filter((s): s is HumanSeat => Boolean(s));
      await api.season.humanTeam.set(season.id, seats);
      // The `season:updated` broadcast re-seeds the panel.
    } catch (err) {
      console.error('Failed to save human team:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-muted-foreground" />
          Human team
        </h4>
        <span className="text-[11px] text-muted-foreground">
          <span className="text-foreground font-medium">{humanCount}</span> seat{humanCount === 1 ? '' : 's'} human-run,{' '}
          <span className="text-foreground font-medium">{agentCount}</span> agent-run
        </span>
      </div>

      {roles.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No roles to populate yet — the cast is assigned when the season spawns.
        </p>
      ) : (
        <>
          {/* Source-availability hints (best-effort fetch). */}
          {candidates && (candidates.reasons.github || candidates.reasons.jira) && (
            <div className="mb-2 space-y-0.5">
              {candidates.reasons.github && (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Github className="w-3 h-3 shrink-0" /> {candidates.reasons.github}
                </p>
              )}
              {candidates.reasons.jira && (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <KanbanSquare className="w-3 h-3 shrink-0" /> {candidates.reasons.jira}
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            {roles.map(role => {
              const seat = assignments[role.archetypeId];
              const isHuman = Boolean(seat);
              const pickerValue = seat?.source === 'github'
                ? `github:${seat.handle}`
                : seat?.source === 'jira'
                  ? `jira:${seat.handle}`
                  : '';
              return (
                <div
                  key={role.archetypeId}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border bg-secondary/30 flex-wrap"
                >
                  <span className="flex items-center gap-1.5 min-w-0 flex-1">
                    {isHuman ? (
                      <UserCog className="w-3.5 h-3.5 text-primary shrink-0" />
                    ) : (
                      <Bot className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="text-xs text-foreground truncate" title={role.archetypeId}>
                      {role.roleName}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 border ${isHuman ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-secondary text-muted-foreground'}`}>
                      {isHuman ? 'Human-run' : 'Agent-run'}
                    </span>
                  </span>

                  {/* Candidate picker (GitHub + Jira, grouped). */}
                  <select
                    value={pickerValue}
                    onChange={e => assignFromPicker(role, e.target.value)}
                    disabled={loadingCandidates}
                    className="text-[11px] px-2 py-1 rounded-md bg-background border border-border text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50 max-w-[12rem]"
                  >
                    <option value="">Agent-run</option>
                    {candidates && candidates.github.length > 0 && (
                      <optgroup label="GitHub">
                        {candidates.github.map(g => (
                          <option key={`gh-${g.login}`} value={`github:${g.login}`}>
                            {g.name ? `${g.name} (@${g.login})` : `@${g.login}`}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {candidates && candidates.jira.length > 0 && (
                      <optgroup label="Jira">
                        {candidates.jira.map(j => (
                          <option key={`jira-${j.accountId}`} value={`jira:${j.accountId}`}>
                            {j.email ? `${j.displayName} (${j.email})` : j.displayName}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>

                  {/* Manual handle entry (used when no picker choice). */}
                  <input
                    type="text"
                    value={manualHandles[role.archetypeId] ?? (seat?.source === 'manual' ? seat.handle : '')}
                    onChange={e => setManual(role, e.target.value)}
                    placeholder="or handle…"
                    className="text-[11px] px-2 py-1 rounded-md bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 w-28"
                  />
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2 mt-3">
            <button
              type="button"
              onClick={saveTeam}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Users className="w-3.5 h-3.5" />}
              Save team
            </button>
            {loadingCandidates && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading candidates…
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Best-effort id for a new seat (crypto.randomUUID when available). */
function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `seat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
            const location = sourceControlLocation(season.sourceControl);
            return (
              <span className="inline-flex items-center gap-1.5 min-w-0" title={location || meta.label}>
                <meta.Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="font-medium text-foreground">{meta.label}</span>
                {location && (
                  <span className="font-mono truncate max-w-[18rem]">{location}</span>
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

/* ─── Conversation Log Tab — see ./ConversationLogTab.tsx (17b) ─── */

/* ─── Tickets Tab (season-scoped kanban board) ───────────────── */

function TicketsTab({ season }: { season: Season }) {
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Linked-Jira chip (preserved from the prior placeholder). */}
      {season.jiraProjectKey && (
        <div className="mb-2 shrink-0">
          <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground">
            <KanbanSquare className="w-3 h-3 shrink-0" />
            <span>Linked to JIRA <span className="font-mono text-foreground">{season.jiraProjectKey.toUpperCase()}</span></span>
          </span>
        </div>
      )}
      {/* Season-scoped, lock the board to this season's tickets. Pass the linked
          Jira project key (17d) so the board can offer a "Sync Jira" action. */}
      <div className="flex-1 min-h-0">
        <KanbanBoard seasonId={season.id} lockScope jiraProjectKey={season.jiraProjectKey} />
      </div>
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
              {sourceControlLocation(season.sourceControl) && (
                <span
                  className="font-mono text-xs text-muted-foreground truncate max-w-[14rem]"
                  title={sourceControlLocation(season.sourceControl)}
                >
                  {sourceControlLocation(season.sourceControl)}
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

