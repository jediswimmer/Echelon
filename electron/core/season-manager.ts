import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { DATA_DIR } from '../constants';
import { broadcastToAllWindows } from '../utils/broadcast';
import { saveRosterManifest } from './roster-manager';
import { resolveCharacterDir, getSoulFiles, assembleSoulPromptFile } from './character-loader';
import { loadAgentConfig } from './archetype-loader';
import { mapCatalogModelToProviderModel } from './model-map';
import { createAgent } from './agent-manager';
import { assignConvener, setConvenerAgentId } from './convener-manager';
import { getProvider } from '../providers';
import { writeProgrammaticInput } from './pty-manager';
import { buildFullPath } from '../utils/path-builder';
import { composeRosterFromPrd } from './composer';
import { trustClaudeProjects } from './claude-trust';
import { bootstrapRepoContext } from './repo-context';
import type { Season, SeasonStatus, SeasonSourceControl, SeasonIntake } from '../types/echelon';
import type { AgentStatus, AgentPermissionMode, AppSettings } from '../types';
import type { RosterManifestData, RosterCharacterEntry } from './roster-manager';

const SEASONS_DIR = path.join(DATA_DIR, 'seasons');

/**
 * Dependencies injected into {@link spawnSeason} and {@link launchSeasonAgents}
 * so this core module stays free of a circular dependency on `main.ts`. The
 * caller (season-handlers) supplies these from the app's live state.
 */
export interface SeasonRuntimeDeps {
  getMainWindow: () => BrowserWindow | null;
  getAppSettings: () => AppSettings;
  /** Forwards an agent status change to the notification system. */
  handleStatusChangeNotification: (agent: AgentStatus, newStatus: string) => void;
  /** Initializes (or re-initializes) a PTY for a restored/new agent. */
  initAgentPty: (agent: AgentStatus) => Promise<string>;
  saveAgents: () => void;
}

export const seasons: Map<string, Season> = new Map();

export function getSeasonsDir(): string {
  return SEASONS_DIR;
}

export function loadSeasons(): void {
  seasons.clear();
  if (!fs.existsSync(SEASONS_DIR)) return;

  const entries = fs.readdirSync(SEASONS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const seasonJsonPath = path.join(SEASONS_DIR, entry.name, 'season.json');
    if (!fs.existsSync(seasonJsonPath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(seasonJsonPath, 'utf-8'));
      seasons.set(data.id, data as Season);
    } catch (err) {
      console.error(`Failed to load season ${entry.name}:`, err);
    }
  }

  console.log(`Loaded ${seasons.size} season(s)`);
}

export function saveSeason(id: string): void {
  const season = seasons.get(id);
  if (!season) return;

  const seasonDir = path.join(SEASONS_DIR, id);
  if (!fs.existsSync(seasonDir)) {
    fs.mkdirSync(seasonDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(seasonDir, 'season.json'),
    JSON.stringify(season, null, 2),
    'utf-8'
  );
}

/** Map of seasonId → ordered cast agents (used by launchSeasonAgents). */
interface CastMember {
  agent: AgentStatus;
  slug: string;
  isConvener: boolean;
}
const seasonCast: Map<string, CastMember[]> = new Map();

/** Map of seasonId → the PRD/brief handed to the convener at launch. */
const seasonPrd: Map<string, string> = new Map();

/**
 * Map of seasonId → brownfield context summary, produced by the repo-context
 * bootstrap at spawn time and appended to the convener's launch prompt so the
 * team knows whether existing context was found (and where) or whether an
 * onboarding code review is in progress.
 */
const seasonContextSummary: Map<string, string> = new Map();

/**
 * Spawn a season AND cast a live team from the roster.
 *
 * For each roster entry this:
 *   1. loads the archetype config (recommended model, skills, autonomy),
 *   2. resolves the character's soul-package directory,
 *   3. copies the soul files into the season dir (season owns a mutable copy),
 *   4. assembles them into a single system-prompt file,
 *   5. creates a worktree-isolated agent via the shared `createAgent`,
 *   6. registers the agent on the season,
 * then assigns the convener to the real cast agentId.
 *
 * Agents are created (PTY-backed, idle) but NOT yet launched — call
 * {@link launchSeasonAgents} to start them working.
 */
export async function spawnSeason(
  config: {
    id: string;
    name: string;
    theme: string;
    /**
     * Explicit roster. When omitted/empty AND a `prd` is supplied, the roster
     * is auto-composed from the PRD via {@link composeRosterFromPrd}. The UI's
     * default path leaves this empty and relies on auto-compose; the "Advanced:
     * edit roster" override supplies it explicitly.
     */
    rosterEntries?: RosterCharacterEntry[];
    prd?: string;
    /**
     * Per-agent permission posture for the whole season, chosen by the user at
     * kickoff. Applied to every cast agent's `permissionMode`, overriding the
     * archetype-derived default. `undefined` falls back to the prior behavior
     * (autonomy-derived).
     */
    permissionMode?: AgentPermissionMode;
    /**
     * Optional source-control linkage. When `type` is `github`/`azure-devops`
     * and a `repoUrl` is given, the named repo is CLONED as the season
     * workspace (instead of an empty git init). `local` (or undefined) keeps
     * the empty-init behavior.
     */
    sourceControl?: SeasonSourceControl;
    /** Optional linked Jira project key — captured + stored + displayed only. */
    jiraProjectKey?: string;
    /**
     * Intake mode: `greenfield` (new project, the default) vs `brownfield`
     * (existing, in-flight project found in a linked repo). Brownfield seasons
     * (and any season with a real linked repo) bootstrap their starting context
     * from the repo via {@link bootstrapRepoContext} before the team gets to work.
     */
    intake?: SeasonIntake;
  },
  deps: SeasonRuntimeDeps
): Promise<Season> {
  const seasonDir = path.join(SEASONS_DIR, config.id);
  const workspacePath = path.join(seasonDir, 'workspace');
  const rosterManifestPath = path.join(seasonDir, 'roster.manifest.yaml');
  const charactersDir = path.join(seasonDir, 'characters');

  fs.mkdirSync(charactersDir, { recursive: true });

  // Normalize the source-control linkage. A non-local type with a repoUrl means
  // "clone this repo as the workspace"; anything else stays local (empty init).
  const sourceControl: SeasonSourceControl | undefined = (() => {
    const sc = config.sourceControl;
    if (!sc || sc.type === 'local') return undefined;
    const repoUrl = sc.repoUrl?.trim();
    if (!repoUrl) return undefined; // type set but no repo ⇒ treat as local
    return { type: sc.type, repoUrl };
  })();
  const jiraProjectKey = config.jiraProjectKey?.trim() || undefined;

  // Intake mode. `brownfield` is explicit; otherwise default to `greenfield`.
  // A brownfield intake OR any real linked repo triggers the context bootstrap.
  const intake: SeasonIntake = config.intake === 'brownfield' ? 'brownfield' : 'greenfield';
  const shouldBootstrapContext = intake === 'brownfield' || Boolean(sourceControl);

  if (sourceControl) {
    // Clone the linked repo AS the season workspace. The directory must NOT
    // pre-exist for `git clone <dir>` / `gh repo clone <dir>`. On failure we
    // surface a clear error — the user asked for the repo, so we never silently
    // fall back to an empty workspace.
    await cloneWorkspaceFromRepo(sourceControl, workspacePath, deps.getAppSettings());
  } else {
    // Local-only: the season workspace must be a git repo for worktree-isolated
    // agents. Initialize an empty repo with a seed commit (prior behavior).
    fs.mkdirSync(workspacePath, { recursive: true });
    ensureGitRepo(workspacePath);
  }

  // Pre-trust the Echelon-owned workspace so Claude's per-folder trust dialog
  // never appears for season agents (worktree paths are pre-trusted below, once
  // each agent's worktree exists). Targeted: Echelon dirs only.
  trustClaudeProjects([workspacePath]);

  // ── Resolve the roster: explicit entries, else auto-compose from the PRD ──
  let rosterEntries: RosterCharacterEntry[] = config.rosterEntries ?? [];
  let composedTier: RosterManifestData['tier'] = 'medium';
  if (rosterEntries.length === 0 && config.prd && config.prd.trim()) {
    const composed = composeRosterFromPrd(config.prd, config.theme);
    rosterEntries = composed.entries;
    composedTier = composed.tier;
    console.log(
      `Season ${config.id}: auto-composed ${rosterEntries.length} roster entries from PRD (tier=${composed.tier}` +
        (composed.dropped.length ? `, dropped=${composed.dropped.join(',')}` : '') +
        ')'
    );
  }

  if (rosterEntries.length === 0) {
    throw new Error(
      'Season has no roster: provide a PRD to auto-compose, or supply rosterEntries explicitly.'
    );
  }

  const season: Season = {
    id: config.id,
    name: config.name,
    theme: config.theme,
    status: 'spawning',
    rosterManifestPath,
    workspacePath,
    characterIds: [],
    createdAt: new Date().toISOString(),
    sourceControl,
    jiraProjectKey,
    intake,
    // Greenfield seasons never run the bootstrap; brownfield/linked-repo seasons
    // start as `searching` once the bootstrap kicks off (set below).
    contextStatus: shouldBootstrapContext ? 'searching' : 'greenfield',
  };

  // Write roster manifest
  const manifestData: RosterManifestData = {
    season_id: config.id,
    season_slug: config.id,
    theme: config.theme,
    tier: composedTier,
    roster: rosterEntries,
    source_control: sourceControl
      ? { type: sourceControl.type, repo_url: sourceControl.repoUrl }
      : undefined,
    jira_project_key: jiraProjectKey,
  };
  saveRosterManifest(rosterManifestPath, manifestData);

  seasons.set(config.id, season);
  saveSeason(config.id);
  broadcastToAllWindows('season:updated', season);

  // ── Cast the team ────────────────────────────────────────────────
  const cast: CastMember[] = [];

  for (const entry of rosterEntries) {
    try {
      const cfg = loadAgentConfig(entry.archetype);
      const slug = entry.character || cfg.character;
      if (!slug) {
        console.warn(`Season ${config.id}: roster entry ${entry.archetype} has no character — skipping`);
        continue;
      }

      const sourceCharacterDir = resolveCharacterDir(config.theme, slug);

      // Copy the soul files into a season-owned mutable copy.
      const seasonCharacterDir = path.join(charactersDir, slug);
      fs.mkdirSync(seasonCharacterDir, { recursive: true });
      for (const soulFile of getSoulFiles(sourceCharacterDir)) {
        fs.copyFileSync(soulFile, path.join(seasonCharacterDir, path.basename(soulFile)));
      }

      // Assemble the system-prompt file inside the season copy.
      const systemPromptPath = path.join(seasonCharacterDir, 'system-prompt.md');
      assembleSoulPromptFile(seasonCharacterDir, cfg.assemblyOrder, systemPromptPath);

      // Per-agent permission posture: the user-selected season posture wins;
      // otherwise fall back to the archetype-derived default (prior behavior).
      const permissionMode: AgentPermissionMode =
        config.permissionMode ?? (cfg.autonomy === 'autonomous' ? 'auto' : 'normal');

      // Cast the agent on its recommended model, worktree-isolated.
      const agent = await createAgent(
        {
          name: slug,
          projectPath: workspacePath,
          worktree: { enabled: true, branchName: `season/${config.id}/${slug}` },
          model: mapCatalogModelToProviderModel(cfg.modelPrimary),
          skills: cfg.skills,
          permissionMode,
          seasonId: config.id,
          archetypeId: entry.archetype,
          canonName: slug,
          theme: config.theme,
          soulPackagePath: seasonCharacterDir,
        },
        deps.getAppSettings,
        deps.handleStatusChangeNotification
      );

      // Pre-trust this agent's actual working dir (the worktree) so Claude's
      // per-folder trust dialog never blocks the launch — regardless of the
      // chosen permission posture. Echelon-owned worktree path only.
      trustClaudeProjects([agent.worktreePath, agent.projectPath]);

      addCharacterToSeason(config.id, agent.id);
      cast.push({ agent, slug, isConvener: false });
    } catch (err) {
      console.error(`Season ${config.id}: failed to cast ${entry.archetype} (${entry.character}):`, err);
    }
  }

  // ── Assign the convener to a REAL cast agentId ───────────────────
  const convenerSlug = assignConvener(config.id); // resolves the slug from theme/roster
  if (convenerSlug) {
    const convenerMember = cast.find((c) => c.slug === convenerSlug);
    if (convenerMember) {
      convenerMember.isConvener = true;
      // Re-point the convener map at the real agentId (not the bare slug).
      setConvenerAgentId(config.id, convenerMember.agent.id);
    }
  }

  seasonCast.set(config.id, cast);
  if (config.prd) seasonPrd.set(config.id, config.prd);

  // ── Brownfield: bootstrap the team's context from the (cloned) repo ──
  // Runs AFTER the repo is cloned + the cast is set up, but BEFORE the team is
  // launched (the handler calls launchSeasonAgents next). It searches existing
  // context and, if none is found, kicks off an onboarding code review. The
  // returned summary is folded into the convener's launch prompt. Never throws —
  // a failed bootstrap must not block the team going live.
  if (shouldBootstrapContext) {
    try {
      const bootstrap = await bootstrapRepoContext(season, deps);
      seasonContextSummary.set(config.id, bootstrap.summary);
    } catch (err) {
      console.error(`Season ${config.id}: repo context bootstrap failed:`, err);
      updateSeasonContextStatus(config.id, 'failed');
    }
  }

  return season;
}

/**
 * Launch the cast agents for a season: init each PTY, build the Claude command
 * (souls injected via the assembled system-prompt file, on the recommended
 * model), and write it to the PTY. The PRD is handed to the convener; the rest
 * receive a wake/standby brief. Flips the season to `active` once an agent
 * reports `running`.
 */
export async function launchSeasonAgents(
  id: string,
  prd: string | undefined,
  deps: SeasonRuntimeDeps
): Promise<void> {
  const season = seasons.get(id);
  if (!season) {
    console.warn(`launchSeasonAgents: season ${id} not found`);
    return;
  }

  const cast = seasonCast.get(id) ?? [];
  if (cast.length === 0) {
    console.warn(`launchSeasonAgents: season ${id} has no cast to launch`);
    return;
  }

  const effectivePrd = prd ?? seasonPrd.get(id) ?? '';
  const cliProvider = getProvider('claude');
  const binaryPath = cliProvider.resolveBinaryPath(deps.getAppSettings());

  // Resolve an MCP config path the same way agent:start does (flag strategy).
  let mcpConfigPath: string | undefined;
  if (cliProvider.getMcpConfigStrategy() === 'flag') {
    const possibleMcpPath = path.join(require('os').homedir(), '.claude', 'mcp.json');
    if (fs.existsSync(possibleMcpPath)) mcpConfigPath = possibleMcpPath;
  }

  let flippedActive = false;

  for (const member of cast) {
    const { agent } = member;
    try {
      // Initialize the PTY (createAgent already made one, but mirror agent:start
      // robustness: re-init if missing).
      let ptyJustCreated = false;
      if (!agent.ptyId) {
        agent.ptyId = await deps.initAgentPty(agent);
        ptyJustCreated = true;
      }

      const { ptyProcesses } = require('./pty-manager') as typeof import('./pty-manager');
      const ptyProcess = ptyProcesses.get(agent.ptyId!);
      if (!ptyProcess) {
        console.warn(`launchSeasonAgents: no PTY for agent ${agent.id} (${member.slug})`);
        continue;
      }

      // Souls were assembled into the season character dir.
      const systemPromptFile = agent.soulPackagePath
        ? path.join(agent.soulPackagePath, 'system-prompt.md')
        : undefined;

      // Brownfield context (if any) is appended to the convener's brief so it
      // grounds the team in the existing repo state — or tells them a code review
      // is in progress and where the resulting context.md will land.
      const contextSummary = seasonContextSummary.get(id);
      const contextBlock = member.isConvener && contextSummary
        ? `\n\n---\n\nEXISTING-PROJECT CONTEXT (brownfield ingestion):\n${contextSummary}`
        : '';

      // Convener gets the PRD; everyone else gets a standby/wake brief.
      const prompt = member.isConvener
        ? (effectivePrd
            ? `You are the convener for season "${season.name}". Here is the product brief / PRD for this season. Read it, break it into tasks, and coordinate the team to deliver it.\n\n---\n\n${effectivePrd}${contextBlock}`
            : `You are the convener for season "${season.name}". Await the product brief, then coordinate the team.${contextBlock}`)
        : `You are a cast member of season "${season.name}". Stand by for delegated tasks from the convener and begin work when assigned.`;

      const command = cliProvider.buildInteractiveCommand({
        binaryPath,
        prompt,
        model: agent.model,
        verbose: deps.getAppSettings().verboseModeEnabled,
        permissionMode: agent.permissionMode ?? 'normal',
        mcpConfigPath,
        systemPromptFile: systemPromptFile && fs.existsSync(systemPromptFile) ? systemPromptFile : undefined,
        skills: agent.skills,
      });

      const workingPath = (agent.worktreePath || agent.projectPath).replace(/'/g, "'\\''");
      const fullCommand = `cd '${workingPath}' && ${command}`;

      agent.status = 'running';
      agent.currentTask = prompt.slice(0, 100);
      agent.lastActivity = new Date().toISOString();
      broadcastToAllWindows('agent:status', {
        type: 'status',
        agentId: agent.id,
        status: 'running',
        timestamp: agent.lastActivity,
      });

      // Freshly-spawned PTYs need a moment for bash to come up before input.
      if (ptyJustCreated) {
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            writeProgrammaticInput(ptyProcess, fullCommand);
            resolve();
          }, 500);
        });
      } else {
        writeProgrammaticInput(ptyProcess, fullCommand);
      }

      // Flip the season to active once the first agent is running.
      if (!flippedActive) {
        updateSeasonStatus(id, 'active');
        flippedActive = true;
      }
    } catch (err) {
      console.error(`launchSeasonAgents: failed to launch agent ${agent.id} (${member.slug}):`, err);
    }
  }

  deps.saveAgents();
}

/**
 * Clone a linked repo AS the season workspace.
 *
 *   • GitHub: prefer `gh repo clone <repo> <workspacePath>` (the app already
 *     depends on `gh` and inherits its auth); fall back to `git clone` if `gh`
 *     is unavailable or fails.
 *   • Azure DevOps: `git clone <repoUrl> <workspacePath>` (relies on the user's
 *     existing git credential helper).
 *
 * Security: every invocation uses execFile with an args array (NO shell), so the
 * repo URL is never interpolated into a shell string. PATH is resolved via
 * {@link buildFullPath} (with any user-configured CLI dirs) so `gh`/`git` are
 * found. On failure this THROWS — the caller must surface the error rather than
 * silently fall back to an empty workspace.
 */
async function cloneWorkspaceFromRepo(
  sourceControl: SeasonSourceControl,
  workspacePath: string,
  appSettings: AppSettings,
): Promise<void> {
  const { execFile } = require('child_process') as typeof import('child_process');
  const { promisify } = require('util') as typeof import('util');
  const execFileAsync = promisify(execFile);

  const repoUrl = sourceControl.repoUrl!.trim();

  // `git clone <dir>` / `gh repo clone <dir>` require the target NOT to exist
  // (or to be empty). spawnSeason no longer pre-creates it for clone mode, but
  // guard anyway: if it exists and is non-empty, that's a hard error.
  if (fs.existsSync(workspacePath)) {
    const entries = fs.readdirSync(workspacePath);
    if (entries.length > 0) {
      throw new Error(`Workspace path already exists and is not empty: ${workspacePath}`);
    }
    fs.rmdirSync(workspacePath);
  }
  // Ensure the parent exists so the clone target can be created.
  fs.mkdirSync(path.dirname(workspacePath), { recursive: true });

  // Resolve PATH including user-configured CLI dirs (gh/node) so the child can
  // find the binaries even when the app launched without a login shell PATH.
  const cliExtraPaths: string[] = [];
  const cliPaths = appSettings.cliPaths;
  if (cliPaths) {
    for (const key of ['gh', 'node'] as const) {
      const p = cliPaths[key];
      if (p) cliExtraPaths.push(path.dirname(p));
    }
    if (Array.isArray(cliPaths.additionalPaths)) {
      cliExtraPaths.push(...cliPaths.additionalPaths.filter(Boolean));
    }
  }
  const env = { ...process.env, PATH: buildFullPath(cliExtraPaths) };
  // Non-interactive: never let git/gh block the spawn on a credential prompt.
  const cloneEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  const opts = { env: cloneEnv, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 };

  const ghBinary = cliPaths?.gh || 'gh';

  if (sourceControl.type === 'github') {
    // Try `gh repo clone` first (inherits gh auth), then fall back to git.
    try {
      await execFileAsync(ghBinary, ['repo', 'clone', repoUrl, workspacePath], opts);
      console.log(`Season workspace cloned via gh: ${repoUrl} → ${workspacePath}`);
      return;
    } catch (ghErr) {
      console.warn(`gh repo clone failed (${String(ghErr)}); falling back to git clone`);
      try {
        await execFileAsync('git', ['clone', repoUrl, workspacePath], opts);
        console.log(`Season workspace cloned via git (gh fallback): ${repoUrl} → ${workspacePath}`);
        return;
      } catch (gitErr) {
        throw new Error(
          `Failed to clone GitHub repo "${repoUrl}" as the season workspace. ` +
            `gh: ${String(ghErr)}; git: ${String(gitErr)}`,
        );
      }
    }
  }

  // Azure DevOps (and any other non-github clone) → plain git clone.
  try {
    await execFileAsync('git', ['clone', repoUrl, workspacePath], opts);
    console.log(`Season workspace cloned via git: ${repoUrl} → ${workspacePath}`);
  } catch (gitErr) {
    throw new Error(
      `Failed to clone Azure DevOps repo "${repoUrl}" as the season workspace: ${String(gitErr)}`,
    );
  }
}

/**
 * Ensure a directory is a git repository so worktree-isolated agents can be
 * created against it. Initializes a repo with an empty initial commit if none
 * exists (git worktree add requires at least one commit).
 */
function ensureGitRepo(dir: string): void {
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const isRepo = (() => {
      try {
        execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    })();

    if (!isRepo) {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
    }

    // Worktrees require at least one commit (HEAD). Create one if absent.
    try {
      execSync('git rev-parse HEAD', { cwd: dir, stdio: 'pipe' });
    } catch {
      // Ensure a committer identity is set for this repo (CI/headless safety).
      try { execSync('git config user.email', { cwd: dir, stdio: 'pipe' }); }
      catch { execSync('git config user.email "team@echelon.local"', { cwd: dir, stdio: 'pipe' }); }
      try { execSync('git config user.name', { cwd: dir, stdio: 'pipe' }); }
      catch { execSync('git config user.name "Echelon"', { cwd: dir, stdio: 'pipe' }); }

      const readme = path.join(dir, 'README.md');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme, '# Season workspace\n', 'utf-8');
      }
      execSync('git add -A', { cwd: dir, stdio: 'pipe' });
      execSync('git commit -m "Initial season workspace"', { cwd: dir, stdio: 'pipe' });
    }
  } catch (err) {
    console.error(`ensureGitRepo failed for ${dir}:`, err);
  }
}

export function updateSeasonStatus(id: string, status: SeasonStatus): void {
  const season = seasons.get(id);
  if (!season) return;

  season.status = status;
  if (status === 'archived') {
    season.archivedAt = new Date().toISOString();
  }

  saveSeason(id);
  broadcastToAllWindows('season:updated', season);
}

/**
 * Update a season's brownfield context status (and optionally its context.md
 * path) and broadcast the change. Used by the repo-context bootstrap to surface
 * the searching → reviewing → ready lifecycle on the control board. No-op for
 * unknown seasons.
 */
export function updateSeasonContextStatus(
  id: string,
  contextStatus: Season['contextStatus'],
  contextPath?: string,
): void {
  const season = seasons.get(id);
  if (!season) return;

  season.contextStatus = contextStatus;
  if (contextPath) season.contextPath = contextPath;

  saveSeason(id);
  broadcastToAllWindows('season:updated', season);
}

export function archiveSeason(id: string): void {
  updateSeasonStatus(id, 'archived');
}

export function restoreSeason(id: string): void {
  updateSeasonStatus(id, 'restoring');
  // Reload season data
  const season = seasons.get(id);
  if (season) {
    season.status = 'active';
    season.archivedAt = undefined;
    saveSeason(id);
    broadcastToAllWindows('season:updated', season);
  }
}

export function addCharacterToSeason(seasonId: string, characterId: string): void {
  const season = seasons.get(seasonId);
  if (!season) return;

  if (!season.characterIds.includes(characterId)) {
    season.characterIds.push(characterId);
    saveSeason(seasonId);
    broadcastToAllWindows('season:updated', season);
  }
}

export function removeCharacterFromSeason(seasonId: string, characterId: string): void {
  const season = seasons.get(seasonId);
  if (!season) return;

  season.characterIds = season.characterIds.filter(id => id !== characterId);
  saveSeason(seasonId);
  broadcastToAllWindows('season:updated', season);
}

export function getSeason(id: string): Season | undefined {
  return seasons.get(id);
}

export function getAllSeasons(): Season[] {
  return Array.from(seasons.values());
}
