import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { BrowserWindow, Notification } from 'electron';
import {
  AgentStatus,
  AppSettings,
  WorktreeConfig,
  AgentCharacter,
  AgentProvider,
  AgentPermissionMode,
  AgentEffort,
} from '../types';
import { broadcastToAllWindows } from '../utils/broadcast';
import { AGENTS_FILE, DATA_DIR } from '../constants';
import { ensureDataDir, isSuperAgent } from '../utils';
import { ptyProcesses } from './pty-manager';
import { buildFullPath } from '../utils/path-builder';
import { getProvider } from '../providers';
import { extractStatusLine } from '../utils/ansi';
import { scheduleTick } from '../utils/agents-tick';

/**
 * Authoritative in-memory agent state. When deleting an entry, also call
 * `releaseAgentTracking(id)` to clear `previousAgentStatus` and any pending
 * status-change timeout — otherwise aux maps leak across removed agents.
 */
export const agents: Map<string, AgentStatus> = new Map();

export let agentsLoaded = false;
export let superAgentTelegramTask = false;
export let superAgentOutputBuffer: string[] = [];

export function setSuperAgentTelegramTask(value: boolean) {
  superAgentTelegramTask = value;
}

export function getSuperAgentOutputBuffer(): string[] {
  return superAgentOutputBuffer;
}

export function clearSuperAgentOutputBuffer() {
  superAgentOutputBuffer = [];
}

const previousAgentStatus: Map<string, string> = new Map();

const pendingStatusChanges: Map<string, {
  newStatus: string;
  scheduledAt: number;
  timeoutId: NodeJS.Timeout;
}> = new Map();

/**
 * Call this whenever an agent is removed from the `agents` Map. Clears the
 * auxiliary `previousAgentStatus` and `pendingStatusChanges` maps and clears
 * any pending status-change timeout so dead-agent entries don't accumulate.
 */
export function releaseAgentTracking(id: string) {
  previousAgentStatus.delete(id);
  const pending = pendingStatusChanges.get(id);
  if (pending) {
    clearTimeout(pending.timeoutId);
    pendingStatusChanges.delete(id);
  }
}

export function handleStatusChangeNotification(
  agent: AgentStatus,
  newStatus: string,
  appSettings: AppSettings,
  sendNotification: (title: string, body: string, agentId?: string, settings?: { notificationsEnabled: boolean }) => void,
  sendTelegramMessage?: (text: string) => void,
  sendSuperAgentResponseToTelegram?: (agent: AgentStatus) => void
) {
  const prevStatus = previousAgentStatus.get(agent.id);

  if (!prevStatus) {
    previousAgentStatus.set(agent.id, newStatus);
    return;
  }

  if (prevStatus === newStatus) {
    return;
  }

  if (newStatus === 'running') {
    const pending = pendingStatusChanges.get(agent.id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingStatusChanges.delete(agent.id);
    }
    previousAgentStatus.set(agent.id, newStatus);
    return;
  }

  const pending = pendingStatusChanges.get(agent.id);

  if (pending && pending.newStatus === newStatus) {
    return;
  }

  if (pending) {
    clearTimeout(pending.timeoutId);
  }

  const timeoutId = setTimeout(() => {
    pendingStatusChanges.delete(agent.id);

    const currentAgent = agents.get(agent.id);
    if (!currentAgent || currentAgent.status !== newStatus) {
      return;
    }

    previousAgentStatus.set(agent.id, newStatus);

    const agentName = currentAgent.name || `Agent ${currentAgent.id.slice(0, 6)}`;
    const isSuper = isSuperAgent(currentAgent);

    if (newStatus === 'waiting') {
      if (!isSuper && appSettings.notifyOnWaiting) {
        sendNotification(
          `${agentName} needs your attention`,
          'The agent is waiting for your input.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendSuperAgentResponseToTelegram) {
        sendSuperAgentResponseToTelegram(currentAgent);
        superAgentTelegramTask = false;
      }
    } else if (newStatus === 'completed' && appSettings.notifyOnComplete) {
      if (!isSuper) {
        sendNotification(
          `${agentName} completed`,
          currentAgent.currentTask ? `Finished: ${currentAgent.currentTask.slice(0, 50)}...` : 'Task completed successfully.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendSuperAgentResponseToTelegram) {
        sendSuperAgentResponseToTelegram(currentAgent);
        superAgentTelegramTask = false;
      }
    } else if (newStatus === 'error' && appSettings.notifyOnError) {
      if (!isSuper) {
        sendNotification(
          `${agentName} encountered an error`,
          currentAgent.error || 'An error occurred while running.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendTelegramMessage) {
        sendTelegramMessage(`🔴 Super Agent error: ${currentAgent.error || 'An error occurred.'}`);
        superAgentTelegramTask = false;
      }
    }
  }, 5000);

  pendingStatusChanges.set(agent.id, {
    newStatus,
    scheduledAt: Date.now(),
    timeoutId,
  });
}

export function saveAgents() {
  try {
    if (!agentsLoaded) {
      console.log('Skipping save - agents not loaded yet');
      return;
    }

    ensureDataDir();
    const agentsArray = Array.from(agents.values()).map(agent => ({
      ...agent,
      ptyId: undefined,
      pathMissing: undefined,
      output: agent.output.slice(-100),
      status: agent.status === 'running' ? 'idle' : agent.status,
    }));

    if (fs.existsSync(AGENTS_FILE)) {
      const existingContent = fs.readFileSync(AGENTS_FILE, 'utf-8');
      if (existingContent.trim().length > 2) {
        const backupFile = path.join(DATA_DIR, 'agents.backup.json');
        fs.writeFileSync(backupFile, existingContent);
      }
    }

    fs.writeFileSync(AGENTS_FILE, JSON.stringify(agentsArray, null, 2));
    console.log(`Saved ${agentsArray.length} agents to disk`);
  } catch (err) {
    console.error('Failed to save agents:', err);
  }
}

export function loadAgents() {
  try {
    if (!fs.existsSync(AGENTS_FILE)) {
      console.log('No agents file found, starting fresh');
      agentsLoaded = true;
      return;
    }

    const data = fs.readFileSync(AGENTS_FILE, 'utf-8');

    if (!data.trim() || data.trim() === '[]') {
      console.log('Agents file is empty, checking for backup...');
      const backupFile = path.join(DATA_DIR, 'agents.backup.json');
      if (fs.existsSync(backupFile)) {
        const backupData = fs.readFileSync(backupFile, 'utf-8');
        if (backupData.trim() && backupData.trim() !== '[]') {
          console.log('Restoring agents from backup...');
          fs.writeFileSync(AGENTS_FILE, backupData);
          loadAgents();
          return;
        }
      }
      agentsLoaded = true;
      return;
    }

    const agentsArray = JSON.parse(data) as AgentStatus[];

    for (const agent of agentsArray) {
      const workingPath = agent.worktreePath || agent.projectPath;
      if (!fs.existsSync(workingPath)) {
        console.warn(`Agent ${agent.id} has missing path: ${workingPath} - marking as pathMissing`);
        agent.pathMissing = true;
      } else {
        agent.pathMissing = false;
      }

      agent.status = 'idle';
      agent.ptyId = undefined;

      // Migrate legacy skipPermissions boolean → permissionMode
      if (!agent.permissionMode) {
        agent.permissionMode = agent.skipPermissions ? 'auto' : 'normal';
      }

      agents.set(agent.id, agent);
    }

    console.log(`Loaded ${agents.size} agents from disk`);
    agentsLoaded = true;
  } catch (err) {
    console.error('Failed to load agents:', err);
    agentsLoaded = true;
  }
}

export async function initAgentPty(
  agent: AgentStatus,
  mainWindow: BrowserWindow | null,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void,
  saveAgentsCallback: () => void
): Promise<string> {
  const shell = '/bin/bash';
  let cwd = agent.worktreePath || agent.projectPath;

  if (!fs.existsSync(cwd)) {
    console.warn(`Agent ${agent.id} cwd does not exist: ${cwd} — falling back to home directory`);
    cwd = os.homedir();
  }

  console.log(`Initializing PTY for restored agent ${agent.id} in ${cwd}`);

  // Build PATH that includes user-configured paths, nvm, and other common locations for claude
  const cliExtraPaths: string[] = [];
  let savedSettings: Record<string, unknown> = {};
  try {
    const settingsFile = path.join(os.homedir(), '.echelon', 'app-settings.json');
    if (fs.existsSync(settingsFile)) {
      savedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      const cliPaths = savedSettings.cliPaths as Record<string, unknown> | undefined;
      if (cliPaths) {
        for (const key of ['claude', 'codex', 'gemini', 'gws', 'gh', 'node']) {
          if (cliPaths[key]) {
            cliExtraPaths.push(path.dirname(cliPaths[key] as string));
          }
        }
        if (cliPaths.additionalPaths) {
          cliExtraPaths.push(...(cliPaths.additionalPaths as string[]).filter(Boolean));
        }
      }
    }
  } catch {
    // Ignore settings load errors
  }
  const fullPath = buildFullPath(cliExtraPaths);

  // For local provider, bake Tasmania env vars into the PTY process environment
  let tasmaniaEnv: Record<string, string> = {};
  if (agent.provider === 'local') {
    try {
      const { getTasmaniaStatus } = require('../services/tasmania-client') as typeof import('../services/tasmania-client');
      const tasmaniaStatus = await getTasmaniaStatus();
      if (tasmaniaStatus.status === 'running' && tasmaniaStatus.endpoint) {
        const localModel = agent.localModel || tasmaniaStatus.modelName || 'default';
        // Strip /v1 suffix — Claude Code SDK appends /v1/messages itself
        const baseUrl = tasmaniaStatus.endpoint!.replace(/\/v1\/?$/, '');
        tasmaniaEnv = {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_MODEL: localModel,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        };
      } else {
        console.warn(`Agent ${agent.id} is local provider but Tasmania is not running — PTY created without Tasmania env vars`);
      }
    } catch (err) {
      console.warn(`Failed to get Tasmania status for agent ${agent.id}:`, err);
    }
  }

  // Get provider-specific env vars
  const agentProvider = getProvider(agent.provider);
  const providerEnvVars = agentProvider.getPtyEnvVars(agent.id, agent.projectPath, agent.skills);

  const ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...process.env as { [key: string]: string },
      PATH: fullPath,
      ...providerEnvVars,
      // Load CLAUDE.md from --add-dir directories (e.g. ~/.echelon)
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      ...tasmaniaEnv,
    },
  });

  const ptyId = uuidv4();
  ptyProcesses.set(ptyId, ptyProcess);

  ptyProcess.onData((data) => {
    const agentData = agents.get(agent.id);
    if (agentData) {
      agentData.output.push(data);
      agentData.lastActivity = new Date().toISOString();
      agentData.statusLine = extractStatusLine(agentData.output);

      if (superAgentTelegramTask && isSuperAgent(agentData)) {
        superAgentOutputBuffer.push(data);
        if (superAgentOutputBuffer.length > 200) {
          superAgentOutputBuffer = superAgentOutputBuffer.slice(-100);
        }
      }
    }
    broadcastToAllWindows('agent:output', {
      type: 'output',
      agentId: agent.id,
      ptyId,
      data,
      timestamp: new Date().toISOString(),
    });
    scheduleTick();
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`Agent ${agent.id} PTY exited with code ${exitCode}`);
    const agentData = agents.get(agent.id);
    // Guard: only mutate if this PTY is still the active one (prevents race on restart/stop)
    if (agentData && agentData.ptyId === ptyId) {
      const newStatus = exitCode === 0 ? 'completed' : 'error';
      agentData.status = newStatus;
      agentData.lastActivity = new Date().toISOString();
      handleStatusChangeNotificationCallback(agentData, newStatus);
      saveAgentsCallback();
    }
    ptyProcesses.delete(ptyId);
    broadcastToAllWindows('agent:complete', {
      type: 'complete',
      agentId: agent.id,
      ptyId,
      exitCode,
      timestamp: new Date().toISOString(),
    });
    scheduleTick();
  });

  return ptyId;
}

/**
 * Configuration accepted by {@link createAgent}. This is the union of the
 * standalone `agent:create` IPC config and the optional Echelon season fields
 * so that season-spawned characters and UI-spawned agents share one casting
 * code path. The two injected dependencies (`getAppSettings`,
 * `handleStatusChangeNotification`) keep this module free of a circular
 * dependency on `main.ts`.
 */
export interface CreateAgentConfig {
  projectPath: string;
  skills: string[];
  worktree?: WorktreeConfig;
  character?: AgentCharacter;
  name?: string;
  secondaryProjectPath?: string;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort;
  provider?: AgentProvider;
  model?: string;
  localModel?: string;
  obsidianVaultPaths?: string[];
  // Echelon season fields (optional — standalone agents do not set these)
  seasonId?: string;
  archetypeId?: string;
  canonName?: string;
  theme?: string;
  soulPackagePath?: string;
}

/**
 * Create a new PTY-backed agent. Extracted verbatim from the original inline
 * `agent:create` IPC handler so that both standalone agents and season cast
 * members go through one code path (no PTY/worktree-logic duplication).
 *
 * @param config       The agent + optional season fields.
 * @param getAppSettings  Returns the live AppSettings (for CLI path resolution).
 * @param handleStatusChangeNotificationCallback  Forwards status changes to the
 *        notification system; matches the wrapper used by `initAgentPty`.
 */
export async function createAgent(
  config: CreateAgentConfig,
  getAppSettings: () => AppSettings,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void
): Promise<AgentStatus> {
  const id = uuidv4();
  const shell = '/bin/bash';

  // Validate effort against allowed values to prevent shell injection
  const VALID_EFFORTS: AgentEffort[] = ['low', 'medium', 'high'];
  if (config.effort && !VALID_EFFORTS.includes(config.effort)) {
    throw new Error(`Invalid effort level: ${config.effort}`);
  }

  // Validate model name: only allow safe characters (alphanumeric, dash, dot, slash, colon, underscore)
  if (config.model && !/^[a-zA-Z0-9._\-\/:@]+$/.test(config.model)) {
    throw new Error(`Invalid model name: ${config.model}`);
  }

  // Validate project path exists
  let cwd = config.projectPath;
  if (!fs.existsSync(cwd)) {
    console.warn(`Project path does not exist: ${cwd}, using home directory`);
    cwd = os.homedir();
  }

  let worktreePath: string | undefined;
  let branchName: string | undefined;

  // Create git worktree if enabled
  if (config.worktree?.enabled && config.worktree?.branchName) {
    branchName = config.worktree.branchName;
    if (!/^[a-zA-Z0-9._\-\/]+$/.test(branchName)) {
      throw new Error('Invalid branch name');
    }
    const worktreesDir = path.join(cwd, '.worktrees');
    worktreePath = path.join(worktreesDir, branchName);

    console.log(`Creating git worktree for agent ${id} at ${worktreePath} on branch ${branchName}`);

    try {
      // Create .worktrees directory if it doesn't exist
      if (!fs.existsSync(worktreesDir)) {
        fs.mkdirSync(worktreesDir, { recursive: true });
      }

      // Check if worktree already exists
      if (fs.existsSync(worktreePath)) {
        console.log(`Worktree already exists at ${worktreePath}, reusing it`);
      } else {
        // Create the worktree with a new branch
        const { execSync } = await import('child_process');

        // Check if branch already exists
        try {
          execSync(`git rev-parse --verify '${branchName}'`, { cwd, stdio: 'pipe' });
          // Branch exists, create worktree using existing branch
          execSync(`git worktree add '${worktreePath}' '${branchName}'`, { cwd, stdio: 'pipe' });
        } catch {
          // Branch doesn't exist, create worktree with new branch
          execSync(`git worktree add -b '${branchName}' '${worktreePath}'`, { cwd, stdio: 'pipe' });
        }
      }

      // Use the worktree path as the working directory
      cwd = worktreePath;
    } catch (err) {
      console.error(`Failed to create git worktree:`, err);
      // Continue without worktree if creation fails
      worktreePath = undefined;
      branchName = undefined;
    }
  }

  console.log(`Creating PTY for agent ${id} with shell ${shell} in ${cwd}`);

  // Build PATH that includes user-configured paths, nvm, and other common locations for claude
  const currentSettings = getAppSettings();
  const cliExtraPaths: string[] = [];
  if (currentSettings.cliPaths) {
    for (const key of ['claude', 'codex', 'gemini', 'opencode', 'pi', 'gws', 'gh', 'node'] as const) {
      const val = (currentSettings.cliPaths as unknown as Record<string, string>)[key];
      if (val) cliExtraPaths.push(path.dirname(val));
    }
    if (currentSettings.cliPaths.additionalPaths) {
      cliExtraPaths.push(...currentSettings.cliPaths.additionalPaths.filter(Boolean));
    }
  }
  const fullPath = buildFullPath(cliExtraPaths);

  // Create PTY for this agent
  // Strip nested-session env vars to prevent errors
  const cleanEnv = { ...process.env as { [key: string]: string } };
  // Each provider may have env vars to delete; always delete CLAUDECODE for Claude
  delete cleanEnv['CLAUDECODE'];

  // Always include world-builder skill so agents can generate game zones
  const allSkills = [...new Set([...config.skills, 'world-builder'])];

  // Get provider-specific env vars
  const agentProvider = getProvider(config.provider);
  const providerEnvVars = agentProvider.getPtyEnvVars(id, config.projectPath, allSkills);

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: {
        ...cleanEnv,
        PATH: fullPath,
        ...providerEnvVars,
      },
    });
    console.log(`PTY created successfully for agent ${id}, PID: ${ptyProcess.pid}`);
  } catch (err) {
    console.error(`Failed to create PTY for agent ${id}:`, err);
    throw err;
  }

  const ptyId = uuidv4();
  ptyProcesses.set(ptyId, ptyProcess);

  // Validate secondary project path if provided
  let secondaryProjectPath: string | undefined;
  if (config.secondaryProjectPath) {
    if (fs.existsSync(config.secondaryProjectPath)) {
      secondaryProjectPath = config.secondaryProjectPath;
      console.log(`Secondary project path validated: ${secondaryProjectPath}`);
    } else {
      console.warn(`Secondary project path does not exist: ${config.secondaryProjectPath}`);
    }
  }

  const status: AgentStatus = {
    id,
    status: 'idle',
    projectPath: config.projectPath,
    secondaryProjectPath,
    worktreePath,
    branchName,
    skills: config.skills,
    output: [],
    lastActivity: new Date().toISOString(),
    ptyId,
    character: config.character || 'robot',
    name: config.name || `Agent ${id.slice(0, 4)}`,
    permissionMode: config.permissionMode || 'normal',
    effort: config.effort,
    provider: config.provider || 'claude',
    model: config.model,
    localModel: config.localModel,
    obsidianVaultPaths: config.obsidianVaultPaths || [],
    // Echelon season fields
    seasonId: config.seasonId,
    archetypeId: config.archetypeId,
    canonName: config.canonName,
    theme: config.theme,
    soulPackagePath: config.soulPackagePath,
  };
  agents.set(id, status);

  // Save agents to disk
  saveAgents();

  // Forward PTY output to renderer
  // Guard: skip if this PTY was replaced (e.g. local provider recreates PTY in agent:start)
  ptyProcess.onData((data) => {
    const agent = agents.get(id);
    if (!agent || agent.ptyId !== ptyId) return;

    agent.output.push(data);
    agent.lastActivity = new Date().toISOString();
    agent.statusLine = extractStatusLine(agent.output);

    // Capture Super Agent output for Telegram
    if (superAgentTelegramTask && isSuperAgent(agent)) {
      superAgentOutputBuffer.push(data);
      if (superAgentOutputBuffer.length > 200) {
        superAgentOutputBuffer = superAgentOutputBuffer.slice(-100);
      }
    }

    broadcastToAllWindows('agent:output', {
      type: 'output',
      agentId: id,
      ptyId,
      data,
      timestamp: new Date().toISOString(),
    });
    scheduleTick();
  });

  ptyProcess.onExit(({ exitCode }) => {
    const agent = agents.get(id);
    // Skip status update if this PTY was replaced by a newer one
    if (agent && agent.ptyId === ptyId) {
      console.log(`Agent ${id} PTY exited with code ${exitCode}`);
      const newStatus = exitCode === 0 ? 'completed' : 'error';
      agent.status = newStatus;
      agent.lastActivity = new Date().toISOString();
      handleStatusChangeNotificationCallback(agent, newStatus);
      broadcastToAllWindows('agent:complete', {
        type: 'complete',
        agentId: id,
        ptyId,
        exitCode,
        timestamp: new Date().toISOString(),
      });
    }
    ptyProcesses.delete(ptyId);
    scheduleTick();
  });

  return status;
}
