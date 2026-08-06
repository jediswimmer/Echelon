/**
 * meeting-intake.ts — primary-contact meeting transcript absorption (#22c /
 * Scott's requirement #11).
 *
 * The season's PRIMARY-CONTACT agent (a designated scrum-master / user-handler —
 * defaults to the convener) "attends" a meeting via the user-provided transcript:
 * we run a single PM/scrum-master-persona one-shot over the transcript that
 * returns a strict JSON `{ summary, decisions, actionItems, questions }`, then:
 *
 *   • create a season-scoped kanban `task` (issueType 'task') for each action
 *     item → collect the created task ids;
 *   • append the questions as `meetingFollowUps` (status 'open') on the season,
 *     surfaced back to the user on the control board (the DirectionCard pattern);
 *   • record a bounded `MeetingAbsorption` history entry (summary + decisions +
 *     action-item task ids);
 *   • post a `system` conversation entry under the primary-contact's name so the
 *     summary streams into the 17b Conversation tab;
 *   • save + broadcast.
 *
 * Resilient like 17c grooming: an empty/huge transcript, a missing season, or a
 * model/parse failure logs a system entry and returns a graceful error result —
 * NEVER throws into the caller (the IPC handler). An in-flight guard per season
 * prevents a double-submit from double-creating tickets.
 *
 * OUT OF SCOPE: live video auto-attendance (joining a Zoom/Meet call) and live
 * transcription need a meeting-bot/transcription service and are NOT built here —
 * this works purely from a user-provided transcript and is noted as a future
 * capability on the control board.
 */

import { v4 as uuidv4 } from 'uuid';
import { invokeModel } from './model-invoke';
import { createTask } from '../handlers/kanban-handlers';
import { appendConversationEntry } from './conversation-log';
import {
  getSeason,
  saveSeason,
  broadcastSeasonUpdated,
  getPrimaryContactName,
} from './season-manager';
import type { MeetingAbsorption, MeetingFollowUp } from '../types/echelon';

/** Optional intake context (e.g. an explicit model for the one-shot). */
export interface MeetingIntakeContext {
  /** Provider model id for the one-shot; defaults to the provider default. */
  model?: string;
}

/** Hard caps to keep a runaway model + the stored history in check. */
const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_ACTION_ITEMS = 20;
const MAX_QUESTIONS = 20;
const MAX_DECISIONS = 20;
const MAX_ABSORPTION_HISTORY = 20;
/** Cap the summary length we persist + post (defensive against a long model reply). */
const MAX_SUMMARY_CHARS = 4_000;

/** The result returned to the IPC handler / renderer. Never thrown. */
export interface AbsorbTranscriptResult {
  ok: boolean;
  summary?: string;
  actionItems?: number;
  questions?: number;
  decisions?: number;
  error?: string;
}

/**
 * Seasons with an absorption currently in flight — a synchronous guard closing
 * the async window between the season read and its (post-model) write, so a
 * double-submit can't both pass and double-create tickets/follow-ups.
 */
const absorbInFlight = new Set<string>();

/** Coerce an unknown value to a trimmed non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t || undefined;
}

/** Coerce an unknown to a clean string[] (drop empties), capped to `max`. */
function strArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter((s): s is string => Boolean(s)).slice(0, max);
}

/** Log a `system` conversation entry for the season (best-effort, never throws). */
function logSystem(seasonId: string, canonName: string, text: string): void {
  try {
    appendConversationEntry(seasonId, { agentId: 'system', canonName, kind: 'system', text });
  } catch {
    // Logging must never break intake.
  }
}

interface ParsedActionItem {
  title?: unknown;
  description?: unknown;
}

/**
 * Absorb a user-provided meeting transcript as the season's primary-contact
 * agent (#22c). Guards: season exists + a non-empty transcript (capped). Builds a
 * one-shot scrum-master prompt, parses defensively, then creates action-item
 * tickets + records follow-up questions + a bounded absorption history entry,
 * posts a comms-log summary, and saves + broadcasts. Resolves with a result
 * object; NEVER throws.
 */
export function absorbTranscript(
  seasonId: string,
  payload: { ceremonyId?: string; transcript: string },
  ctx?: MeetingIntakeContext,
): Promise<AbsorbTranscriptResult> {
  return onceInFlight(seasonId, () => absorbTranscriptImpl(seasonId, payload, ctx));
}

/** Run `fn` for a season at most once concurrently; a double-submit returns busy. */
function onceInFlight(
  seasonId: string,
  fn: () => Promise<AbsorbTranscriptResult>,
): Promise<AbsorbTranscriptResult> {
  if (absorbInFlight.has(seasonId)) {
    return Promise.resolve({ ok: false, error: 'A meeting is already being absorbed for this season.' });
  }
  absorbInFlight.add(seasonId);
  return fn().finally(() => absorbInFlight.delete(seasonId));
}

async function absorbTranscriptImpl(
  seasonId: string,
  payload: { ceremonyId?: string; transcript: string },
  ctx?: MeetingIntakeContext,
): Promise<AbsorbTranscriptResult> {
  const season = getSeason(seasonId);
  if (!season) return { ok: false, error: 'Season not found.' };

  const rawTranscript = typeof payload?.transcript === 'string' ? payload.transcript.trim() : '';
  if (!rawTranscript) {
    return { ok: false, error: 'The transcript is empty.' };
  }
  // Cap the transcript fed to the model (a huge paste must not blow the budget).
  const transcript = rawTranscript.slice(0, MAX_TRANSCRIPT_CHARS);
  const ceremonyId = str(payload?.ceremonyId);
  const contactName = getPrimaryContactName(seasonId);

  // Resolve a friendly label for the ceremony (when attached) for the log line.
  const ceremony = ceremonyId
    ? (season.ceremonies ?? []).find((c) => c.id === ceremonyId)
    : undefined;
  const meetingLabel = ceremony ? `"${ceremony.title}"` : 'meeting';

  const prompt =
    `You are ${contactName}, the scrum-master / primary contact for a software team. You attended a ` +
    `meeting and have its transcript below. Read it and produce a concise structured summary for the team.\n\n` +
    `Respond with ONLY this strict JSON shape (no prose, no markdown fences):\n` +
    `{\n` +
    `  "summary": "a short paragraph summarizing the meeting",\n` +
    `  "decisions": ["each decision the team reached"],\n` +
    `  "actionItems": [ { "title": "short imperative action", "description": "what + who + why" } ],\n` +
    `  "questions": ["open questions / discussion items that still need the user's input"]\n` +
    `}\n\n` +
    `Keep action-item titles short and imperative. Only include questions that genuinely need a human ` +
    `decision. Here is the transcript:\n\n---\n${transcript}\n---`;

  let json: Record<string, unknown> | null;
  try {
    const result = await invokeModel({ prompt, model: ctx?.model });
    json = result.json;
  } catch (err) {
    console.error(`meeting-intake: one-shot failed for season ${seasonId}:`, err);
    logSystem(
      seasonId,
      contactName,
      `Could not absorb the ${meetingLabel} transcript — the summarization model call errored. You can re-try, or capture the items manually.`,
    );
    return { ok: false, error: 'The summarization model call failed.' };
  }

  if (!json || typeof json !== 'object') {
    logSystem(
      seasonId,
      contactName,
      `Could not parse a summary from the ${meetingLabel} transcript. You can re-try, or capture the items manually.`,
    );
    return { ok: false, error: 'Could not parse the meeting summary.' };
  }

  const summary = (str((json as { summary?: unknown }).summary) || '').slice(0, MAX_SUMMARY_CHARS);
  const decisions = strArray((json as { decisions?: unknown }).decisions, MAX_DECISIONS);
  const questions = strArray((json as { questions?: unknown }).questions, MAX_QUESTIONS);
  const rawActionItems = Array.isArray((json as { actionItems?: unknown }).actionItems)
    ? ((json as { actionItems: unknown[] }).actionItems as ParsedActionItem[])
    : [];

  // Re-read the season after the await (it could have changed) and bail if gone.
  const live = getSeason(seasonId);
  if (!live) return { ok: false, error: 'Season not found.' };

  // ── Create a season-scoped kanban task for each action item ──
  // Coalesce a missing workspacePath (corrupt/legacy season JSON) and skip ticket
  // creation rather than writing ghost tasks with an undefined project.
  const projectPath = live.workspacePath ?? '';
  const actionItemTaskIds: string[] = [];
  if (!projectPath) {
    console.warn(`meeting-intake: season ${seasonId} has no workspacePath; skipping action-item tickets.`);
  } else {
    for (const item of rawActionItems.slice(0, MAX_ACTION_ITEMS)) {
      const title = str(item.title);
      if (!title) continue;
      try {
        const task = createTask({
          title,
          description: str(item.description) || '',
          projectId: projectPath,
          projectPath,
          seasonId,
          issueType: 'task',
        });
        actionItemTaskIds.push(task.id);
      } catch (err) {
        console.error(`meeting-intake: failed to create action-item task for season ${seasonId}:`, err);
      }
    }
  }

  const now = new Date().toISOString();

  // ── Append open follow-up questions (the DirectionCard surfacing pattern) ──
  const newFollowUps: MeetingFollowUp[] = questions.map((question) => ({
    id: uuidv4(),
    question,
    status: 'open' as const,
    ceremonyId,
    createdAt: now,
  }));
  const existingFollowUps = Array.isArray(live.meetingFollowUps) ? live.meetingFollowUps : [];
  live.meetingFollowUps = [...existingFollowUps, ...newFollowUps];

  // ── Record a bounded absorption-history entry ──
  const absorption: MeetingAbsorption = {
    id: uuidv4(),
    ceremonyId,
    at: now,
    summary,
    decisions,
    actionItemTaskIds,
  };
  const existingAbsorptions = Array.isArray(live.meetingAbsorptions) ? live.meetingAbsorptions : [];
  const nextAbsorptions = [...existingAbsorptions, absorption];
  live.meetingAbsorptions =
    nextAbsorptions.length > MAX_ABSORPTION_HISTORY
      ? nextAbsorptions.slice(nextAbsorptions.length - MAX_ABSORPTION_HISTORY)
      : nextAbsorptions;

  saveSeason(seasonId);
  broadcastSeasonUpdated(seasonId);

  // ── Post the summary + counts into the Conversation tab ──
  const counts =
    `${decisions.length} decision${decisions.length === 1 ? '' : 's'}, ` +
    `${actionItemTaskIds.length} action item${actionItemTaskIds.length === 1 ? '' : 's'}, ` +
    `${newFollowUps.length} follow-up question${newFollowUps.length === 1 ? '' : 's'}`;
  const headline = `Absorbed the ${meetingLabel} → ${counts}.`;
  logSystem(seasonId, contactName, summary ? `${headline}\n\n${summary}` : headline);

  return {
    ok: true,
    summary,
    actionItems: actionItemTaskIds.length,
    questions: newFollowUps.length,
    decisions: decisions.length,
  };
}
