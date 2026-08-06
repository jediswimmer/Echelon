/**
 * Model Invocation Primitive (B1)
 *
 * The single real one-shot model-call primitive shared by the GateRunner (B2)
 * and every Counselor ModelClient (B3). Mirrors the proven pattern in
 * `electron/utils/kanban-generate.ts` — build a one-shot CLI command via the
 * provider, run it through `exec` with a fully-resolved PATH, and extract a
 * structured JSON verdict from the model's stdout.
 *
 * Both the review gates and the Counselor seats wrap this; nothing else in the
 * quality loop talks to a model directly.
 */

import { exec } from 'child_process';
import { buildFullPath } from '../utils/path-builder';
import { getProvider } from '../providers';
import type { AgentProvider } from '../types';

export interface ModelInvokeOptions {
  /** Provider to route through (defaults to Claude — the only one with a verified one-shot path). */
  provider?: AgentProvider;
  /** Full prompt (system context + task) flattened into the one-shot prompt. */
  prompt: string;
  /** Provider model id (e.g. 'opus', 'sonnet', 'haiku', or a base-url-routed slug). */
  model?: string;
  /** Hard timeout for the CLI call. Defaults to 120s to match the Counselor per-model budget. */
  timeoutMs?: number;
  /** Max stdout buffer. Defaults to 4 MiB. */
  maxBuffer?: number;
  /**
   * Extra environment variables merged over the resolved PATH env. Used to inject
   * provider API keys (Counselor) and base-url overrides (Hermes → Tasmania).
   */
  env?: Record<string, string | undefined>;
}

export interface ModelInvokeResult {
  /** Trimmed raw stdout from the CLI. */
  raw: string;
  /** First JSON object/array parsed out of the output, or null if none found. */
  json: Record<string, unknown> | null;
}

/**
 * Run a one-shot model invocation and return the raw text plus any parsed JSON.
 * Throws if the underlying CLI call errors or times out — callers decide how to
 * degrade (gates fail-closed, Counselor seats are silently dropped from quorum).
 */
export async function invokeModel(options: ModelInvokeOptions): Promise<ModelInvokeResult> {
  const {
    provider = 'claude',
    prompt,
    model,
    timeoutMs = 120_000,
    maxBuffer = 4 * 1024 * 1024,
    env = {},
  } = options;

  const cliProvider = getProvider(provider);
  const command = cliProvider.buildOneShotCommand({
    binaryPath: cliProvider.binaryName,
    prompt,
    model,
  });

  const fullPath = buildFullPath();

  // Merge caller-supplied env (keys / base-url overrides) over the resolved PATH env.
  // Drop undefined values so we never set a var to the string "undefined".
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, PATH: fullPath };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      mergedEnv[key] = value;
    }
  }

  const raw = await new Promise<string>((resolve, reject) => {
    exec(
      command,
      { env: mergedEnv, timeout: timeoutMs, maxBuffer },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });

  return { raw, json: extractJson(raw) };
}

/**
 * Extract the first JSON object or array embedded in arbitrary model output.
 * Mirrors the tolerant extraction in kanban-generate (models often wrap JSON in
 * prose or fenced code blocks).
 */
export function extractJson(text: string): Record<string, unknown> | null {
  // Prefer a fenced ```json ... ``` block if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced && fenced[1]) {
    candidates.push(fenced[1].trim());
  }
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    candidates.push(objectMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
