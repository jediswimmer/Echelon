import * as fs from 'fs';
import * as path from 'path';
import type { SoulPackage } from '../types/echelon';
import { getTeamFactoryDir } from '../constants';

const SOUL_FILES = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'MEMORY.seed.md', 'persona.md'];
const OPTIONAL_FILES = ['USER.md', 'COMMITMENTS.md', 'DEPLOY-CHECKLIST.md'];

function readFileOrEmpty(filePath: string): string {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return '';
}

function parseFrontmatter(content: string): { data: Record<string, unknown>; content: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, content };

  const data: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      data[key] = value;
    }
  }
  return { data, content: match[2] };
}

export function loadSoulPackage(characterDir: string): SoulPackage {
  if (!fs.existsSync(characterDir)) {
    throw new Error(`Character directory does not exist: ${characterDir}`);
  }

  const soulRaw = readFileOrEmpty(path.join(characterDir, 'SOUL.md'));
  const { data: frontmatter, content: soul } = parseFrontmatter(soulRaw);

  return {
    soul,
    agents: readFileOrEmpty(path.join(characterDir, 'AGENTS.md')),
    heartbeat: readFileOrEmpty(path.join(characterDir, 'HEARTBEAT.md')),
    memorySeed: readFileOrEmpty(path.join(characterDir, 'MEMORY.seed.md')),
    persona: readFileOrEmpty(path.join(characterDir, 'persona.md')),
    user: readFileOrEmpty(path.join(characterDir, 'USER.md')) || undefined,
    commitments: readFileOrEmpty(path.join(characterDir, 'COMMITMENTS.md')) || undefined,
    deployChecklist: readFileOrEmpty(path.join(characterDir, 'DEPLOY-CHECKLIST.md')) || undefined,
    frontmatter,
  };
}

export function extractCapabilities(soulPackage: SoulPackage): string[] {
  const caps: string[] = [];
  const fm = soulPackage.frontmatter;
  if (fm.capabilities && typeof fm.capabilities === 'string') {
    caps.push(...fm.capabilities.split(',').map(s => s.trim()).filter(Boolean));
  }
  return caps;
}

export function getSoulFiles(characterDir: string): string[] {
  return [...SOUL_FILES, ...OPTIONAL_FILES]
    .map(f => path.join(characterDir, f))
    .filter(f => fs.existsSync(f));
}

/**
 * Resolve the on-disk directory holding a character's soul package.
 *
 * Primary location is the theme's character dir
 * (`<TEAM_FACTORY_DIR>/themes/<theme>/characters/<slug>`). Falls back to the
 * theme-agnostic advisory board
 * (`<TEAM_FACTORY_DIR>/advisory-board/characters/<slug>`).
 *
 * @returns The resolved directory path.
 * @throws if neither location exists.
 */
export function resolveCharacterDir(theme: string, slug: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) {
    throw new Error(`Invalid character slug: ${slug}`);
  }

  const root = getTeamFactoryDir();
  const themeKey = theme.toLowerCase().replace(/\s+/g, '-');

  const themed = path.join(root, 'themes', themeKey, 'characters', slug);
  if (fs.existsSync(themed)) return themed;

  const advisory = path.join(root, 'advisory-board', 'characters', slug);
  if (fs.existsSync(advisory)) return advisory;

  throw new Error(
    `Character directory not found for slug "${slug}" (theme "${theme}"). Looked in: ${themed}, ${advisory}`
  );
}

/**
 * Concatenate a character's soul files in `assemblyOrder` and write the result
 * to `outPath`, returning that path. The output is intended to be passed to the
 * provider's `buildInteractiveCommand({ systemPromptFile })`.
 *
 * Mirrors the proven soul-injection recipe in services/telegram-bot.ts:
 * read N markdown files, concat with section separators, write a single file.
 *
 * @param characterDir   Directory holding the soul files.
 * @param assemblyOrder  Ordered list of soul file names to concatenate.
 * @param outPath        Destination path for the assembled system prompt.
 * @returns The `outPath` it wrote to.
 */
export function assembleSoulPromptFile(
  characterDir: string,
  assemblyOrder: string[],
  outPath: string
): string {
  const sections: string[] = [];
  for (const fileName of assemblyOrder) {
    const filePath = path.join(characterDir, fileName);
    const content = readFileOrEmpty(filePath);
    if (content.trim()) {
      // Strip frontmatter from SOUL.md so YAML metadata doesn't leak into the
      // system prompt; other files have none and pass through unchanged.
      const body = fileName === 'SOUL.md' ? parseFrontmatter(content).content : content;
      sections.push(`<!-- ${fileName} -->\n${body.trim()}`);
    }
  }

  const assembled = sections.join('\n\n---\n\n');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, assembled, 'utf-8');

  return outPath;
}
