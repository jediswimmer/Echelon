// electron/core/model-clients/hermes.ts — Hermes 4th Counselor seat (real, wraps B1).
//
// Replaces the dropped Grok seat per spec
// (src/team-factory/archetypes/counselor-convener/agent.config.yaml: seat hermes
//  → model nous:hermes-4, fallback mini:hermes-4).
//
// Primary path: the Nous Research endpoint, reached by overriding ANTHROPIC_BASE_URL
// for the one-shot CLI call. Fallback: the local Tasmania endpoint (mini:hermes-4),
// resolved the same way agent-manager.ts bakes Tasmania env vars into a PTY.
import { invokeModel } from '../model-invoke';
import { parseRating, type ModelClient, type ModelRequest, type ModelResponse } from './types';
import { getTasmaniaStatus } from '../../services/tasmania-client';

export interface HermesClientOptions {
  /** Remote Nous endpoint base url (without trailing /v1). */
  remoteBaseUrl?: string;
  /** API key for the remote Nous endpoint, if required. */
  apiKey?: string;
  /** Remote model slug. */
  remoteModel?: string;
  /** Local fallback model slug (Tasmania). */
  localModel?: string;
}

export class HermesClient implements ModelClient {
  readonly name = 'hermes';
  readonly lineage = 'hermes-family';
  private readonly remoteBaseUrl?: string;
  private readonly apiKey?: string;
  private readonly remoteModel: string;
  private readonly localModel: string;

  constructor(options: HermesClientOptions = {}) {
    this.remoteBaseUrl = options.remoteBaseUrl;
    this.apiKey = options.apiKey;
    this.remoteModel = options.remoteModel ?? 'nous:hermes-4';
    this.localModel = options.localModel ?? 'mini:hermes-4';
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const start = Date.now();
    const prompt = `${request.system}\n\n${request.user}`;

    // 1. Primary: remote Nous endpoint, if a base url is configured.
    if (this.remoteBaseUrl) {
      try {
        const env: Record<string, string | undefined> = {
          ANTHROPIC_BASE_URL: this.remoteBaseUrl,
          ANTHROPIC_MODEL: this.remoteModel,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        };
        if (this.apiKey) env.ANTHROPIC_API_KEY = this.apiKey;
        const { raw } = await invokeModel({
          provider: 'claude',
          prompt,
          timeoutMs: 120_000,
          env,
        });
        return this.toResponse(raw, this.remoteModel, prompt, start);
      } catch (err) {
        console.warn('[Hermes] remote endpoint failed, falling back to Tasmania:', err);
      }
    }

    // 2. Fallback: local Tasmania endpoint (mini:hermes-4).
    const tasmania = await getTasmaniaStatus();
    if (tasmania.status === 'running' && tasmania.endpoint) {
      const baseUrl = tasmania.endpoint.replace(/\/v1\/?$/, '');
      const localModel = tasmania.modelName || this.localModel;
      const { raw } = await invokeModel({
        provider: 'claude',
        prompt,
        timeoutMs: 120_000,
        env: {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_MODEL: localModel,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      });
      return this.toResponse(raw, this.localModel, prompt, start);
    }

    throw new Error('Hermes unavailable: no remote endpoint configured and Tasmania is not running');
  }

  async health(): Promise<boolean> {
    if (this.remoteBaseUrl) return true;
    try {
      const tasmania = await getTasmaniaStatus();
      return tasmania.status === 'running';
    } catch {
      return false;
    }
  }

  private toResponse(raw: string, model: string, prompt: string, start: number): ModelResponse {
    return {
      content: raw,
      model,
      tokens_used: Math.ceil((prompt.length + raw.length) / 4),
      rating: parseRating(raw),
      duration_ms: Date.now() - start,
    };
  }
}
