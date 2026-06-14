// electron/core/model-clients/types.ts
// Copied + adapted from build/counselor/models/types.ts (Phase B3).
// Common interface for all Counselor model clients (each real client wraps B1).

export interface ModelRequest {
  system: string;
  user: string;
  temperature: number;
  max_tokens: number;
}

export interface ModelResponse {
  content: string;
  model: string;
  tokens_used: number;
  rating?: number;
  duration_ms: number;
}

export interface ModelClient {
  name: string;
  lineage: string;
  invoke(request: ModelRequest): Promise<ModelResponse>;
  health(): Promise<boolean>;
}

/**
 * Extract a 1-5 rating from a model's free-text/JSON response.
 * Shared by every real seat. Prefers a JSON `rating` field, then a
 * "Rating: N/5" style mention, then a bare 1-5 digit.
 */
export function parseRating(content: string): number | undefined {
  // JSON rating field
  const jsonMatch = content.match(/"rating"\s*:\s*(\d)/i);
  if (jsonMatch) return clampRating(parseInt(jsonMatch[1], 10));

  // "Rating: 4/5" or "rate it a 4"
  const phraseMatch = content.match(/rat(?:e|ing)[^\d]{0,12}(\d)\s*(?:\/\s*5)?/i);
  if (phraseMatch) return clampRating(parseInt(phraseMatch[1], 10));

  // Bare "N/5"
  const slashMatch = content.match(/(\d)\s*\/\s*5/);
  if (slashMatch) return clampRating(parseInt(slashMatch[1], 10));

  return undefined;
}

function clampRating(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(5, n));
}
