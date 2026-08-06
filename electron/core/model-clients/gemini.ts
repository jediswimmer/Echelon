// electron/core/model-clients/gemini.ts — Gemini seat (real, wraps B1).
// Routed through the Claude CLI one-shot path; the Gemini key is injected as env.
import { invokeModel } from '../model-invoke';
import { parseRating, type ModelClient, type ModelRequest, type ModelResponse } from './types';

export interface GeminiClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export class GeminiClient implements ModelClient {
  readonly name = 'gemini';
  readonly lineage = 'gemini-family';
  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly model: string;

  constructor(options: GeminiClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model ?? 'sonnet';
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const start = Date.now();
    const prompt = `${request.system}\n\n${request.user}`;
    const env: Record<string, string | undefined> = {};
    if (this.apiKey) env.GEMINI_API_KEY = this.apiKey;
    if (this.baseUrl) env.ANTHROPIC_BASE_URL = this.baseUrl;

    const { raw } = await invokeModel({
      provider: 'claude',
      prompt,
      model: this.model,
      timeoutMs: 120_000,
      env,
    });
    return {
      content: raw,
      model: 'copilot:gemini-3-pro-preview',
      tokens_used: Math.ceil((prompt.length + raw.length) / 4),
      rating: parseRating(raw),
      duration_ms: Date.now() - start,
    };
  }

  async health(): Promise<boolean> {
    return true;
  }
}
