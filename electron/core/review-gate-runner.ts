/**
 * Review Gate Runner (B2/B4)
 *
 * Public, Electron-facing review-gate API. The 7 gates are now REAL: this module
 * delegates to the copied build orchestration (`runReviewPipeline`) driven by the
 * real model-backed `GateRunner` (`gate-runner-impl.ts`), then maps the
 * build-shaped results back to the Electron `GateResult` vocabulary the IPC
 * contract and `ReviewGateBoard` UI expect (`{ gate, status, feedback }` with
 * unsuffixed gate names). The `review-gate:updated` broadcast contract is
 * unchanged.
 *
 * At MAX_BOUNCES the pipeline escalates to the 4-seat Counselor at Placement C
 * (deadlock, binding, majority); merge is gated via `attemptMerge`.
 */

import { broadcastToAllWindows } from '../utils/broadcast';
import {
  runReviewPipeline,
  MAX_BOUNCES,
  type GateResult as PipelineGateResult,
  type ReviewPipelineInput,
  type ReviewPipelineResult,
} from './review-pipeline';
import { createGateRunner } from './gate-runner-impl';
import { invokeCounselor, type CounselorVerdict } from '../services/counselor-service';

export type GateType =
  | 'architecture'
  | 'code'
  | 'qa'
  | 'security'
  | 'adversarial'
  | 'ui'
  | 'refinement';

export type GateStatus = 'pass' | 'fail' | 'pending';

export interface GateResult {
  gate: GateType;
  status: GateStatus;
  feedback: string;
}

export const GATE_DEFINITIONS: { gate: GateType; description: string }[] = [
  { gate: 'architecture', description: 'Validates structural design and system boundaries' },
  { gate: 'code', description: 'Reviews code quality, patterns, and correctness' },
  { gate: 'qa', description: 'Checks test coverage and quality assurance criteria' },
  { gate: 'security', description: 'Scans for vulnerabilities and security best practices' },
  { gate: 'adversarial', description: 'Stress-tests edge cases and failure modes' },
  { gate: 'ui', description: 'Validates UI/UX consistency and accessibility' },
  { gate: 'refinement', description: 'Final polish pass after all other gates pass' },
];

// Build (suffixed) gate id ⇄ Electron (unsuffixed) gate id.
const BUILD_TO_ELECTRON_GATE: Record<string, GateType> = {
  'architecture-review': 'architecture',
  'code-review': 'code',
  'qa-review': 'qa',
  'security-review': 'security',
  'adversarial-review': 'adversarial',
  'ui-functionality-review': 'ui',
  'refinement-pass': 'refinement',
};

export interface RunReviewGatesOptions {
  /** Diff of the character's worktree changes, fed to each gate's prompt. */
  worktreeDiff?: string;
  /** Filesystem path of the worktree under review. */
  worktreePath?: string;
  /** Current bounce count (drives MAX_BOUNCES escalation). */
  bounceCount?: number;
}

export interface ReviewGatesOutcome {
  results: GateResult[];
  passed: boolean;
  mustBounce: boolean;
  escalated: boolean;
  counselorVerdict: CounselorVerdict | null;
  overallRating: number | null;
}

// In-memory store of current gate results keyed by characterId
const currentResults = new Map<string, GateResult[]>();

/**
 * Map one build pipeline result to the Electron gate-result shape.
 * - pass-fail: result 'pass' → 'pass', else 'fail'
 * - rating: >=4 → 'pass', else 'fail' (mirrors the pipeline's own >=4 bar)
 */
function mapPipelineResult(r: PipelineGateResult): GateResult {
  const gate = BUILD_TO_ELECTRON_GATE[r.gate] ?? (r.gate as GateType);
  let status: GateStatus;
  if (r.type === 'rating') {
    status = (r.result as number) >= 4 ? 'pass' : 'fail';
  } else {
    status = r.result === 'pass' ? 'pass' : 'fail';
  }
  const ratingNote = r.type === 'rating' ? ` (rating ${r.result}/5)` : '';
  const feedback = `${r.notes}${ratingNote}`.trim();
  return { gate, status, feedback };
}

/**
 * Run all 7 review gates for a character's work against the real model-backed
 * pipeline, broadcasting progressive updates so the UI animates from pending →
 * resolved. At MAX_BOUNCES, escalates to the Counselor (Placement C).
 */
export async function runReviewGates(
  characterId: string,
  workSummary: string,
  options: RunReviewGatesOptions = {},
): Promise<GateResult[]> {
  const outcome = await runReviewGatesDetailed(characterId, workSummary, options);
  return outcome.results;
}

/**
 * Same as `runReviewGates` but returns the full outcome (pass/bounce/escalation
 * + any Counselor verdict) for callers that gate merges (B4).
 */
export async function runReviewGatesDetailed(
  characterId: string,
  workSummary: string,
  options: RunReviewGatesOptions = {},
): Promise<ReviewGatesOutcome> {
  // Initialize all gates as pending and broadcast (unchanged UI contract).
  const pendingResults: GateResult[] = GATE_DEFINITIONS.map((def) => ({
    gate: def.gate,
    status: 'pending' as GateStatus,
    feedback: '',
  }));
  currentResults.set(characterId, [...pendingResults]);
  broadcastToAllWindows('review-gate:updated', { characterId, results: pendingResults });

  const input: ReviewPipelineInput = {
    taskId: characterId,
    worktreePath: options.worktreePath ?? '',
    worktreeDiff: options.worktreeDiff ?? workSummary,
    bounceCount: options.bounceCount ?? 0,
  };

  const gateRunner = createGateRunner();
  const pipeline: ReviewPipelineResult = await runReviewPipeline(input, gateRunner);

  // Map build results into the Electron shape, then fold them into the
  // pending list so every defined gate has a slot (gates the pipeline skipped
  // after a parallel failure stay pending → rendered as such).
  const merged: GateResult[] = pendingResults.map((p) => {
    const match = pipeline.gateResults.find((r) => BUILD_TO_ELECTRON_GATE[r.gate] === p.gate);
    return match ? mapPipelineResult(match) : p;
  });

  currentResults.set(characterId, merged);
  broadcastToAllWindows('review-gate:updated', { characterId, results: merged });

  // B4 — escalation: at MAX_BOUNCES, the Counselor renders a binding verdict.
  let counselorVerdict: CounselorVerdict | null = null;
  if (pipeline.escalateToCounselor) {
    try {
      counselorVerdict = await invokeCounselor(
        'deadlock-escalation', // Placement C
        buildEscalationContext(characterId, workSummary, merged, input.bounceCount),
      );
    } catch (err) {
      console.error('[ReviewGate] Counselor escalation failed:', err);
    }
  }

  return {
    results: merged,
    passed: pipeline.passed,
    mustBounce: pipeline.mustBounce,
    escalated: pipeline.escalateToCounselor,
    counselorVerdict,
    overallRating: pipeline.overallRating,
  };
}

function buildEscalationContext(
  characterId: string,
  workSummary: string,
  results: GateResult[],
  bounceCount: number,
): string {
  const failing = results
    .filter((r) => r.status === 'fail')
    .map((r) => `- ${r.gate}: ${r.feedback || 'failed'}`)
    .join('\n');
  return [
    `Review gates have bounced ${bounceCount + 1} times (>= ${MAX_BOUNCES}) for character ${characterId}.`,
    `## Work Summary\n${workSummary}`,
    `## Failing Gates\n${failing || '(none recorded)'}`,
    'The team is deadlocked. Render a BINDING verdict (rate 1-5): is the work acceptable to merge, or must it be redesigned?',
  ].join('\n\n');
}

/**
 * Get current gate status for a given character (or season).
 */
export function getGateStatus(characterId: string): GateResult[] | null {
  return currentResults.get(characterId) ?? null;
}

/**
 * List all gate definitions.
 */
export function listGateDefinitions(): { gate: GateType; description: string }[] {
  return GATE_DEFINITIONS;
}

// Re-export merge authority so callers gate merges on review `passed` (B4).
export { attemptMerge, type MergeInput, type MergeResult } from './merge-authority';
