// electron/core/model-clients/opus.ts — Anthropic Claude Opus seat (real, wraps B1).
import { invokeModel } from '../model-invoke';
import { parseRating, type ModelClient, type ModelRequest, type ModelResponse } from './types';

export interface OpusClientOptions {
  /** Anthropic API key, injected as ANTHROPIC_API_KEY for the one-shot CLI call. */
  apiKey?: string;
  /** Provider model slug (Claude CLI). */
  model?: string;
}

export class OpusClient implements ModelClient {
  readonly name = 'opus';
  readonly lineage = 'claude-family';
  private readonly apiKey?: string;
  private readonly model: string;

  constructor(options: OpusClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'opus';
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const start = Date.now();
    const prompt = `${request.system}\n\n${request.user}`;
    const { raw } = await invokeModel({
      provider: 'claude',
      prompt,
      model: this.model,
      timeoutMs: 120_000,
      env: this.apiKey ? { ANTHROPIC_API_KEY: this.apiKey } : {},
    });
    return {
      content: raw,
      model: 'claude-opus-4-8',
      tokens_used: estimateTokens(prompt, raw),
      rating: parseRating(raw),
      duration_ms: Date.now() - start,
    };
  }

  async health(): Promise<boolean> {
    return true;
  }
}

function estimateTokens(prompt: string, response: string): number {
  // ~4 chars/token heuristic; budget-tracker only needs an order-of-magnitude figure.
  return Math.ceil((prompt.length + response.length) / 4);
}
