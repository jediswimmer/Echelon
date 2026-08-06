/**
 * PRD parser.
 *
 * Copy-and-adapted from `build/lib/prd-parser.ts` into `electron/core/` (the
 * same pattern Phase B used for build/counselor → electron/core). Two changes
 * from the source:
 *   1. The `.ts` import extensions are not used here (this file has no internal
 *      imports), matching the electron module style.
 *   2. The original depended on `gray-matter` for frontmatter; `gray-matter` is
 *      not a direct electron dependency, so we parse frontmatter inline with a
 *      tiny scanner (mirrors `character-loader.parseFrontmatter`). This keeps
 *      the composer on already-present deps only.
 *
 * Turns a free-form PRD/BRD description into structured scope hints the roster
 * composer maps to an ordered set of archetypes.
 */

export interface ParsedPRD {
  title: string;
  goals: string[];
  user_stories: string[];
  stakeholders: string[];
  scope_hints: {
    platforms: string[];
    compliance: string[];
    technologies: string[];
    tier_estimate: 'medium' | 'large' | 'enterprise';
  };
  raw: string;
}

const PLATFORM_KEYWORDS = [
  'ios',
  'android',
  'mobile',
  'web',
  'desktop',
  'electron',
  'react native',
  'flutter',
];
const COMPLIANCE_KEYWORDS = [
  'hipaa',
  'soc2',
  'soc 2',
  'gdpr',
  'ccpa',
  'pci',
  'fedramp',
  'iso 27001',
];
const TECH_KEYWORDS = [
  'react',
  'vue',
  'angular',
  'next.js',
  'node',
  'python',
  'django',
  'fastapi',
  'postgres',
  'mongodb',
  'redis',
  'kubernetes',
  'docker',
  'terraform',
  'aws',
  'gcp',
  'azure',
  'graphql',
  'rest api',
  'grpc',
  'kafka',
  'rabbitmq',
];

/**
 * Split YAML frontmatter (a leading `---` fenced block) from the markdown body.
 * Only the `title` key is read out (the sole frontmatter field the original
 * parser consumed), keeping this dependency-free.
 */
function splitFrontmatter(content: string): { title?: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { body: content };

  let title: string | undefined;
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key === 'title') {
      title = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return { title, body: match[2] };
}

function extractSection(content: string, heading: string): string[] {
  const regex = new RegExp(`##\\s*${heading}[\\s\\S]*?(?=\\n##\\s|$)`, 'i');
  const match = content.match(regex);
  if (!match) return [];
  return match[0]
    .split('\n')
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => line.replace(/^[-*]\s+/, '').trim());
}

function detectKeywords(content: string, keywords: string[]): string[] {
  const lower = content.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase()));
}

function estimateTier(
  platforms: string[],
  compliance: string[],
  technologies: string[],
  content: string
): 'medium' | 'large' | 'enterprise' {
  let score = 0;
  score += platforms.length * 2;
  score += compliance.length * 3;
  score += technologies.length;
  if (content.length > 5000) score += 2;
  if (content.length > 10000) score += 3;
  if (score >= 15) return 'enterprise';
  if (score >= 7) return 'large';
  return 'medium';
}

export function parsePRD(content: string): ParsedPRD {
  const { title: fmTitle, body } = splitFrontmatter(content);
  const title = fmTitle || body.match(/^#\s+(.+)/m)?.[1]?.trim() || 'Untitled PRD';
  const goals = extractSection(body, 'Goals?');
  const user_stories = extractSection(body, 'User Stor(?:y|ies)');
  const stakeholders = extractSection(body, 'Stakeholders?');
  const platforms = detectKeywords(body, PLATFORM_KEYWORDS);
  const compliance = detectKeywords(body, COMPLIANCE_KEYWORDS);
  const technologies = detectKeywords(body, TECH_KEYWORDS);
  const tier_estimate = estimateTier(platforms, compliance, technologies, body);

  return {
    title,
    goals,
    user_stories,
    stakeholders,
    scope_hints: { platforms, compliance, technologies, tier_estimate },
    raw: content,
  };
}
