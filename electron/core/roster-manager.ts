import * as fs from 'fs';
import * as path from 'path';

export interface RosterCharacterEntry {
  archetype: string;
  character: string;
  capabilities: string[];
}

export interface RosterManifestData {
  season_id: string;
  season_slug: string;
  theme: string;
  tier: 'medium' | 'large' | 'enterprise';
  roster: RosterCharacterEntry[];
  channels?: Record<string, unknown>;
  user_context?: Record<string, unknown>;
  /** Source-control linkage (mirrors Season.sourceControl). Omitted ⇒ local. */
  source_control?: { type: 'local' | 'github' | 'azure-devops' | 'local-clone'; repo_url?: string; local_path?: string };
  /** Linked Jira project key (mirrors Season.jiraProjectKey). */
  jira_project_key?: string;
}

function parseYamlSimple(content: string): Record<string, unknown> {
  // Simple YAML parser for roster manifests — handles flat keys and arrays
  // For production, consider js-yaml, but keeping deps minimal in electron/
  try {
    const lines = content.split('\n');
    const result: Record<string, unknown> = {};
    let currentKey = '';
    let currentArray: unknown[] | null = null;
    let currentObject: Record<string, unknown> | null = null;

    for (const line of lines) {
      if (line.startsWith('#') || line.trim() === '') continue;

      if (!line.startsWith(' ') && !line.startsWith('-')) {
        if (currentArray && currentKey) {
          result[currentKey] = currentArray;
          currentArray = null;
          currentObject = null;
        }
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          currentKey = key;
          if (value) {
            result[key] = value;
          }
        }
      } else if (line.trim().startsWith('- ') && !line.trim().startsWith('- {')) {
        if (!currentArray) currentArray = [];
        const val = line.trim().slice(2);
        if (val.includes(':')) {
          // Start of object in array
          currentObject = {};
          const [k, v] = val.split(':').map(s => s.trim());
          currentObject[k] = v;
          currentArray.push(currentObject);
        } else {
          currentArray.push(val);
        }
      } else if (currentObject && line.trim().match(/^\w+:/)) {
        const [k, ...rest] = line.trim().split(':');
        const v = rest.join(':').trim();
        currentObject[k.trim()] = v.startsWith('[') ? JSON.parse(v.replace(/'/g, '"')) : v;
      }
    }

    if (currentArray && currentKey) {
      result[currentKey] = currentArray;
    }

    return result;
  } catch {
    return {};
  }
}

export function loadRosterManifest(manifestPath: string): RosterManifestData | null {
  if (!fs.existsSync(manifestPath)) return null;

  const content = fs.readFileSync(manifestPath, 'utf-8');
  const data = parseYamlSimple(content);

  return {
    season_id: (data.season_id as string) || '',
    season_slug: (data.season_slug as string) || '',
    theme: (data.theme as string) || '',
    tier: (data.tier as 'medium' | 'large' | 'enterprise') || 'medium',
    roster: (data.roster as RosterCharacterEntry[]) || [],
    channels: data.channels as Record<string, unknown>,
    user_context: data.user_context as Record<string, unknown>,
  };
}

export function saveRosterManifest(manifestPath: string, manifest: RosterManifestData): void {
  const dir = path.dirname(manifestPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const lines: string[] = [
    `season_id: ${manifest.season_id}`,
    `season_slug: ${manifest.season_slug}`,
    `theme: ${manifest.theme}`,
    `tier: ${manifest.tier}`,
  ];

  // Source-control + Jira linkage (flat scalars; the simple parser tolerates
  // extra top-level keys and we only ever read these back from season.json).
  if (manifest.source_control) {
    lines.push(`source_control_type: ${manifest.source_control.type}`);
    if (manifest.source_control.repo_url) {
      lines.push(`source_control_repo_url: ${manifest.source_control.repo_url}`);
    }
    if (manifest.source_control.local_path) {
      lines.push(`source_control_local_path: ${manifest.source_control.local_path}`);
    }
  }
  if (manifest.jira_project_key) {
    lines.push(`jira_project_key: ${manifest.jira_project_key}`);
  }

  lines.push('roster:');

  for (const entry of manifest.roster) {
    lines.push(`  - archetype: ${entry.archetype}`);
    lines.push(`    character: ${entry.character}`);
    lines.push(`    capabilities: [${entry.capabilities.map(c => `'${c}'`).join(', ')}]`);
  }

  fs.writeFileSync(manifestPath, lines.join('\n') + '\n', 'utf-8');
}

export function addCharacterToRoster(
  manifestPath: string,
  entry: RosterCharacterEntry
): void {
  const manifest = loadRosterManifest(manifestPath);
  if (!manifest) throw new Error(`Roster manifest not found: ${manifestPath}`);

  const existing = manifest.roster.find(r => r.character === entry.character);
  if (existing) throw new Error(`Character ${entry.character} already in roster`);

  manifest.roster.push(entry);
  saveRosterManifest(manifestPath, manifest);
}

export function removeCharacterFromRoster(
  manifestPath: string,
  characterSlug: string
): void {
  const manifest = loadRosterManifest(manifestPath);
  if (!manifest) throw new Error(`Roster manifest not found: ${manifestPath}`);

  manifest.roster = manifest.roster.filter(r => r.character !== characterSlug);
  saveRosterManifest(manifestPath, manifest);
}
