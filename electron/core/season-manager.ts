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
import { validateLocalClone } from './git-validate';
import { v4 as uuidv4 } from 'uuid';
import type { Season, SeasonStatus, SeasonSourceControl, SeasonIntake, SeasonMode, HumanSeat, SeasonCeremony, CeremonyKind, CeremonyCadence } from '../types/echelon';
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
     * workspace (instead of an empty git init). When `type` is `local-clone`
     * and a `localPath` is given, that EXISTING local clone is validated and
     * used in-place as the season workspace (no re-clone). `local` (or
     * undefined) keeps the empty-init behavior.
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
  const rosterManifestPath = path.join(seasonDir, 'roster.manifest.yaml');
  const charactersDir = path.join(seasonDir, 'characters');

  fs.mkdirSync(charactersDir, { recursive: true });

  // Normalize the source-control linkage:
  //   • `local`/undefined          → no linkage (empty git init, prior behavior)
  //   • `github`/`azure-devops`+url → clone the named repo as the workspace
  //   • `local-clone`+localPath     → adopt an existing local clone in-place
  const sourceControl: SeasonSourceControl | undefined = (() => {
    const sc = config.sourceControl;
    if (!sc || sc.type === 'local') return undefined;
    if (sc.type === 'local-clone') {
      const localPath = sc.localPath?.trim();
      if (!localPath) return undefined; // type set but no path ⇒ treat as local
      return { type: 'local-clone', localPath };
    }
    const repoUrl = sc.repoUrl?.trim();
    if (!repoUrl) return undefined; // type set but no repo ⇒ treat as local
    return { type: sc.type, repoUrl };
  })();
  const jiraProjectKey = config.jiraProjectKey?.trim() || undefined;

  // Intake mode. `brownfield` is explicit; otherwise default to `greenfield`.
  // A brownfield intake OR any real linked repo triggers the context bootstrap.
  const intake: SeasonIntake = config.intake === 'brownfield' ? 'brownfield' : 'greenfield';
  const shouldBootstrapContext = intake === 'brownfield' || Boolean(sourceControl);

  // The workspace path: for `local-clone` it is the validated existing clone
  // (used in-place, never re-cloned); otherwise it is the Echelon-owned
  // season-dir workspace that we clone into or empty-init. `let` because the
  // local-clone branch reassigns it to the resolved clone path.
  let workspacePath = path.join(seasonDir, 'workspace');

  if (sourceControl?.type === 'local-clone') {
    // Adopt an EXISTING local clone as the workspace. Validate its git
    // connection first — on failure we abort the spawn with the surfaced error
    // (the user asked for this clone; we never silently fall back).
    const validation = await validateLocalClone(sourceControl.localPath!, deps.getAppSettings());
    if (!validation.ok) {
      throw new Error(`Local clone validation failed: ${validation.message}`);
    }
    // Use the realpath-resolved absolute clone path AS the workspace. We do NOT
    // create or empty-init anything here — the user's working copy is untouched;
    // cast agents only ever `git worktree add` branches off it (below).
    workspacePath = validation.resolvedPath;
    sourceControl.localPath = validation.resolvedPath; // persist the resolved path
  } else if (sourceControl) {
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
      ? { type: sourceControl.type, repo_url: sourceControl.repoUrl, local_path: sourceControl.localPath }
      : undefined,
    jira_project_key: jiraProjectKey,
  };
  saveRosterManifest(rosterManifestPath, manifestData);

  seasons.set(config.id, season);
  saveSeason(config.id);
  broadcastToAllWindows('season:updated', season);

  // ── Cast the team ────────────────────────────────────────────────
  // Collaborative seasons (#22a) may already have human-owned seats: skip casting
  // an agent for any archetype a real person owns. A season is normally populated
  // AFTER spawn, so this mainly matters for re-spawn / expansion — but the guard
  // is wired here so a human-owned seat is never cast.
  const humanOwnedArchetypes = new Set(
    (season.humanTeam?.seats ?? []).map((s) => s.archetypeId),
  );
  const cast: CastMember[] = [];

  for (const entry of rosterEntries) {
    if (humanOwnedArchetypes.has(entry.archetype)) {
      console.log(
        `Season ${config.id}: skipping cast for archetype "${entry.archetype}" — owned by a human seat.`,
      );
      continue;
    }
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
    } else {
      // The convener slug wasn't cast — e.g. its archetype is a human-owned seat
      // (#22a). The primary-contact/convener role should stay agent-run; warn so
      // this isn't a silent no-convener season.
      console.warn(
        `Season ${config.id}: convener "${convenerSlug}" was not cast (likely a human-owned seat); coordination will have no convener agent.`,
      );
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

  // ── Greenfield grooming (17c) ──────────────────────────────────────────────
  // After the team is launched, a greenfield season with a PRD has the PM groom
  // a starting Epic/Story/Task backlog. Fire-and-forget so it never blocks the
  // spawn IPC response; grooming is internally guarded + resilient (never throws).
  // Brownfield grooming is triggered from repo-context once context is `ready`.
  if (season.intake !== 'brownfield' && effectivePrd && effectivePrd.trim()) {
    void (async () => {
      try {
        const { groomBacklogFromPRD } = await import('./grooming');
        await groomBacklogFromPRD(id, effectivePrd);
      } catch (err) {
        console.error(`launchSeasonAgents: greenfield grooming failed for season ${id}:`, err);
      }
    })();
  }
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

/**
 * Re-broadcast a season's current state to all windows (e.g. after grooming
 * mutates it in place). No-op for unknown seasons. Used by the 17c grooming flow
 * so it can persist + broadcast without importing the lower-level broadcast util.
 */
export function broadcastSeasonUpdated(id: string): void {
  const season = seasons.get(id);
  if (!season) return;
  broadcastToAllWindows('season:updated', season);
}

/**
 * Record the user's answer to a season's pending direction request (17c) and
 * start the team on the chosen path. Marks the request `answered`, persists +
 * broadcasts, and — when `chosenOptionId` maps to a seeded epic/story — moves its
 * children (or the chosen story's tasks) into the `planned` column so the existing
 * assign-automation kicks the team off. No-op for unknown seasons / no open request.
 */
export async function answerSeasonDirection(
  seasonId: string,
  payload: { answer?: string; chosenOptionId?: string },
): Promise<void> {
  const season = seasons.get(seasonId);
  if (!season || !season.directionRequest) return;

  const request = season.directionRequest;
  request.status = 'answered';
  request.answer = payload.answer;
  request.chosenOptionId = payload.chosenOptionId;
  request.answeredAt = new Date().toISOString();
  saveSeason(seasonId);
  broadcastToAllWindows('season:updated', season);

  // Resolve the chosen option (if any) to its seeded epic/story task.
  const chosen = payload.chosenOptionId
    ? request.options.find(o => o.id === payload.chosenOptionId)
    : undefined;

  // Lazy import to avoid a static cycle (kanban-handlers ← grooming ← season-manager).
  const { loadTasks, moveTaskToPlanned, saveTasks, emitTaskEvent } = await import('../handlers/kanban-handlers');
  const { appendConversationEntry } = await import('./conversation-log');

  let startedTitle: string | undefined;

  if (chosen) {
    startedTitle = chosen.title;

    // 17e: create the `echelon-team-factory/<slug>` branch for the chosen
    // epic/story and record it on that task. Eager (here, at direction time) so
    // the branch exists from the moment work starts. Fire-and-forget +
    // non-destructive (a bare `git branch`, never a checkout) + resilient
    // (createEpicBranch never throws). The branch is also created lazily in
    // tryCompleteEpic if this path didn't run (e.g. greenfield epics).
    void (async () => {
      try {
        const { createEpicBranch } = await import('../services/git-pr');
        const branch = await createEpicBranch(season.workspacePath, chosen.title);
        if (!branch) return;
        const tasks = loadTasks();
        const idx = tasks.findIndex(t => t.id === chosen.id);
        if (idx === -1) return;
        if (tasks[idx].branch === branch) return; // already recorded
        tasks[idx].branch = branch;
        tasks[idx].updatedAt = new Date().toISOString();
        saveTasks(tasks);
        emitTaskEvent('kanban:task-updated', tasks[idx]);
        appendConversationEntry(seasonId, {
          agentId: 'system',
          canonName: 'Release',
          kind: 'system',
          text: `Created branch "${branch}" for ${chosen.kind} "${chosen.title}".`,
        });
      } catch (err) {
        console.error(`answerSeasonDirection: failed to create epic branch for ${chosen.id}:`, err);
      }
    })();

    const tasks = loadTasks().filter(t => t.seasonId === seasonId);

    // Collect the leaf tasks to start:
    //   • epic  → its child stories' tasks (and any direct child tasks).
    //   • story → its direct child tasks.
    const leafTaskIds: string[] = [];
    if (chosen.kind === 'epic') {
      const storyIds = tasks.filter(t => t.parentId === chosen.id && t.issueType === 'story').map(t => t.id);
      for (const t of tasks) {
        if (t.issueType === 'task' && (t.parentId === chosen.id || (t.parentId && storyIds.includes(t.parentId)))) {
          leafTaskIds.push(t.id);
        }
      }
    } else {
      for (const t of tasks) {
        if (t.issueType === 'task' && t.parentId === chosen.id) leafTaskIds.push(t.id);
      }
    }

    // If the candidate had no seeded child tasks (brownfield candidates are bare
    // epics/stories), start the chosen epic/story itself so the team has a unit
    // of work to pick up.
    const toStart = leafTaskIds.length > 0 ? leafTaskIds : [chosen.id];
    for (const id of toStart) {
      try {
        await moveTaskToPlanned(id);
      } catch (err) {
        console.error(`answerSeasonDirection: failed to start task ${id}:`, err);
      }
    }
  }

  appendConversationEntry(seasonId, {
    agentId: 'system',
    canonName: 'PM',
    kind: 'system',
    text: startedTitle
      ? `User directed the team to start: ${startedTitle}`
      : `User answered the direction request${payload.answer ? `: ${payload.answer}` : ''}.`,
  });
}

export function getSeason(id: string): Season | undefined {
  return seasons.get(id);
}

export function getAllSeasons(): Season[] {
  return Array.from(seasons.values());
}

// ─── #22a — season mode + human hybrid dev team ───────────────────────────────

/**
 * Set a season's operating mode (#22a): `autonomous` (agents run the show, the
 * default) vs `collaborative` (a human hybrid dev team works alongside the
 * agents). Persists, broadcasts, and logs a system conversation entry. No-op for
 * an unknown season. The fully-autonomous scheduling (usage windows + cron) is
 * deferred to #18 — this only flips the stored mode + control-board affordances.
 */
export function setSeasonMode(seasonId: string, mode: SeasonMode): Season | undefined {
  const season = seasons.get(seasonId);
  if (!season) return undefined;

  season.mode = mode;
  saveSeason(seasonId);
  broadcastToAllWindows('season:updated', season);

  void (async () => {
    try {
      const { appendConversationEntry } = await import('./conversation-log');
      appendConversationEntry(seasonId, {
        agentId: 'system',
        canonName: 'Ops',
        kind: 'system',
        text:
          mode === 'collaborative'
            ? 'Season switched to Collaborative mode — populate the human team to hand roles to real people.'
            : 'Season switched to Autonomous mode — the agent team runs the show.',
      });
    } catch (err) {
      console.error(`setSeasonMode: failed to log for season ${seasonId}:`, err);
    }
  })();

  return season;
}

/**
 * Stop the running cast agent that owns a given archetype in a season, if any.
 *
 * Reuses the existing `agent:*` stop path WITHOUT editing agent-manager.ts: it
 * reads the shared `agents` map (an export of agent-manager) and kills the
 * agent's PTY via pty-manager's `killPty`, then mirrors the `agent:stop` IPC
 * handler's state transition (idle + `_manuallyStoppedAt`) and broadcast. Both
 * `agents` and `killPty` are CALLED here (existing exports) — neither module is
 * modified. Best-effort: returns the stopped agent's canonName/slug for logging,
 * or undefined when no matching running agent was found.
 */
function stopAgentForArchetype(seasonId: string, archetypeId: string): string | undefined {
  try {
    const { agents } = require('./agent-manager') as typeof import('./agent-manager');
    const { killPty } = require('./pty-manager') as typeof import('./pty-manager');

    const agent = Array.from(agents.values()).find(
      (a) => a.seasonId === seasonId && a.archetypeId === archetypeId,
    );
    if (!agent) return undefined;

    const label = agent.canonName || agent.name || agent.id;

    // Only stop a running/active PTY-backed agent; idle agents need no action.
    if (agent.ptyId) {
      killPty(agent.ptyId);
      agent.ptyId = undefined;
    }
    agent.status = 'idle';
    agent.currentTask = undefined;
    agent.lastActivity = new Date().toISOString();
    // Mirror the agent:stop handler: mark manually-stopped so status detection
    // doesn't immediately flip it back to running.
    (agent as AgentStatus & { _manuallyStoppedAt?: number })._manuallyStoppedAt = Date.now();

    broadcastToAllWindows('agent:status', {
      type: 'status',
      agentId: agent.id,
      status: 'idle',
      timestamp: agent.lastActivity,
    });

    return label;
  } catch (err) {
    console.error(`stopAgentForArchetype: failed for season ${seasonId} / ${archetypeId}:`, err);
    return undefined;
  }
}

/**
 * Populate (or clear) a season's human hybrid dev team (#22a).
 *
 * Persists `season.humanTeam = { seats }`; for every archetype now human-owned,
 * stops that role's cast agent if it is running (via {@link stopAgentForArchetype},
 * which reuses the existing agent-stop path without editing agent-manager). Logs
 * a system conversation entry summarizing human vs agent seats, saves, and
 * broadcasts. Passing an empty array clears the human team (PRs revert to
 * auto-approved). The stopped agents are not re-cast here — re-spawn/expansion
 * skips human-owned archetypes (see {@link spawnSeason}'s cast loop).
 */
export function setHumanTeam(seasonId: string, seats: HumanSeat[]): Season | undefined {
  const season = seasons.get(seasonId);
  if (!season) return undefined;

  const normalized = Array.isArray(seats) ? seats : [];
  season.humanTeam = { seats: normalized };
  // Switching a season to a populated human team implies collaborative mode.
  if (normalized.length > 0) season.mode = 'collaborative';

  // Stop the cast agent for each newly human-owned archetype.
  const stopped: string[] = [];
  for (const seat of normalized) {
    const label = stopAgentForArchetype(seasonId, seat.archetypeId);
    if (label) stopped.push(label);
  }

  // Persist the agent-state changes from the stops above synchronously
  // (saveAgents writes synchronously) BEFORE saving/broadcasting the season, so
  // on-disk agent state can't diverge from what the UI was just told.
  try {
    const { saveAgents } = require('./agent-manager') as typeof import('./agent-manager');
    saveAgents();
  } catch (err) {
    console.error(`setHumanTeam: failed to persist agent state for season ${seasonId}:`, err);
  }

  saveSeason(seasonId);
  broadcastToAllWindows('season:updated', season);

  void (async () => {
    try {
      const { appendConversationEntry } = await import('./conversation-log');
      const humanCount = normalized.length;
      const summary =
        humanCount === 0
          ? 'Human team cleared — all roles are agent-run.'
          : `Human team updated: ${humanCount} seat${humanCount === 1 ? '' : 's'} now human-run (${normalized
              .map((s) => s.displayName || s.handle)
              .join(', ')}).` + (stopped.length ? ` Stopped agent${stopped.length === 1 ? '' : 's'}: ${stopped.join(', ')}.` : '');
      appendConversationEntry(seasonId, {
        agentId: 'system',
        canonName: 'Ops',
        kind: 'system',
        text: summary,
      });
    } catch (err) {
      console.error(`setHumanTeam: failed to log for season ${seasonId}:`, err);
    }
  })();

  return season;
}

/** A GitHub collaborator candidate for the human-team picker. */
export interface GitHubCandidate {
  login: string;
  name?: string;
}

/** A Jira assignable-user candidate for the human-team picker. */
export interface JiraCandidate {
  accountId: string;
  displayName: string;
  email?: string;
}

/** Candidate humans to map onto roles, grouped by source (#22a). */
export interface HumanTeamCandidates {
  github: GitHubCandidate[];
  jira: JiraCandidate[];
  /** Per-source reason when a list is empty/unavailable (best-effort, no throw). */
  reasons: { github?: string; jira?: string };
}

/**
 * Parse `owner/repo` out of a season's GitHub source-control linkage. Handles a
 * bare `owner/repo`, `https://github.com/owner/repo(.git)`, and
 * `git@github.com:owner/repo(.git)`. Returns undefined when not derivable.
 */
function parseGitHubOwnerRepo(season: Season): string | undefined {
  const sc = season.sourceControl;
  if (!sc || sc.type !== 'github') return undefined;
  const repoUrl = sc.repoUrl?.trim();
  if (!repoUrl) return undefined;
  let candidate: string | undefined;
  const m = repoUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (m) candidate = m[1];
  else if (/^[^/\s]+\/[^/\s]+$/.test(repoUrl)) candidate = repoUrl.replace(/\.git$/i, '');
  // Guard: owner/repo goes into a `gh api repos/{ownerRepo}/...` path — only allow
  // plain segments (no path-traversal / query chars) or treat it as underivable.
  if (candidate && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) return candidate;
  return undefined;
}

/**
 * Best-effort fetch of the humans who could own a role in this season (#22a):
 *   • GitHub collaborators — when the season is GitHub-linked AND `gh` is
 *     available, via `gh api repos/{owner}/{repo}/collaborators`.
 *   • Jira assignable users — when the season has a linked project AND Jira is
 *     enabled, via `/rest/api/3/user/assignable/search?project={KEY}`.
 *
 * Every source degrades gracefully: an unavailable/unlinked/errored source comes
 * back as an empty array plus a human-readable reason. NEVER throws.
 */
export async function listHumanTeamCandidates(seasonId: string): Promise<HumanTeamCandidates> {
  const result: HumanTeamCandidates = { github: [], jira: [], reasons: {} };
  const season = seasons.get(seasonId);
  if (!season) {
    result.reasons.github = 'Season not found.';
    result.reasons.jira = 'Season not found.';
    return result;
  }

  // ── GitHub collaborators (best-effort) ──
  const ownerRepo = parseGitHubOwnerRepo(season);
  if (!ownerRepo) {
    result.reasons.github =
      season.sourceControl?.type === 'github'
        ? 'Could not derive owner/repo from the linked GitHub repo.'
        : 'This season is not linked to a GitHub repo.';
  } else {
    try {
      const { ghAvailable } = await import('../services/git-pr');
      if (!(await ghAvailable())) {
        result.reasons.github = 'The GitHub CLI (gh) is not available. Install + authenticate gh.';
      } else {
        result.github = await fetchGitHubCollaborators(ownerRepo);
        if (result.github.length === 0) {
          result.reasons.github = 'No collaborators returned for the linked repo.';
        }
      }
    } catch (err) {
      console.error(`listHumanTeamCandidates: GitHub fetch failed for ${seasonId}:`, err);
      result.reasons.github = 'Failed to fetch GitHub collaborators.';
    }
  }

  // ── Jira assignable users (best-effort) ──
  const projectKey = season.jiraProjectKey?.trim();
  if (!projectKey) {
    result.reasons.jira = 'This season is not linked to a Jira project.';
  } else {
    try {
      const { getJiraConfig } = await import('../services/jira-sync');
      const cfg = getJiraConfig();
      if (!cfg.enabled) {
        result.reasons.jira = cfg.reason || 'Jira is not enabled.';
      } else {
        result.jira = await fetchJiraAssignableUsers(cfg, projectKey);
        if (result.jira.length === 0) {
          result.reasons.jira = 'No assignable users returned for the linked project.';
        }
      }
    } catch (err) {
      console.error(`listHumanTeamCandidates: Jira fetch failed for ${seasonId}:`, err);
      result.reasons.jira = 'Failed to fetch Jira assignable users.';
    }
  }

  return result;
}

/**
 * Fetch a repo's collaborators via `gh api repos/{owner}/{repo}/collaborators`.
 * Reuses the same `execFile gh` (no shell) + resolved-PATH pattern as git-pr.ts.
 * Returns an empty array on any failure (caller supplies the reason).
 */
async function fetchGitHubCollaborators(ownerRepo: string): Promise<GitHubCandidate[]> {
  const { execFile } = require('child_process') as typeof import('child_process');
  const { promisify } = require('util') as typeof import('util');
  const execFileAsync = promisify(execFile);

  // Resolve the gh binary + PATH the same way git-pr.ts does (no shell interp).
  let ghBinary = 'gh';
  const extraPaths: string[] = [];
  try {
    if (fs.existsSync(require('../constants').APP_SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(require('../constants').APP_SETTINGS_FILE, 'utf-8'));
      const cliPaths = settings?.cliPaths;
      if (cliPaths) {
        if (cliPaths.gh) {
          ghBinary = cliPaths.gh;
          extraPaths.push(path.dirname(cliPaths.gh));
        }
        if (cliPaths.node) extraPaths.push(path.dirname(cliPaths.node));
        if (Array.isArray(cliPaths.additionalPaths)) extraPaths.push(...cliPaths.additionalPaths.filter(Boolean));
      }
    }
  } catch {
    // Fall through to defaults; buildFullPath still adds sensible dirs.
  }
  const env = { ...process.env, PATH: buildFullPath(extraPaths), GIT_TERMINAL_PROMPT: '0' };

  const { stdout } = await execFileAsync(
    ghBinary,
    [
      'api',
      `repos/${ownerRepo}/collaborators`,
      '--paginate',
      '--jq',
      '.[] | {login: .login, name: .name}',
    ],
    { env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );

  // `--jq` over a paginated array yields one JSON object per line (JSONL).
  const out: GitHubCandidate[] = [];
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { login?: string; name?: string | null };
      if (obj.login) out.push({ login: obj.login, name: obj.name || undefined });
    } catch {
      // Skip an unparsable line rather than fail the whole fetch.
    }
  }
  return out;
}

/**
 * Fetch a project's assignable Jira users via
 * `/rest/api/3/user/assignable/search?project={KEY}`. Reuses the Basic-auth fetch
 * pattern from jira-sync.ts (we re-implement the tiny fetch here since jira-sync
 * does not export a generic GET). Returns an empty array on any failure.
 */
async function fetchJiraAssignableUsers(
  cfg: { baseUrl: string; email: string; apiToken: string },
  projectKey: string,
): Promise<JiraCandidate[]> {
  // Jira project keys are alphanumeric/underscore — guard before query interpolation.
  if (!/^[A-Za-z0-9_]+$/.test(projectKey)) {
    throw new Error(`Invalid Jira project key: ${projectKey}`);
  }
  const auth = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  const params = new URLSearchParams({ project: projectKey, maxResults: '100' });
  const res = await fetch(`${cfg.baseUrl}/rest/api/3/user/assignable/search?${params.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Jira assignable/search → HTTP ${res.status} ${res.statusText}`);
  }
  const raw = await res.text();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: JiraCandidate[] = [];
  for (const u of parsed as Array<{ accountId?: string; displayName?: string; emailAddress?: string; accountType?: string }>) {
    if (!u?.accountId) continue;
    // Only offer real people (skip app/bot accounts when the type is exposed).
    if (u.accountType && u.accountType !== 'atlassian') continue;
    out.push({
      accountId: u.accountId,
      displayName: u.displayName || u.accountId,
      email: u.emailAddress || undefined,
    });
  }
  return out;
}

// ─── #22b — season ceremony calendar (standups, grooming, reviews, meetings) ──

const VALID_CEREMONY_KINDS: ReadonlySet<CeremonyKind> = new Set([
  'standup',
  'grooming',
  'sprint-end',
  'team-meeting',
  'custom',
]);
const VALID_CEREMONY_CADENCES: ReadonlySet<CeremonyCadence> = new Set([
  'daily',
  'weekly',
  'biweekly',
  'once',
]);

/** Default per-kind titles when the caller doesn't supply one. */
const DEFAULT_CEREMONY_TITLES: Record<CeremonyKind, string> = {
  standup: 'Standup',
  grooming: 'Backlog Grooming',
  'sprint-end': 'Sprint Review',
  'team-meeting': 'Team Meeting',
  custom: 'Ceremony',
};

/** Loose input for {@link addCeremony} / {@link updateCeremony} (id/createdAt filled). */
export type SeasonCeremonyInput = Partial<Omit<SeasonCeremony, 'id' | 'createdAt'>>;

/** Clamp + sanity-check `dayOfWeek` to 0-6, else undefined. */
function sanitizeDayOfWeek(d: unknown): number | undefined {
  if (typeof d !== 'number' || !Number.isFinite(d)) return undefined;
  const n = Math.trunc(d);
  if (n < 0 || n > 6) return undefined;
  return n;
}

/** Accept only 'HH:MM' 24h; else undefined. */
function sanitizeTime(t: unknown): string | undefined {
  if (typeof t !== 'string') return undefined;
  const trimmed = t.trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed) ? trimmed : undefined;
}

/** Accept only an ISO date 'YYYY-MM-DD'; else undefined. */
function sanitizeStartDate(d: unknown): string | undefined {
  if (typeof d !== 'string') return undefined;
  const trimmed = d.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

/** Clamp duration to a sane 5-720 minute range; default 30. */
function sanitizeDuration(d: unknown): number {
  if (typeof d !== 'number' || !Number.isFinite(d)) return 30;
  const n = Math.trunc(d);
  if (n < 5) return 5;
  if (n > 720) return 720;
  return n;
}

/** Accept only http(s) meeting links; else undefined. */
function sanitizeMeetingLink(l: unknown): string | undefined {
  if (typeof l !== 'string') return undefined;
  const trimmed = l.trim();
  if (!trimmed) return undefined;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a validated {@link SeasonCeremony} from loose input. Defaults missing
 * fields defensively (kind → 'team-meeting', cadence → 'weekly', title → a
 * per-kind default, duration → 30). Pure; never throws.
 */
function buildCeremony(input: SeasonCeremonyInput): SeasonCeremony {
  const kind: CeremonyKind = VALID_CEREMONY_KINDS.has(input.kind as CeremonyKind)
    ? (input.kind as CeremonyKind)
    : 'team-meeting';
  const cadence: CeremonyCadence = VALID_CEREMONY_CADENCES.has(input.cadence as CeremonyCadence)
    ? (input.cadence as CeremonyCadence)
    : 'weekly';
  const title =
    typeof input.title === 'string' && input.title.trim()
      ? input.title.trim().slice(0, 200)
      : DEFAULT_CEREMONY_TITLES[kind];
  const notes = typeof input.notes === 'string' ? input.notes.slice(0, 4000) : undefined;

  return {
    id: uuidv4(),
    kind,
    title,
    cadence,
    dayOfWeek: sanitizeDayOfWeek(input.dayOfWeek),
    time: sanitizeTime(input.time),
    startDate: sanitizeStartDate(input.startDate),
    durationMins: sanitizeDuration(input.durationMins),
    meetingLink: sanitizeMeetingLink(input.meetingLink),
    notes: notes || undefined,
    createdAt: new Date().toISOString(),
  };
}

/** Human label for a ceremony kind (used in the system log entry). */
function ceremonyKindLabel(kind: CeremonyKind): string {
  switch (kind) {
    case 'standup': return 'Standup';
    case 'grooming': return 'Grooming';
    case 'sprint-end': return 'Sprint review';
    case 'team-meeting': return 'Team meeting';
    default: return 'Ceremony';
  }
}

/** Append a `system` conversation entry describing a ceremony change. Never throws. */
function logCeremony(seasonId: string, text: string): void {
  void (async () => {
    try {
      const { appendConversationEntry } = await import('./conversation-log');
      appendConversationEntry(seasonId, {
        agentId: 'system',
        canonName: 'Ops',
        kind: 'system',
        text,
      });
    } catch (err) {
      console.error(`logCeremony: failed to log for season ${seasonId}:`, err);
    }
  })();
}

/**
 * Add a ceremony to a collaborative season's calendar (#22b). Validates input
 * defensively, persists `season.ceremonies`, broadcasts `season:updated`, and
 * logs a system entry. Returns the updated season (undefined for an unknown
 * season). Never throws.
 */
export function addCeremony(seasonId: string, input: SeasonCeremonyInput): Season | undefined {
  const season = seasons.get(seasonId);
  if (!season) return undefined;

  const ceremony = buildCeremony(input ?? {});
  const list = Array.isArray(season.ceremonies) ? season.ceremonies : [];
  season.ceremonies = [...list, ceremony];

  saveSeason(seasonId);
  broadcastToAllWindows('season:updated', season);

  const at = ceremony.time ? ` @ ${ceremony.time}` : '';
  logCeremony(seasonId, `Ceremony added: ${ceremonyKindLabel(ceremony.kind)} "${ceremony.title}"${at}.`);

  return season;
}

/**
 * Update an existing ceremony by id (#22b). Re-validates only the supplied
 * fields, leaving the rest intact (and preserving id/createdAt). Persists +
 * broadcasts + logs. No-op (returns the season unchanged) when the ceremony id
 * isn't found; undefined for an unknown season. Never throws.
 */
export function updateCeremony(
  seasonId: string,
  ceremonyId: string,
  patch: SeasonCeremonyInput,
): Season | undefined {
  const season = seasons.get(seasonId);
  if (!season) return undefined;

  const list = Array.isArray(season.ceremonies) ? season.ceremonies : [];
  const idx = list.findIndex((c) => c.id === ceremonyId);
  if (idx === -1) return season;

  const existing = list[idx];
  const p = patch ?? {};
  // Re-validate the full merged shape so updated fields stay sane, but keep the
  // stable id + createdAt from the existing entry.
  const merged = buildCeremony({
    kind: p.kind ?? existing.kind,
    title: p.title ?? existing.title,
    cadence: p.cadence ?? existing.cadence,
    dayOfWeek: p.dayOfWeek ?? existing.dayOfWeek,
    time: p.time ?? existing.time,
    startDate: p.startDate ?? existing.startDate,
    durationMins: p.durationMins ?? existing.durationMins,
    meetingLink: p.meetingLink ?? existing.meetingLink,
    notes: p.notes ?? existing.notes,
  });
  const updated: SeasonCeremony = { ...merged, id: existing.id, createdAt: existing.createdAt };

  const next = list.slice();
  next[idx] = updated;
  season.ceremonies = next;

  saveSeason(seasonId);
  broadcastToAllWindows('season:updated', season);

  logCeremony(seasonId, `Ceremony updated: ${ceremonyKindLabel(updated.kind)} "${updated.title}".`);

  return season;
}

/**
 * Remove a ceremony by id (#22b). Persists + broadcasts + logs. No-op (returns
 * the season unchanged) when the id isn't found; undefined for an unknown
 * season. Never throws.
 */
export function removeCeremony(seasonId: string, ceremonyId: string): Season | undefined {
  const season = seasons.get(seasonId);
  if (!season) return undefined;

  const list = Array.isArray(season.ceremonies) ? season.ceremonies : [];
  const target = list.find((c) => c.id === ceremonyId);
  if (!target) return season;

  season.ceremonies = list.filter((c) => c.id !== ceremonyId);

  saveSeason(seasonId);
  broadcastToAllWindows('season:updated', season);

  logCeremony(seasonId, `Ceremony removed: ${ceremonyKindLabel(target.kind)} "${target.title}".`);

  return season;
}
