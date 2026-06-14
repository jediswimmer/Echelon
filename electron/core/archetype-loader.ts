/**
 * Archetype config loader.
 *
 * Parses an archetype's `agent.config.yaml` (the rich, nested config that the
 * flat `parseYamlSimple` in roster-manager cannot handle) with js-yaml and
 * returns the subset of fields the Phase-A casting bridge needs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getTeamFactoryDir } from '../constants';

/** Normalized, runtime-facing view of an archetype's `agent.config.yaml`. */
export interface AgentConfig {
  /** Archetype slug, e.g. 'backend-engineer'. */
  archetype: string;
  /** Default theme character slug, e.g. 'stuart-bloom'. */
  character: string;
  /** Theme slug, e.g. 'tbbt'. */
  theme: string;
  /** Soul package file names (unordered set). */
  soulFiles: string[];
  /** Order in which soul files are concatenated into the system prompt. */
  assemblyOrder: string[];
  /** Recommended provider-qualified model id, e.g. 'anthropic:claude-sonnet-4-6'. */
  modelPrimary?: string;
  /** Shared skill slugs the agent should load. */
  skills: string[];
  /** MCP server names the agent connects to. */
  mcpServers: string[];
  /** Autonomy level from guardrails, e.g. 'supervised' | 'autonomous' | 'bounded-authority'. */
  autonomy?: string;
}

/** Raw shape of the nested fields we read out of agent.config.yaml. */
interface RawAgentConfig {
  identity?: {
    archetype?: string;
    character?: string;
    theme?: string;
  };
  prompt_assembly?: {
    soul_files?: string[];
    assembly_order?: string[];
  };
  model?: {
    primary?: string[];
  };
  skills?: {
    shared?: Array<{ skill?: string } | string>;
  };
  connectors?: {
    mcp_servers?: Array<{ server?: string } | string>;
  };
  guardrails?: {
    autonomy_level?: string;
  };
}

const DEFAULT_SOUL_FILES = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'MEMORY.seed.md', 'persona.md'];
const DEFAULT_ASSEMBLY_ORDER = ['SOUL.md', 'persona.md', 'AGENTS.md', 'HEARTBEAT.md', 'MEMORY.seed.md'];

/**
 * Load and normalize an archetype's `agent.config.yaml`.
 *
 * @param archetype  The archetype slug (directory name under archetypes/).
 * @throws if the config file does not exist or fails to parse.
 */
export function loadAgentConfig(archetype: string): AgentConfig {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(archetype)) {
    throw new Error(`Invalid archetype slug: ${archetype}`);
  }

  const configPath = path.join(getTeamFactoryDir(), 'archetypes', archetype, 'agent.config.yaml');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Archetype config not found: ${configPath}`);
  }

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as RawAgentConfig | undefined;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Archetype config is empty or malformed: ${configPath}`);
  }

  const skills = (raw.skills?.shared ?? [])
    .map((s) => (typeof s === 'string' ? s : s?.skill))
    .filter((s): s is string => Boolean(s));

  const mcpServers = (raw.connectors?.mcp_servers ?? [])
    .map((s) => (typeof s === 'string' ? s : s?.server))
    .filter((s): s is string => Boolean(s));

  return {
    archetype: raw.identity?.archetype ?? archetype,
    character: raw.identity?.character ?? '',
    theme: raw.identity?.theme ?? '',
    soulFiles: raw.prompt_assembly?.soul_files ?? DEFAULT_SOUL_FILES,
    assemblyOrder: raw.prompt_assembly?.assembly_order ?? DEFAULT_ASSEMBLY_ORDER,
    modelPrimary: raw.model?.primary?.[0],
    skills,
    mcpServers,
    autonomy: raw.guardrails?.autonomy_level,
  };
}
