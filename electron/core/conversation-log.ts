import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DATA_DIR } from '../constants';
import { broadcastToAllWindows } from '../utils/broadcast';

/**
 * Per-season comms / crosstalk log (sub-feature 17b).
 *
 * Aggregates each cast agent's clean transcript output, status transitions, and
 * inter-agent delegations (crosstalk) into one append-only, season-scoped
 * timeline. Entries are persisted as JSON lines under
 * `~/.echelon/seasons/<seasonId>/conversation.jsonl` and mirrored into an
 * in-memory ring buffer for fast warm reads. Each append also broadcasts a
 * live `season:conversation:appended` event for the control board's
 * Conversation tab.
 *
 * Dependency-light + synchronous fs, mirroring season-manager / kanban-handlers.
 */

const SEASONS_DIR = path.join(DATA_DIR, 'seasons');

/** Max entries kept in the per-season in-memory ring buffer. */
const RING_CAP = 2000;

/** Default number of (most-recent) entries returned by {@link readConversation}. */
const DEFAULT_LIMIT = 500;

export type ConversationKind = 'output' | 'status' | 'delegation' | 'system';

export interface ConversationEntry {
  id: string;             // uuidv4
  ts: string;             // ISO timestamp
  seasonId: string;
  agentId: string;        // the subject agent (for delegation: the recipient)
  archetypeId?: string;
  canonName?: string;     // display name
  kind: ConversationKind;
  text: string;           // clean output text, status label, or delegation prompt
  meta?: {                // optional structured extras
    status?: string;
    waitingReason?: string;
    currentTask?: string;
    fromAgentId?: string; // delegation sender (best-effort)
    fromName?: string;    // delegation sender display name (best-effort)
    sessionId?: string;
  };
}

/** Partial entry accepted by {@link appendConversationEntry} (id/ts are filled). */
export type ConversationEntryInput = Omit<ConversationEntry, 'id' | 'ts' | 'seasonId'>;

export interface ReadConversationOpts {
  kind?: ConversationKind;
  agentId?: string;
  limit?: number;
  sinceTs?: string;
}

/** seasonId → in-memory ring buffer (most-recent at the tail). */
const rings: Map<string, ConversationEntry[]> = new Map();

/** seasonId → whether the ring is warm (jsonl tail loaded into the ring). */
const warm: Set<string> = new Set();

function conversationPath(seasonId: string): string {
  return path.join(SEASONS_DIR, seasonId, 'conversation.jsonl');
}

/**
 * Season ids are uuids/slugs; reject anything that could escape the seasons
 * directory (path separators or `..`) before interpolating into an fs path.
 */
function isSafeSeasonId(seasonId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(seasonId) && !seasonId.includes('..');
}

function getRing(seasonId: string): ConversationEntry[] {
  let ring = rings.get(seasonId);
  if (!ring) {
    ring = [];
    rings.set(seasonId, ring);
  }
  return ring;
}

/**
 * Append one entry to the season's conversation log: fill id/ts, write a single
 * JSON line to the season's `conversation.jsonl`, push onto the in-memory ring
 * (capped at {@link RING_CAP}), and broadcast it live. No-op (returns undefined)
 * when `seasonId` is falsy — non-season agents do not log here.
 */
export function appendConversationEntry(
  seasonId: string | undefined,
  partial: ConversationEntryInput,
): ConversationEntry | undefined {
  if (!seasonId || !isSafeSeasonId(seasonId)) return undefined;

  const entry: ConversationEntry = {
    id: uuidv4(),
    ts: new Date().toISOString(),
    seasonId,
    ...partial,
  };

  try {
    const seasonDir = path.join(SEASONS_DIR, seasonId);
    if (!fs.existsSync(seasonDir)) {
      fs.mkdirSync(seasonDir, { recursive: true });
    }
    fs.appendFileSync(conversationPath(seasonId), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.error(`appendConversationEntry: failed to persist for season ${seasonId}:`, err);
  }

  const ring = getRing(seasonId);
  ring.push(entry);
  if (ring.length > RING_CAP) {
    ring.splice(0, ring.length - RING_CAP);
  }

  broadcastToAllWindows('season:conversation:appended', entry);
  return entry;
}

/**
 * Read the most recent conversation entries for a season, optionally filtered by
 * kind / agentId / sinceTs and capped to `limit` (default {@link DEFAULT_LIMIT}).
 * Serves from the warm ring when available; otherwise reads + parses the jsonl
 * tail (warming the ring as a side effect). Robust to a missing file (returns []).
 */
export function readConversation(
  seasonId: string,
  opts?: ReadConversationOpts,
): ConversationEntry[] {
  if (!seasonId || !isSafeSeasonId(seasonId)) return [];

  let source: ConversationEntry[];
  if (warm.has(seasonId)) {
    source = getRing(seasonId);
  } else {
    source = loadFromDisk(seasonId);
  }

  let entries = source;
  if (opts?.kind) entries = entries.filter(e => e.kind === opts.kind);
  if (opts?.agentId) entries = entries.filter(e => e.agentId === opts.agentId);
  if (opts?.sinceTs) {
    const since = opts.sinceTs;
    entries = entries.filter(e => e.ts > since);
  }

  const limit = opts?.limit ?? DEFAULT_LIMIT;
  if (entries.length > limit) {
    entries = entries.slice(entries.length - limit);
  }
  return entries;
}

/**
 * Parse the season's `conversation.jsonl` (skipping malformed lines), seed the
 * in-memory ring with the tail, mark it warm, and return the parsed entries.
 * Returns [] when the file does not exist or cannot be read.
 */
function loadFromDisk(seasonId: string): ConversationEntry[] {
  const file = conversationPath(seasonId);
  let parsed: ConversationEntry[] = [];
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          parsed.push(JSON.parse(trimmed) as ConversationEntry);
        } catch {
          // Skip a malformed/partial line rather than failing the whole read.
        }
      }
    }
  } catch (err) {
    console.error(`readConversation: failed to read log for season ${seasonId}:`, err);
    return [];
  }

  // Seed the ring with the most-recent tail and mark warm.
  const ring = parsed.length > RING_CAP ? parsed.slice(parsed.length - RING_CAP) : parsed.slice();
  rings.set(seasonId, ring);
  warm.add(seasonId);
  // Return the bounded ring tail (not the full history) so a cold read stays
  // memory-bounded; readConversation applies its own narrower limit on top.
  return ring;
}
