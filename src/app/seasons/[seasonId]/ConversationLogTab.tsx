'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MessagesSquare, ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';

/** Mirrors the main-process ConversationEntry (electron/core/conversation-log.ts). */
type ConversationKind = 'output' | 'status' | 'delegation' | 'system';

interface ConversationEntry {
  id: string;
  ts: string;
  seasonId: string;
  agentId: string;
  archetypeId?: string;
  canonName?: string;
  kind: ConversationKind;
  text: string;
  meta?: {
    status?: string;
    waitingReason?: string;
    currentTask?: string;
    fromAgentId?: string;
    fromName?: string;
    sessionId?: string;
  };
}

/** Stable, distinct color per agent (label + left accent). */
const AGENT_COLORS = [
  'text-sky-400',
  'text-emerald-400',
  'text-violet-400',
  'text-amber-400',
  'text-rose-400',
  'text-cyan-400',
  'text-fuchsia-400',
  'text-lime-400',
  'text-orange-400',
  'text-teal-400',
];

function agentColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

/** Tailwind classes for each kind's badge. */
function kindBadgeClass(kind: ConversationKind): string {
  switch (kind) {
    case 'output':
      return 'text-blue-400 border-blue-400/30 bg-blue-400/10';
    case 'status':
      return 'text-amber-400 border-amber-400/30 bg-amber-400/10';
    case 'delegation':
      return 'text-violet-400 border-violet-400/30 bg-violet-400/10';
    case 'system':
    default:
      return 'text-muted-foreground border-border bg-secondary';
  }
}

/** HH:MM:SS for a timeline row. */
function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour12: false });
}

const KIND_FILTERS: { key: ConversationKind; label: string }[] = [
  { key: 'output', label: 'Output' },
  { key: 'status', label: 'Status' },
  { key: 'delegation', label: 'Delegation' },
];

/** A long output block clamps to a few lines until expanded. */
function EntryText({ entry }: { entry: ConversationEntry }) {
  const [expanded, setExpanded] = useState(false);
  const text = entry.text || '';
  const isLong = text.length > 280 || text.split('\n').length > 4;

  if (entry.kind === 'delegation') {
    const fromName = entry.meta?.fromName || '?';
    const toName = entry.canonName || entry.archetypeId || entry.agentId;
    return (
      <div className="text-xs text-foreground/90 whitespace-pre-wrap break-words">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <span className="font-medium text-foreground/80">{fromName}</span>
          <ArrowRight className="w-3 h-3" />
          <span className="font-medium text-foreground/80">{toName}</span>
          <span>:</span>
        </span>{' '}
        {text}
      </div>
    );
  }

  if (!isLong) {
    return (
      <div className="text-xs text-foreground/90 whitespace-pre-wrap break-words">{text}</div>
    );
  }

  return (
    <div>
      <div
        className={`text-xs text-foreground/90 whitespace-pre-wrap break-words ${expanded ? '' : 'max-h-24 overflow-hidden'}`}
      >
        {text}
      </div>
      <button
        onClick={() => setExpanded(e => !e)}
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {expanded ? 'Collapse' : 'Expand'}
      </button>
    </div>
  );
}

export default function ConversationLogTab({
  seasonId,
  characterIds,
}: {
  seasonId: string;
  characterIds: string[];
}) {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  // agentId → display label, loaded from the cast agents (entries also carry
  // their own canonName as a fallback).
  const [castLabels, setCastLabels] = useState<Record<string, string>>({});
  const [activeKinds, setActiveKinds] = useState<Set<ConversationKind>>(
    () => new Set<ConversationKind>(['output', 'status', 'delegation', 'system']),
  );
  const [agentFilter, setAgentFilter] = useState<string>('all');

  // Scroll container + a ref to whether we should stick to the bottom.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  // Track seen ids to dedupe live appends.
  const seenIds = useRef<Set<string>>(new Set());

  const api = typeof window !== 'undefined'
    ? (window as unknown as { electronAPI: any }).electronAPI
    : null;

  // Resolve cast labels from the live agent list (mirrors CastTab).
  useEffect(() => {
    if (!api?.agent) return;
    let cancelled = false;
    (async () => {
      try {
        const all: Array<{ id: string; canonName?: string; name?: string; archetypeId?: string }> =
          await api.agent.list();
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const a of all) {
          if (characterIds.includes(a.id)) {
            map[a.id] = a.canonName || a.name || a.archetypeId || a.id;
          }
        }
        setCastLabels(map);
      } catch (err) {
        console.error('Failed to load cast labels for conversation log:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [characterIds.join(',')]);

  useEffect(() => {
    if (!api?.season?.conversation) return;
    let cancelled = false;

    // Reset for the (possibly new) season; the seed + any live appends merge on top.
    seenIds.current = new Set();
    setEntries([]);

    (async () => {
      try {
        const result = await api.season.conversation.list(seasonId);
        if (cancelled) return;
        const seeded: ConversationEntry[] = result?.entries || [];
        // Merge with any entries that arrived live during the await (don't clobber
        // them); dedupe by id and keep the timeline ordered by timestamp.
        setEntries(prev => {
          const byId = new Map<string, ConversationEntry>();
          for (const e of seeded) byId.set(e.id, e);
          for (const e of prev) if (!byId.has(e.id)) byId.set(e.id, e);
          const merged = Array.from(byId.values()).sort((a, b) => a.ts.localeCompare(b.ts));
          seenIds.current = new Set(merged.map(e => e.id));
          return merged;
        });
      } catch (err) {
        console.error('Failed to load season conversation:', err);
      }
    })();

    const unsub = api.season.conversation.onAppended((entry: ConversationEntry) => {
      if (entry.seasonId !== seasonId) return;
      if (seenIds.current.has(entry.id)) return;
      seenIds.current.add(entry.id);
      setEntries(prev => [...prev, entry]);
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [seasonId]);

  // Auto-scroll to newest unless the user has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Within 40px of the bottom counts as "stuck to bottom".
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const toggleKind = (kind: ConversationKind) => {
    setActiveKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const filtered = useMemo(() => {
    return entries.filter(e => {
      if (!activeKinds.has(e.kind)) return false;
      if (agentFilter !== 'all' && e.agentId !== agentFilter) return false;
      return true;
    });
  }, [entries, activeKinds, agentFilter]);

  // Agents present in the log (union of cast + any agentId seen), for the dropdown.
  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const id of characterIds) seen.set(id, castLabels[id] || id);
    for (const e of entries) {
      if (!seen.has(e.agentId)) seen.set(e.agentId, e.canonName || e.archetypeId || e.agentId);
    }
    return Array.from(seen.entries()).map(([id, label]) => ({ id, label }));
  }, [characterIds, castLabels, entries]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Filters */}
      <div className="flex items-center flex-wrap gap-2 mb-3">
        {KIND_FILTERS.map(f => {
          const active = activeKinds.has(f.key);
          return (
            <button
              key={f.key}
              onClick={() => toggleKind(f.key)}
              className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                active ? kindBadgeClass(f.key) : 'text-muted-foreground border-border bg-transparent opacity-60'
              }`}
            >
              {f.label}
            </button>
          );
        })}
        <div className="flex-1" />
        <select
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
          className="text-xs bg-card border border-border rounded-md px-2 py-1 text-foreground"
        >
          <option value="all">All agents</option>
          {agentOptions.map(o => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Timeline */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
          <MessagesSquare className="w-8 h-8 mb-2 opacity-50" />
          <p className="text-sm">No conversation yet</p>
          <p className="text-xs mt-1">Agents will stream here as they work.</p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1"
        >
          {filtered.map(entry => {
            const color = agentColor(entry.agentId);
            const label = entry.canonName || castLabels[entry.agentId] || entry.archetypeId || entry.agentId;
            return (
              <div
                key={entry.id}
                className="bg-card border border-border rounded-lg p-3 flex gap-3"
              >
                <span className="text-[10px] font-mono text-muted-foreground shrink-0 pt-0.5 tabular-nums">
                  {formatTime(entry.ts)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center flex-wrap gap-2 mb-1">
                    <span className={`text-xs font-medium ${color}`}>{label}</span>
                    {entry.archetypeId && entry.archetypeId !== label && (
                      <span className="text-[10px] text-muted-foreground">{entry.archetypeId}</span>
                    )}
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${kindBadgeClass(entry.kind)}`}
                    >
                      {entry.kind}
                    </span>
                  </div>
                  <EntryText entry={entry} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
