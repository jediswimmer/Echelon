/**
 * Season roster composer (PRD → auto-composed roster).
 *
 * The centerpiece of the Core Season Flow: instead of the user hand-picking
 * archetypes + characters, they describe what the team should build (a PRD/BRD)
 * and this module composes the roster for them.
 *
 * Pipeline (mirrors the orphaned `build/ingestion/season-spawn.ts` protocol,
 * re-homed onto the proven Phase-A loaders):
 *   1. `parsePRD`           — free text → structured scope hints + tier
 *   2. `composeInitialRoster` — scope hints → ordered archetype slugs
 *   3. theme resolution     — each archetype → its theme character, primarily
 *      via `loadAgentConfig().character` (the archetype's own agent.config.yaml)
 *      with the theme's `role-mapping.yaml` as a fallback
 *   4. control-team guarantee — always include convener + ingestion-pm +
 *      user-handler, ordered first
 *   5. emit `RosterCharacterEntry[]` ready for `spawnSeason`
 *
 * Archetypes whose character cannot be resolved to a real soul package on disk
 * are dropped (with a warning) rather than aborting the whole compose, so a
 * spawn never fails on one missing character.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getTeamFactoryDir } from '../constants';
import { loadAgentConfig } from './archetype-loader';
import { resolveCharacterDir } from './character-loader';
import { parsePRD } from './prd-parser';
import { composeInitialRoster } from './roster-composer';
import type { RosterCharacterEntry } from './roster-manager';

/**
 * The control team that must always be present regardless of the PRD, in the
 * order the convener/handler hierarchy expects. The convener archetype is
 * `counselor-convener` (resolves to e.g. stephen-hawking for tbbt).
 */
const CONTROL_TEAM = ['counselor-convener', 'ingestion-pm', 'user-handler'];

export interface ComposedRoster {
  entries: RosterCharacterEntry[];
  tier: 'medium' | 'large' | 'enterprise';
  /** Archetypes that were composed but dropped (no resolvable character). */
  dropped: string[];
  rationale: Record<string, string>;
}

/** Cache of theme → (archetype → character) parsed from role-mapping.yaml. */
const roleMappingCache: Map<string, Record<string, string>> = new Map();

/**
 * Load the theme's `role-mapping.yaml` and flatten it to archetype → character.
 * Supports both the `{ roles: { archetype: { character } } }` and flat shapes,
 * matching `build/skills/theme-engine.ts`.
 */
function loadThemeRoleMap(theme: string): Record<string, string> {
  const themeKey = theme.toLowerCase().replace(/\s+/g, '-');
  const cached = roleMappingCache.get(themeKey);
  if (cached) return cached;

  const mappingPath = path.join(getTeamFactoryDir(), 'themes', themeKey, 'role-mapping.yaml');
  const map: Record<string, string> = {};

  if (fs.existsSync(mappingPath)) {
    try {
      const raw = yaml.load(fs.readFileSync(mappingPath, 'utf-8')) as Record<string, unknown>;
      const roles = (raw?.roles ?? raw) as Record<
        string,
        { primary?: string; character?: string } | undefined
      >;
      for (const [archetype, entry] of Object.entries(roles ?? {})) {
        if (archetype === 'meta') continue;
        const character = entry?.primary ?? entry?.character;
        if (character) map[archetype] = character;
      }
    } catch (err) {
      console.warn(`composer: failed to parse role-mapping for theme "${theme}":`, err);
    }
  }

  roleMappingCache.set(themeKey, map);
  return map;
}

/**
 * Resolve an archetype's theme character. Primary source is the archetype's own
 * `agent.config.yaml` (`loadAgentConfig().character`); falls back to the theme's
 * `role-mapping.yaml` when the config has no character (or fails to load).
 */
function resolveCharacterForArchetype(
  archetype: string,
  theme: string,
  roleMap: Record<string, string>
): string | null {
  try {
    const cfg = loadAgentConfig(archetype);
    if (cfg.character) return cfg.character;
  } catch {
    // config missing/malformed — fall through to role-mapping
  }
  return roleMap[archetype] ?? null;
}

/**
 * Compose an ordered, theme-resolved roster from a PRD/BRD description.
 *
 * @param prdText  Free-form PRD/BRD text (the chat input).
 * @param theme    Theme slug (e.g. 'tbbt') used to resolve characters.
 * @returns A {@link ComposedRoster} whose `entries` can be passed straight to
 *          `spawnSeason`.
 */
export function composeRosterFromPrd(prdText: string, theme: string): ComposedRoster {
  const parsed = parsePRD(prdText || '');
  const recommendation = composeInitialRoster(parsed);
  const roleMap = loadThemeRoleMap(theme);

  // Control team first (deduped), then the composed archetypes in their order.
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const archetype of [...CONTROL_TEAM, ...recommendation.archetypes]) {
    if (seen.has(archetype)) continue;
    seen.add(archetype);
    ordered.push(archetype);
  }

  const entries: RosterCharacterEntry[] = [];
  const dropped: string[] = [];

  for (const archetype of ordered) {
    const character = resolveCharacterForArchetype(archetype, theme, roleMap);
    if (!character) {
      dropped.push(archetype);
      console.warn(`composer: no character for archetype "${archetype}" (theme "${theme}") — dropping`);
      continue;
    }

    // Verify a real soul package exists before committing the entry so the
    // downstream cast never fails on a phantom character.
    try {
      resolveCharacterDir(theme, character);
    } catch {
      dropped.push(archetype);
      console.warn(
        `composer: character "${character}" for archetype "${archetype}" has no soul package — dropping`
      );
      continue;
    }

    entries.push({ archetype, character, capabilities: [] });
  }

  return {
    entries,
    tier: recommendation.tier,
    dropped,
    rationale: recommendation.rationale,
  };
}
