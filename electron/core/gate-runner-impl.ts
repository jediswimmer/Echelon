/**
 * Real Gate Runner (B2)
 *
 * The host-injected `GateRunner` for `runReviewPipeline`. For each gate it
 * builds a rubric prompt + worktree diff, invokes the model via the B1
 * primitive (`invokeModel`) keyed by `GATE_REVIEWERS[gate]`, and parses the
 * model's `{ result | rating, notes }` JSON verdict into a build-shaped
 * `GateResult`.
 *
 * Fail-closed: any model error, timeout, or unparseable output produces a
 * failing verdict (a `fail` for pass-fail gates, a `1` for rating gates) so a
 * broken reviewer can never silently wave work through.
 */

import { invokeModel } from './model-invoke';
import {
  RATING_GATES,
  GATE_REVIEWERS,
  type GateResult,
  type GateRunner,
  type ReviewPipelineInput,
} from './review-pipeline';

// Per-gate rubric: what the reviewer is checking and how to score it.
const GATE_RUBRICS: Record<string, string> = {
  'architecture-review':
    'Review the diff for structural soundness, correct system boundaries, separation of concerns, and adherence to existing architectural patterns. Flag layering violations, leaky abstractions, and inappropriate coupling.',
  'code-review':
    'Review the diff for code quality, correctness, naming, error handling, and idiomatic use of the language/framework. Flag bugs, dead code, and unhandled edge cases.',
  'qa-review':
    'Review the diff for test coverage and quality-assurance criteria. Verify new behavior is tested, edge cases are covered, and no tests were weakened, skipped, or deleted to pass.',
  'security-review':
    'Review the diff for security vulnerabilities: injection, secrets in code, unsafe input handling, authz/authn gaps, and insecure defaults. Flag anything that widens the attack surface.',
  'adversarial-review':
    'Stress-test the diff against edge cases and failure modes. Rate how robust the change is against malformed input, concurrency, partial failure, and abuse.',
  'ui-functionality-review':
    'Evaluate UI/UX consistency, accessibility, and that interactive elements behave correctly. Rate the quality of the user-facing change.',
  'refinement-pass':
    'Final polish pass after all other gates pass. Confirm the change is clean, consistent, and free of leftover debug code, TODOs, or rough edges.',
};

function buildGatePrompt(gate: string, input: ReviewPipelineInput): string {
  const isRating = RATING_GATES.has(gate);
  const reviewer = GATE_REVIEWERS[gate] ?? 'reviewer';
  const rubric = GATE_RUBRICS[gate] ?? 'Review the diff for correctness and quality.';

  const verdictSpec = isRating
    ? `Respond with ONLY a JSON object: {"rating": <integer 1-5>, "notes": "<one-sentence justification>"}. A rating of 4 or 5 means the work is acceptable; 1-3 means it must be bounced back for rework.`
    : `Respond with ONLY a JSON object: {"result": "pass" | "fail", "notes": "<one-sentence justification>"}. Use "fail" if the work does not meet the bar and must be bounced back.`;

  return [
    `You are ${reviewer}, performing the "${gate}" review gate.`,
    `## Rubric\n${rubric}`,
    `## Task\nTask ID: ${input.taskId}`,
    `## Worktree Diff\n\`\`\`diff\n${input.worktreeDiff || '(no diff provided)'}\n\`\`\``,
    `## Verdict\n${verdictSpec}`,
  ].join('\n\n');
}

/**
 * Build a real GateRunner. The optional `model` lets the host route gates to a
 * specific provider model (defaults to a fast, capable model for review work).
 */
export function createGateRunner(model: string = 'sonnet'): GateRunner {
  return async (gate: string, input: ReviewPipelineInput): Promise<GateResult> => {
    const isRating = RATING_GATES.has(gate);
    const reviewer = GATE_REVIEWERS[gate] ?? 'unknown';
    const type: GateResult['type'] = isRating ? 'rating' : 'pass-fail';

    const failClosed = (notes: string): GateResult => ({
      gate,
      type,
      result: isRating ? 1 : 'fail',
      reviewer,
      notes,
    });

    try {
      const { json, raw } = await invokeModel({
        prompt: buildGatePrompt(gate, input),
        model,
        timeoutMs: 120_000,
      });

      if (!json) {
        return failClosed(`No parseable verdict returned: ${raw.slice(0, 200)}`);
      }

      const notes = typeof json.notes === 'string' ? json.notes : '';

      if (isRating) {
        const rating = coerceRating(json.rating ?? json.result);
        if (rating === null) {
          return failClosed(`Missing/invalid rating in verdict: ${raw.slice(0, 200)}`);
        }
        return { gate, type, result: rating, reviewer, notes };
      }

      const result = coercePassFail(json.result);
      if (result === null) {
        return failClosed(`Missing/invalid result in verdict: ${raw.slice(0, 200)}`);
      }
      return { gate, type, result, reviewer, notes };
    } catch (err) {
      return failClosed(`Gate model invocation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

function coerceRating(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : NaN;
  if (Number.isFinite(n)) {
    return Math.max(1, Math.min(5, Math.round(n)));
  }
  return null;
}

function coercePassFail(value: unknown): 'pass' | 'fail' | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'pass' || v === 'passed' || v === 'true') return 'pass';
  if (v === 'fail' || v === 'failed' || v === 'false') return 'fail';
  return null;
}
