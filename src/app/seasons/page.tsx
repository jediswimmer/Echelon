'use client';

import { useEffect, useState } from 'react';
import { Plus, RefreshCw, X, Loader2 } from 'lucide-react';
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

/**
 * Default cast for a quick spawn. Each archetype's `agent.config.yaml` carries
 * its own recommended model + skills; the renderer only needs the
 * archetype + the theme character slug. These characters exist under
 * src/team-factory/themes/tbbt/characters/.
 */
const DEFAULT_TBBT_ROSTER: RosterEntryDraft[] = [
  { archetype: 'counselor-convener', character: 'stephen-hawking' },
  { archetype: 'user-handler', character: 'leonard-hofstadter' },
  { archetype: 'principal-architect', character: 'sheldon-cooper' },
  { archetype: 'backend-engineer', character: 'stuart-bloom' },
];

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `season-${Date.now()}`;
}

export default function SeasonsPage() {
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
          onSpawned={() => {
            setShowNewSeason(false);
            fetchSeasons();
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

function NewSeasonModal({
  onClose,
  onSpawned,
}: {
  onClose: () => void;
  onSpawned: () => void;
}) {
  const [name, setName] = useState('');
  const [theme, setTheme] = useState('tbbt');
  const [prd, setPrd] = useState('');
  const [roster, setRoster] = useState<RosterEntryDraft[]>(DEFAULT_TBBT_ROSTER);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateRow = (idx: number, field: keyof RosterEntryDraft, value: string) => {
    setRoster(prev => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  };
  const addRow = () => setRoster(prev => [...prev, { archetype: '', character: '' }]);
  const removeRow = (idx: number) => setRoster(prev => prev.filter((_, i) => i !== idx));

  const handleSubmit = async () => {
    setError(null);
    const cleanRoster = roster
      .map(r => ({ archetype: r.archetype.trim(), character: r.character.trim() }))
      .filter(r => r.archetype && r.character);

    if (!name.trim()) { setError('Season name is required.'); return; }
    if (!theme.trim()) { setError('Theme is required.'); return; }
    if (cleanRoster.length === 0) { setError('Add at least one roster entry (archetype + character).'); return; }

    const api = (window as unknown as { electronAPI?: { season?: { spawn: (c: unknown) => Promise<{ success: boolean; error?: string }> } } }).electronAPI;
    if (!api?.season) { setError('Season API unavailable (not running in Electron).'); return; }

    setSubmitting(true);
    try {
      const id = `${slugify(name)}-${Date.now().toString(36)}`;
      const result = await api.season.spawn({
        id,
        name: name.trim(),
        theme: theme.trim(),
        prd: prd.trim() || undefined,
        rosterEntries: cleanRoster.map(r => ({ ...r, capabilities: [] })),
      });
      if (!result?.success) {
        setError(result?.error || 'Failed to spawn season.');
        setSubmitting(false);
        return;
      }
      onSpawned();
    } catch (err) {
      setError(String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card border border-border rounded-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card">
          <h2 className="text-lg font-semibold text-foreground">New Season</h2>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
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

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              PRD / Brief (handed to the convener)
            </label>
            <textarea
              value={prd}
              onChange={e => setPrd(e.target.value)}
              rows={5}
              placeholder="Describe what this team should build…"
              className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary resize-y"
            />
          </div>

          <div>
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
              The convener (first matching roster slot) receives the PRD and coordinates the team. Each
              archetype launches on its recommended model with its soul package injected.
            </p>
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
            {submitting ? 'Spawning…' : 'Spawn Season'}
          </button>
        </div>
      </div>
    </div>
  );
}
