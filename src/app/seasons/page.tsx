'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, RefreshCw, X, Loader2, ChevronDown, ChevronRight, ShieldCheck, ShieldAlert, ShieldOff, FolderGit2, Github, GitBranch, Sparkles, History, AlertTriangle, FolderSearch, FolderOpen } from 'lucide-react';
import SeasonCard from '@/components/Echelon/SeasonCard';

interface Season {
  id: string;
  name: string;
  theme: string;
  status: string;
  characterIds: string[];
  createdAt: string;
  archivedAt?: string;
}

interface RosterEntryDraft {
  archetype: string;
  character: string;
}

type FilterTab = 'all' | 'active' | 'archived';

/** Season-wide permission posture, chosen at kickoff. Maps to permissionMode. */
type PermissionPosture = 'normal' | 'auto' | 'bypass';

interface PostureOption {
  value: PermissionPosture;
  label: string;
  caption: string;
  Icon: typeof ShieldCheck;
}

/**
 * How the season is started:
 *   • `greenfield` — a brand-new project; the PRD describes what to build.
 *   • `brownfield` — an existing, in-flight project found in a linked repo; the
 *     team bootstraps its context from that repo on spawn.
 */
type IntakeMode = 'greenfield' | 'brownfield';

interface IntakeOption {
  value: IntakeMode;
  label: string;
  caption: string;
  Icon: typeof Sparkles;
}

const INTAKE_OPTIONS: IntakeOption[] = [
  {
    value: 'greenfield',
    label: 'New project',
    caption: 'Start from scratch. Describe what the team should build.',
    Icon: Sparkles,
  },
  {
    value: 'brownfield',
    label: 'Existing project (in flight)',
    caption: 'Pick up an existing repo. The team searches for context, then reviews the code if none is found.',
    Icon: History,
  },
];

/** Where the season workspace lives / is linked to (chosen at kickoff). */
type SourceControlMode = 'local' | 'github' | 'azure-devops' | 'local-clone';

interface SourceControlOption {
  value: SourceControlMode;
  label: string;
  caption: string;
  Icon: typeof FolderGit2;
  /** Placeholder for the repo identifier input (only shown for github/azdo). */
  repoPlaceholder?: string;
}

const SOURCE_CONTROL_OPTIONS: SourceControlOption[] = [
  {
    value: 'local',
    label: 'Local workspace only',
    caption: 'Echelon creates a fresh empty git repo for the season (default).',
    Icon: FolderGit2,
  },
  {
    value: 'github',
    label: 'GitHub repo',
    caption: 'Clone a GitHub repo as the season workspace (uses your gh auth).',
    Icon: Github,
    repoPlaceholder: 'owner/repo or https://github.com/owner/repo',
  },
  {
    value: 'azure-devops',
    label: 'Azure DevOps repo',
    caption: 'Clone an Azure DevOps repo via git (uses your git credentials).',
    Icon: GitBranch,
    repoPlaceholder: 'https://dev.azure.com/org/project/_git/repo',
  },
  {
    value: 'local-clone',
    label: 'Existing local clone',
    caption:
      'Point at a repo you’ve already cloned; Echelon validates it and works in isolated worktrees off it (your working copy is untouched).',
    Icon: FolderSearch,
  },
];

const PERMISSION_OPTIONS: PostureOption[] = [
  {
    value: 'normal',
    label: 'Approve each action',
    caption: 'Agents pause for your approval before every tool action.',
    Icon: ShieldCheck,
  },
  {
    value: 'auto',
    label: 'Approve once at kickoff',
    caption: 'Agents accept edits for this season after a single kickoff approval.',
    Icon: ShieldAlert,
  },
  {
    value: 'bypass',
    label: 'Autonomous for this season',
    caption:
      'Agents act without per-action approval; review gates + isolated worktrees are the safety layer.',
    Icon: ShieldOff,
  },
];

/**
 * Advanced-override default roster. The DEFAULT spawn path is the PRD chat,
 * which auto-composes the roster; this seed is only shown when a power user
 * opens "Advanced: edit roster". Characters exist under
 * src/team-factory/themes/tbbt/characters/.
 */
const DEFAULT_TBBT_ROSTER: RosterEntryDraft[] = [
  { archetype: 'counselor-convener', character: 'stephen-hawking' },
  { archetype: 'ingestion-pm', character: 'penny' },
  { archetype: 'user-handler', character: 'leonard-hofstadter' },
  { archetype: 'principal-architect', character: 'sheldon-cooper' },
  { archetype: 'backend-engineer', character: 'stuart-bloom' },
];

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `season-${Date.now()}`;
}

export default function SeasonsPage() {
  const router = useRouter();
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [showNewSeason, setShowNewSeason] = useState(false);

  const fetchSeasons = async () => {
    try {
      setLoading(true);
      const api = (window as unknown as { electronAPI: any }).electronAPI;
      if (!api?.season) { setSeasons([]); return; }
      const result = await api.season.list();
      setSeasons(result.seasons || []);
    } catch (err) {
      console.error('Failed to fetch seasons:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSeasons();

    // Subscribe to season updates
    const api = (window as unknown as { electronAPI: any }).electronAPI;
    if (!api?.season) return;
    const unsub = api.season.onUpdated((season: Season) => {
      setSeasons(prev => {
        const idx = prev.findIndex(s => s.id === season.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = season;
          return next;
        }
        return [season, ...prev];
      });
    });

    return () => { unsub(); };
  }, []);

  const filtered = seasons.filter(s => {
    if (filter === 'active') return s.status !== 'archived';
    if (filter === 'archived') return s.status === 'archived';
    return true;
  });

  const filterTabs: { key: FilterTab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: seasons.length },
    { key: 'active', label: 'Active', count: seasons.filter(s => s.status !== 'archived').length },
    { key: 'archived', label: 'Archived', count: seasons.filter(s => s.status === 'archived').length },
  ];

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] flex flex-col pt-4 lg:pt-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 lg:mb-6">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">Seasons</h1>
          <p className="text-muted-foreground text-xs lg:text-sm mt-1 hidden sm:block">
            Manage character rosters and themed agent ensembles
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewSeason(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity"
            title="Spawn a new season"
          >
            <Plus className="w-4 h-4" />
            New Season
          </button>
          <button
            onClick={fetchSeasons}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {showNewSeason && (
        <NewSeasonModal
          onClose={() => setShowNewSeason(false)}
          onSpawned={(seasonId) => {
            setShowNewSeason(false);
            fetchSeasons();
            // Land the user on the season control board.
            router.push(`/seasons/${seasonId}`);
          }}
        />
      )}

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-2">
        {filterTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`
              flex items-center gap-2 px-3 py-2 text-sm font-medium transition-all whitespace-nowrap
              ${filter === tab.key
                ? 'bg-foreground text-background'
                : 'bg-secondary text-muted-foreground hover:text-foreground border border-border'
              }
            `}
          >
            {tab.label}
            <span className={`text-xs ${filter === tab.key ? 'text-background/70' : 'text-muted-foreground/60'}`}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && seasons.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
            Loading seasons...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
            <p className="text-sm">No seasons found</p>
            <p className="text-xs mt-1">Seasons are spawned through the Echelon roster system</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-4">
            {filtered.map(season => (
              <SeasonCard key={season.id} season={season} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── New Season Modal ───────────────────────────────────────── */

/**
 * The kickoff flow. DEFAULT path: describe the work (PRD chat) → the team is
 * AUTO-COMPOSED on spawn. The user picks the season permission posture. An
 * "Advanced: edit roster" override reveals the legacy archetype→character
 * editor for power users; when it has rows, those are sent verbatim and the
 * composer is bypassed.
 */
function NewSeasonModal({
  onClose,
  onSpawned,
}: {
  onClose: () => void;
  onSpawned: (seasonId: string) => void;
}) {
  const [name, setName] = useState('');
  const [theme, setTheme] = useState('tbbt');
  const [intake, setIntake] = useState<IntakeMode>('greenfield');
  const [prd, setPrd] = useState('');
  const [posture, setPosture] = useState<PermissionPosture>('normal');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [roster, setRoster] = useState<RosterEntryDraft[]>(DEFAULT_TBBT_ROSTER);
  // Source control + Jira linkage (optional, secondary to the PRD chat).
  const [showLinks, setShowLinks] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceControlMode>('local');
  const [repoUrl, setRepoUrl] = useState('');
  /** Folder path for the "Existing local clone" source-control mode. */
  const [localClonePath, setLocalClonePath] = useState('');
  const [jiraProjectKey, setJiraProjectKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateRow = (idx: number, field: keyof RosterEntryDraft, value: string) => {
    setRoster(prev => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  };
  const addRow = () => setRoster(prev => [...prev, { archetype: '', character: '' }]);
  const removeRow = (idx: number) => setRoster(prev => prev.filter((_, i) => i !== idx));

  /** Open the native folder picker to choose an existing local clone. */
  const browseForLocalClone = async () => {
    const api = (window as unknown as {
      electronAPI?: { dialog?: { openFolder: () => Promise<string | null> } };
    }).electronAPI;
    if (!api?.dialog?.openFolder) {
      setError('Folder picker unavailable (not running in Electron). Type the clone path instead.');
      return;
    }
    const picked = await api.dialog.openFolder();
    if (picked) setLocalClonePath(picked);
  };

  const handleSubmit = async () => {
    setError(null);

    if (!name.trim()) { setName(name); setError('Season name is required.'); return; }
    if (!theme.trim()) { setError('Theme is required.'); return; }

    // Advanced override: explicit roster wins. Otherwise the PRD auto-composes.
    const cleanRoster = showAdvanced
      ? roster
          .map(r => ({ archetype: r.archetype.trim(), character: r.character.trim() }))
          .filter(r => r.archetype && r.character)
      : [];

    if (cleanRoster.length === 0 && !prd.trim()) {
      setError(
        intake === 'brownfield'
          ? 'Give the current status of the in-flight project so the roster can be composed (or open Advanced to set one manually).'
          : 'Describe what this team should build so the roster can be composed (or open Advanced to set one manually).',
      );
      return;
    }

    // A non-local source-control mode requires a repo identifier.
    const trimmedRepo = repoUrl.trim();
    if (sourceMode !== 'local' && !trimmedRepo) {
      setError(
        sourceMode === 'github'
          ? 'Enter the GitHub repo (owner/repo or URL) to clone as the workspace, or switch to Local.'
          : 'Enter the Azure DevOps repo URL to clone as the workspace, or switch to Local.',
      );
      return;
    }

    // Existing-project intake needs a repo to ingest. Block (with a clear ask)
    // when brownfield is chosen but source control is still local-only.
    if (intake === 'brownfield' && sourceMode === 'local') {
      setError(
        'Existing project (in flight) needs a linked repo to bootstrap context from. Link a GitHub or Azure DevOps repo under "Source control & Jira", or switch to New project.',
      );
      return;
    }

    const api = (window as unknown as { electronAPI?: { season?: { spawn: (c: unknown) => Promise<{ success: boolean; error?: string; season?: { id: string } }> } } }).electronAPI;
    if (!api?.season) { setError('Season API unavailable (not running in Electron).'); return; }

    setSubmitting(true);
    try {
      const id = `${slugify(name)}-${Date.now().toString(36)}`;
      const result = await api.season.spawn({
        id,
        name: name.trim(),
        theme: theme.trim(),
        prd: prd.trim() || undefined,
        permissionMode: posture,
        // Only send a roster when Advanced is on and populated; empty ⇒ auto-compose.
        rosterEntries: cleanRoster.length > 0
          ? cleanRoster.map(r => ({ ...r, capabilities: [] }))
          : undefined,
        // Source control: only link when a non-local mode + repo is set.
        sourceControl: sourceMode !== 'local'
          ? { type: sourceMode, repoUrl: trimmedRepo }
          : undefined,
        jiraProjectKey: jiraProjectKey.trim() || undefined,
        intake,
      });
      if (!result?.success) {
        setError(result?.error || 'Failed to spawn season.');
        setSubmitting(false);
        return;
      }
      onSpawned(result.season?.id || id);
    } catch (err) {
      setError(String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card border border-border rounded-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <h2 className="text-lg font-semibold text-foreground">New Season</h2>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Season Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Q3 Platform Sprint"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Theme</label>
              <input
                value={theme}
                onChange={e => setTheme(e.target.value)}
                placeholder="tbbt"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* Intake mode — New project vs Existing (in-flight) project. */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-2">
              Project type
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {INTAKE_OPTIONS.map(opt => {
                const selected = intake === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      setIntake(opt.value);
                      // Existing projects need a repo — reveal the links section.
                      if (opt.value === 'brownfield') setShowLinks(true);
                    }}
                    className={`text-left flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-background hover:border-primary/40'
                    }`}
                  >
                    <opt.Icon className={`w-4 h-4 mt-0.5 shrink-0 ${selected ? 'text-primary' : 'text-muted-foreground'}`} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{opt.label}</span>
                      <span className="block text-[11px] mt-0.5 text-muted-foreground">{opt.caption}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Inline warning when Existing is chosen without a linked repo. */}
            {intake === 'brownfield' && sourceMode === 'local' && (
              <div className="mt-2 flex items-start gap-2 text-[11px] text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  Existing projects need a linked repo so the team can bootstrap context from it. Link a
                  GitHub or Azure DevOps repo under <span className="font-medium">Source control &amp; Jira</span> below.
                </span>
              </div>
            )}
          </div>

          {/* PRD chat / current status — auto-composes the team on spawn. */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              {intake === 'brownfield'
                ? 'Current status of this in-flight project'
                : 'Describe what this team should build'}
            </label>
            <textarea
              value={prd}
              onChange={e => setPrd(e.target.value)}
              rows={6}
              placeholder={
                intake === 'brownfield'
                  ? 'Where does the project stand today? What is done, what is in progress, what needs to happen next, and any known issues. The team will also search the repo (and prior context) for more detail.'
                  : 'Paste a PRD/BRD or just describe it in plain language. e.g. "Build an iOS + web expense app with Postgres, Stripe billing, and SOC 2 compliance. Goal: launch an MVP in Q3…"'
              }
              className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary resize-y"
            />
            <p className="text-[11px] text-muted-foreground/70 mt-1.5">
              {intake === 'brownfield' ? (
                <>
                  On spawn, Echelon clones the linked repo and bootstraps the team&apos;s context: it
                  searches repo docs, the knowledge base, and prior seasons for this repo. If nothing is
                  found, it kicks off a code review to map the codebase before the team begins. A
                  tier-appropriate roster is auto-composed from this status.
                </>
              ) : (
                <>
                  On spawn, Echelon reads this and auto-composes a tier-appropriate roster (always including
                  the convener, ingestion PM, and user handler). The convener receives the full brief and
                  coordinates the team.
                </>
              )}
            </p>
          </div>

          {/* Permission posture — the user sets the season's authority level. */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-2">
              Permission posture for this season
            </label>
            <div className="space-y-2">
              {PERMISSION_OPTIONS.map(opt => {
                const selected = posture === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPosture(opt.value)}
                    className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-background hover:border-primary/40'
                    }`}
                  >
                    <opt.Icon
                      className={`w-4 h-4 mt-0.5 shrink-0 ${
                        opt.value === 'bypass'
                          ? selected ? 'text-amber-500' : 'text-amber-500/70'
                          : selected ? 'text-primary' : 'text-muted-foreground'
                      }`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{opt.label}</span>
                      <span className={`block text-[11px] mt-0.5 ${opt.value === 'bypass' ? 'text-amber-500/90' : 'text-muted-foreground'}`}>
                        {opt.caption}
                      </span>
                    </span>
                    <span className={`ml-auto mt-0.5 w-3.5 h-3.5 rounded-full border shrink-0 ${selected ? 'border-primary bg-primary' : 'border-muted-foreground/40'}`} />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Source control + Jira linkage (optional, collapsed by default). */}
          <div className="border-t border-border pt-3">
            <button
              type="button"
              onClick={() => setShowLinks(v => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {showLinks ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Source control &amp; Jira
              {(sourceMode !== 'local' || jiraProjectKey.trim()) && (
                <span className="text-[10px] text-primary/80">
                  {sourceMode !== 'local' ? (sourceMode === 'github' ? 'GitHub' : 'Azure DevOps') : ''}
                  {sourceMode !== 'local' && jiraProjectKey.trim() ? ' · ' : ''}
                  {jiraProjectKey.trim() ? `JIRA ${jiraProjectKey.trim().toUpperCase()}` : ''}
                </span>
              )}
            </button>

            {showLinks && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-2">
                    Source control
                  </label>
                  <div className="space-y-2">
                    {SOURCE_CONTROL_OPTIONS.map(opt => {
                      const selected = sourceMode === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setSourceMode(opt.value)}
                          className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                            selected
                              ? 'border-primary bg-primary/5'
                              : 'border-border bg-background hover:border-primary/40'
                          }`}
                        >
                          <opt.Icon className={`w-4 h-4 mt-0.5 shrink-0 ${selected ? 'text-primary' : 'text-muted-foreground'}`} />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-foreground">{opt.label}</span>
                            <span className="block text-[11px] mt-0.5 text-muted-foreground">{opt.caption}</span>
                          </span>
                          <span className={`ml-auto mt-0.5 w-3.5 h-3.5 rounded-full border shrink-0 ${selected ? 'border-primary bg-primary' : 'border-muted-foreground/40'}`} />
                        </button>
                      );
                    })}
                  </div>

                  {sourceMode !== 'local' && (
                    <div className="mt-2">
                      <input
                        value={repoUrl}
                        onChange={e => setRepoUrl(e.target.value)}
                        placeholder={
                          SOURCE_CONTROL_OPTIONS.find(o => o.value === sourceMode)?.repoPlaceholder
                        }
                        className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <p className="text-[11px] text-muted-foreground/70 mt-1.5">
                        The repo is cloned as the season workspace on spawn; cast agents branch
                        their worktrees off it. If the clone fails, the spawn is aborted.
                      </p>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Jira project key <span className="text-muted-foreground/60">(optional)</span>
                  </label>
                  <input
                    value={jiraProjectKey}
                    onChange={e => setJiraProjectKey(e.target.value)}
                    placeholder="e.g. SD"
                    className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="text-[11px] text-muted-foreground/70 mt-1.5">
                    Associates the season with a Jira project for display. Ticket sync lands in a
                    later build.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Advanced: edit roster override (collapsed by default). */}
          <div className="border-t border-border pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(v => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {showAdvanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Advanced: edit roster
              {showAdvanced && <span className="text-[10px] text-amber-500/80">(overrides auto-compose)</span>}
            </button>

            {showAdvanced && (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-medium text-muted-foreground">
                    Roster (archetype → character)
                  </label>
                  <button onClick={addRow} className="text-xs text-primary hover:underline flex items-center gap-1">
                    <Plus className="w-3 h-3" /> Add
                  </button>
                </div>
                <div className="space-y-2">
                  {roster.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        value={row.archetype}
                        onChange={e => updateRow(idx, 'archetype', e.target.value)}
                        placeholder="archetype (e.g. backend-engineer)"
                        className="flex-1 px-2 py-1.5 text-xs font-mono bg-background border border-border rounded text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <input
                        value={row.character}
                        onChange={e => updateRow(idx, 'character', e.target.value)}
                        placeholder="character (e.g. stuart-bloom)"
                        className="flex-1 px-2 py-1.5 text-xs font-mono bg-background border border-border rounded text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <button
                        onClick={() => removeRow(idx)}
                        className="p-1 text-muted-foreground hover:text-red-500 rounded"
                        title="Remove"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground/70 mt-2">
                  When this roster has entries, it is used verbatim and the PRD auto-composer is skipped.
                  Each archetype launches on its recommended model with its soul package injected.
                </p>
              </div>
            )}
          </div>

          {error && (
            <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-border sticky bottom-0 bg-card">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-foreground text-background rounded-lg hover:opacity-90 disabled:opacity-50"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitting ? 'Composing & spawning…' : 'Spawn Season'}
          </button>
        </div>
      </div>
    </div>
  );
}
