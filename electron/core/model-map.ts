/**
 * Phase-A model mapping placeholder.
 *
 * The roster's `agent.config.yaml` files reference provider-qualified
 * model-catalog ids (e.g. `anthropic:claude-sonnet-4-6`, `copilot:gpt-5.4-mini`).
 * The Claude provider, however, only understands its short model names
 * (`sonnet`, `opus`, `haiku`, `default`, …) as returned by `getModels()`.
 *
 * This module bridges the two so a cast member launches on its *recommended*
 * model immediately. It is deliberately small and hard-coded — the real,
 * availability-/window-aware `resolveModel` is Phase C (§8). When the catalog
 * id cannot be matched to a known provider model, we return `undefined` so the
 * caller falls back to the provider default (no model flag).
 */

import { getProvider } from '../providers';

/**
 * Map a provider-qualified catalog model id to the Claude provider's short
 * model name.
 *
 * @example
 *   mapCatalogModelToProviderModel('anthropic:claude-sonnet-4-6') // 'sonnet'
 *   mapCatalogModelToProviderModel('anthropic:claude-opus-4-6')   // 'opus'
 *   mapCatalogModelToProviderModel('anthropic:claude-haiku-4-5')  // 'haiku'
 *   mapCatalogModelToProviderModel('copilot:gpt-5.4-mini')        // undefined
 *
 * @returns The short model name, or `undefined` when no Anthropic family match
 *          is found (caller should then launch on the provider default).
 */
export function mapCatalogModelToProviderModel(catalogId: string | undefined): string | undefined {
  if (!catalogId) return undefined;

  // Phase A casts on Claude. Only Anthropic catalog ids map cleanly to the
  // Claude provider's short names; non-Anthropic ids (copilot:, nous:, …) have
  // no Claude equivalent and fall through to the provider default.
  const [vendor, rawName] = catalogId.includes(':')
    ? [catalogId.slice(0, catalogId.indexOf(':')), catalogId.slice(catalogId.indexOf(':') + 1)]
    : ['anthropic', catalogId];

  if (vendor !== 'anthropic') return undefined;

  const name = rawName.toLowerCase();
  const providerModelIds = new Set(getProvider('claude').getModels().map((m) => m.id));

  // Match Claude family keywords against the provider's known short ids.
  // Order matters: check the most specific families first.
  const familyOrder: Array<{ keyword: string; modelId: string }> = [
    { keyword: 'opus', modelId: 'opus' },
    { keyword: 'sonnet', modelId: 'sonnet' },
    { keyword: 'haiku', modelId: 'haiku' },
  ];

  for (const { keyword, modelId } of familyOrder) {
    if (name.includes(keyword) && providerModelIds.has(modelId)) {
      return modelId;
    }
  }

  return undefined;
}
