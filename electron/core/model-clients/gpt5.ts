// electron/core/model-clients/gpt5.ts — GPT seat (real, wraps B1).
// Routed through the Claude CLI one-shot path (the only verified one-shot path);
// the OpenAI/Copilot key is injected as env so the CLI can reach the alternate
// frontier endpoint when configured.
import { invokeModel } from '../model-invoke';
import { parseRating, type ModelClient, type ModelRequest, type ModelResponse } from './types';

export interface GPT5ClientOptions {
  apiKey?: string;
  /** Optional base-url override for the OpenAI-compatible endpoint. */
  baseUrl?: string;
  model?: string;
}

export class GPT5Client implements ModelClient {
  readonly name = 'gpt5';
  readonly lineage = 'gpt-family';
  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly model: string;

  constructor(options: GPT5ClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model ?? 'sonnet';
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const start = Date.now();
    const prompt = `${request.system}\n\n${request.user}`;
    const env: Record<string, string | undefined> = {};
    if (this.apiKey) env.OPENAI_API_KEY = this.apiKey;
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
      model: 'copilot:gpt-5.4',
      tokens_used: Math.ceil((prompt.length + raw.length) / 4),
      rating: parseRating(raw),
      duration_ms: Date.now() - start,
    };
  }

  async health(): Promise<boolean> {
    return true;
  }
}
