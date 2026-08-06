/**
 * Counselor Service — Multi-model consensus engine for Echelon placements (B3)
 *
 * Fans out to 4 real model seats in parallel via the copied build orchestration
 * (`Counselor` + `computeConsensus`), each seat wrapping the B1 model-invoke
 * primitive. Applies placement-specific consensus, enforces quorum, and maps the
 * build verdict back to the Electron `CounselorVerdict` shape the IPC contract +
 * `CounselorVerdict.tsx` UI expect.
 *
 * Seats (Grok dropped per spec; Hermes added as the 4th):
 *   opus (anthropic) · gpt5 · gemini · hermes (nous:hermes-4 → Tasmania fallback)
 */

import { Counselor, type CounselorVerdict as BuildVerdict, type PlacementId } from './counselor/counselor';
import { OpusClient } from '../core/model-clients/opus';
import { GPT5Client } from '../core/model-clients/gpt5';
import { GeminiClient } from '../core/model-clients/gemini';
import { HermesClient } from '../core/model-clients/hermes';

// ---------------------------------------------------------------------------
// Types (Electron-facing — unchanged contract for IPC + UI)
// ---------------------------------------------------------------------------

export type CounselorPlacement =
  | 'skill-promotion'
  | 'design-review'
  | 'deadlock-escalation'
  | 'adversarial';

export type CounselorDecision = 'approve' | 'reject' | 'escalate';

export interface ModelVerdict {
  model: string;
  decision: CounselorDecision;
  confidence: number;
  reasoning: string;
  latencyMs: number;
}

export interface CounselorVerdict {
  placement: CounselorPlacement;
  decision: CounselorDecision;
  confidence: number;
  modelVerdicts: ModelVerdict[];
  timestamp: string;
}

interface ModelKeys {
  geminiKey?: string;
  openaiKey?: string;
  anthropicKey?: string;
  grokKey?: string;
}

// ---------------------------------------------------------------------------
// Available placements with metadata
// ---------------------------------------------------------------------------

export const PLACEMENTS: Record<CounselorPlacement, { label: string; description: string; algorithm: string }> = {
  'skill-promotion': {
    label: 'Skill Promotion',
    description: 'Placement A — min-score (every seat ≥4), 4/4 quorum',
    algorithm: 'min-score',
  },
  'design-review': {
    label: 'Design Review',
    description: 'Placement B — majority (3/4 agree) to approve a design',
    algorithm: 'majority',
  },
  'deadlock-escalation': {
    label: 'Deadlock Escalation',
    description: 'Placement C — binding majority verdict to break a deadlock',
    algorithm: 'majority',
  },
  'adversarial': {
    label: 'Adversarial Review',
    description: 'Placement D — independent majority risk assessment',
    algorithm: 'majority',
  },
};

// Electron placement string → build PlacementId.
const PLACEMENT_ID: Record<CounselorPlacement, PlacementId> = {
  'skill-promotion': 'A',
  'design-review': 'B',
  'deadlock-escalation': 'C',
  'adversarial': 'D',
};

// ---------------------------------------------------------------------------
// Model identifiers (current seat roster — Grok dropped, Hermes added)
// ---------------------------------------------------------------------------

const MODELS = [
  'claude-opus-4-8',
  'copilot:gpt-5.4',
  'copilot:gemini-3-pro-preview',
  'nous:hermes-4',
] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Invoke the Counselor panel for a given placement and context.
 * Constructs the 4 real seats, runs the build orchestration at the mapped
 * placement, and maps the rating-based build verdict to the Electron shape.
 */
export async function invokeCounselor(
  placement: CounselorPlacement,
  context: string,
  keys: ModelKeys = {},
): Promise<CounselorVerdict> {
  const opus = new OpusClient({ apiKey: keys.anthropicKey });
  const gpt5 = new GPT5Client({ apiKey: keys.openaiKey });
  const gemini = new GeminiClient({ apiKey: keys.geminiKey });
  const hermes = new HermesClient({
    remoteBaseUrl: process.env.HERMES_BASE_URL || undefined,
    apiKey: process.env.HERMES_API_KEY || undefined,
  });

  const counselor = new Counselor([opus, gpt5, gemini, hermes]);

  const buildVerdict = await counselor.invoke({
    placement: PLACEMENT_ID[placement],
    convener: 'counselor-service',
    prompt_context: {
      system:
        'You are a member of the Echelon Counselor council. Independently assess the ' +
        'matter below and return a rating from 1 (reject) to 5 (strong approve). ' +
        'Respond with a JSON object {"rating": <1-5>, "notes": "<one sentence>"}.',
      user: context,
    },
  });

  return mapBuildVerdict(placement, buildVerdict);
}

/**
 * Map a rating-based build verdict to the Electron decision/confidence shape.
 * - Council approved → 'approve'; otherwise 'reject' unless the split is
 *   marginal (high stdev / near threshold) in which case 'escalate'.
 * - confidence is normalized to 0..1 from the 1..5 final rating.
 * - per-seat ratings map to per-model decisions (≥4 approve, ≤2 reject, else escalate).
 */
function mapBuildVerdict(placement: CounselorPlacement, v: BuildVerdict): CounselorVerdict {
  const modelVerdicts: ModelVerdict[] = v.per_model_responses.map((r) => {
    const rating = r.rating ?? 0;
    return {
      model: r.model,
      decision: ratingToDecision(rating),
      confidence: clamp01(rating / 5),
      reasoning: truncate(r.content, 400),
      latencyMs: r.duration_ms,
    };
  });

  const finalRating = v.consensus.final_rating;
  const confidence = clamp01(finalRating / 5);

  let decision: CounselorDecision;
  if (v.consensus.approved) {
    decision = 'approve';
  } else if (finalRating >= 3 || v.consensus.stdev >= 1) {
    // Marginal / divided council → escalate rather than hard-reject.
    decision = 'escalate';
  } else {
    decision = 'reject';
  }

  return {
    placement,
    decision,
    confidence: Math.round(confidence * 100) / 100,
    modelVerdicts,
    timestamp: new Date().toISOString(),
  };
}

function ratingToDecision(rating: number): CounselorDecision {
  if (rating >= 4) return 'approve';
  if (rating <= 2) return 'reject';
  return 'escalate';
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * List available placements with their descriptions.
 */
export function listPlacements() {
  return Object.entries(PLACEMENTS).map(([id, meta]) => ({
    id,
    ...meta,
  }));
}

/** Exposed for diagnostics / tests — the current seat model identifiers. */
export function listModels(): readonly string[] {
  return MODELS;
}

/**
 * Resolve model API keys from CLI auth configs and app settings.
 *
 * - Anthropic: ANTHROPIC_API_KEY env var (set when Claude CLI is configured)
 * - OpenAI: access_token from ~/.codex/auth.json (Codex CLI OAuth)
 * - Gemini: GOOGLE_API_KEY or GEMINI_API_KEY env var, or gcloud ADC
 * - Grok: dedicated field in app settings (legacy; retained for compatibility)
 */
export function resolveModelKeys(appSettings: Record<string, unknown>): ModelKeys {
  return {
    anthropicKey: resolveAnthropicKey(),
    openaiKey: resolveOpenAIKey(),
    geminiKey: resolveGeminiKey(),
    grokKey: (appSettings.grokApiKey as string) || undefined,
  };
}

function resolveAnthropicKey(): string | undefined {
  // 1. Environment variable (standard Anthropic SDK pattern)
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // 2. Check ~/.anthropic/config if it exists
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(require('os').homedir(), '.anthropic', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.api_key) return config.api_key;
    }
  } catch { /* ignore */ }

  return undefined;
}

function resolveOpenAIKey(): string | undefined {
  // 1. Environment variable
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  // 2. Codex CLI auth — uses OAuth access_token
  try {
    const fs = require('fs');
    const path = require('path');
    const authPath = path.join(require('os').homedir(), '.codex', 'auth.json');
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      // Prefer explicit API key, fall back to OAuth access token
      if (auth.OPENAI_API_KEY) return auth.OPENAI_API_KEY;
      if (auth.tokens?.access_token) return auth.tokens.access_token;
    }
  } catch { /* ignore */ }

  return undefined;
}

function resolveGeminiKey(): string | undefined {
  // 1. Environment variables (Google AI Studio / Vertex patterns)
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;

  // 2. gcloud application default credentials (ADC)
  try {
    const fs = require('fs');
    const path = require('path');
    const adcPath = path.join(require('os').homedir(), '.config', 'gcloud', 'application_default_credentials.json');
    if (fs.existsSync(adcPath)) {
      const adc = JSON.parse(fs.readFileSync(adcPath, 'utf-8'));
      // ADC uses OAuth — return the client_id as a signal that auth exists
      if (adc.client_id) return `adc:${adc.client_id}`;
    }
  } catch { /* ignore */ }

  return undefined;
}
