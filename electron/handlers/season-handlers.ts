import { ipcMain, BrowserWindow } from 'electron';
import {
  getAllSeasons,
  getSeason,
  spawnSeason,
  launchSeasonAgents,
  archiveSeason,
  restoreSeason,
  answerSeasonDirection,
  setSeasonMode,
  setHumanTeam,
  listHumanTeamCandidates,
  addCeremony,
  updateCeremony,
  removeCeremony,
} from '../core/season-manager';
import type { SeasonRuntimeDeps, SeasonCeremonyInput } from '../core/season-manager';
import type { SeasonMode, HumanSeat } from '../types/echelon';
import { readConversation } from '../core/conversation-log';
import type { ConversationKind } from '../core/conversation-log';
import { importJiraToBoard, jiraStatusForSeason } from '../services/jira-sync';
import { forceOpenEpicPR } from '../services/git-pr';
import type { AgentStatus, AgentPermissionMode, AppSettings } from '../types';

export interface SeasonHandlerDependencies {
  getMainWindow: () => BrowserWindow | null;
  getAppSettings: () => AppSettings;
  handleStatusChangeNotification: (agent: AgentStatus, newStatus: string) => void;
  initAgentPty: (agent: AgentStatus) => Promise<string>;
  saveAgents: () => void;
}

export function registerSeasonHandlers(deps: SeasonHandlerDependencies): void {
  const { getMainWindow } = deps;

  const runtimeDeps: SeasonRuntimeDeps = {
    getMainWindow,
    getAppSettings: deps.getAppSettings,
    handleStatusChangeNotification: deps.handleStatusChangeNotification,
    initAgentPty: deps.initAgentPty,
    saveAgents: deps.saveAgents,
  };

  // List all seasons
  ipcMain.handle('season:list', async () => {
    try {
      const seasons = getAllSeasons();
      return { seasons };
    } catch (err) {
      console.error('Failed to list seasons:', err);
      return { seasons: [], error: String(err) };
    }
  });

  // Get a single season by id
  ipcMain.handle('season:get', async (_event, id: string) => {
    try {
      const season = getSeason(id);
      if (!season) {
        return { error: 'Season not found' };
      }
      return { season };
    } catch (err) {
      console.error('Failed to get season:', err);
      return { error: String(err) };
    }
  });

  // Spawn a new season — casts a live team and launches the agents.
  //
  // Two roster paths:
  //   • Default (PRD chat): leave `rosterEntries` empty + supply `prd`; the
  //     roster is AUTO-COMPOSED from the PRD inside spawnSeason.
  //   • Advanced override: supply `rosterEntries` explicitly.
  // `permissionMode` is the user-selected season posture, applied to every agent.
  ipcMain.handle('season:spawn', async (_event, config: {
    id: string;
    name: string;
    theme: string;
    prd?: string;
    permissionMode?: AgentPermissionMode;
    rosterEntries?: Array<{
      archetype: string;
      character: string;
      capabilities: string[];
    }>;
    /**
     * Optional source-control linkage; `github`/`azure-devops` + repoUrl ⇒ clone
     * as workspace; `local-clone` + localPath ⇒ adopt an existing clone in-place.
     */
    sourceControl?: { type: 'local' | 'github' | 'azure-devops' | 'local-clone'; repoUrl?: string; localPath?: string };
    /** Optional Jira project key — captured + stored + displayed only. */
    jiraProjectKey?: string;
    /** Intake mode: 'greenfield' (default) or 'brownfield' (existing repo). */
    intake?: 'greenfield' | 'brownfield';
  }) => {
    try {
      const season = await spawnSeason(config, runtimeDeps);
      // Fire the team up: init PTYs, inject souls, hand the PRD to the convener.
      await launchSeasonAgents(config.id, config.prd, runtimeDeps);
      return { success: true, season };
    } catch (err) {
      console.error('Failed to spawn season:', err);
      return { success: false, error: String(err) };
    }
  });

  // Archive a season
  ipcMain.handle('season:archive', async (_event, id: string) => {
    try {
      archiveSeason(id);
      const season = getSeason(id);
      return { success: true, season };
    } catch (err) {
      console.error('Failed to archive season:', err);
      return { success: false, error: String(err) };
    }
  });

  // Restore a season
  ipcMain.handle('season:restore', async (_event, id: string) => {
    try {
      restoreSeason(id);
      const season = getSeason(id);
      return { success: true, season };
    } catch (err) {
      console.error('Failed to restore season:', err);
      return { success: false, error: String(err) };
    }
  });

  // List characters for a season
  ipcMain.handle('season:characters', async (_event, seasonId: string) => {
    try {
      const season = getSeason(seasonId);
      if (!season) {
        return { characters: [], error: 'Season not found' };
      }
      return { characters: season.characterIds };
    } catch (err) {
      console.error('Failed to list season characters:', err);
      return { characters: [], error: String(err) };
    }
  });

  // Answer a season's "needs your direction" prompt (17c). Records the choice and
  // — when an epic/story was chosen — moves its children into `planned` so the
  // existing assign-automation kicks the team off.
  ipcMain.handle(
    'season:direction:answer',
    async (_event, seasonId: string, payload: { answer?: string; chosenOptionId?: string }) => {
      try {
        await answerSeasonDirection(seasonId, payload ?? {});
        return { success: true, season: getSeason(seasonId) };
      } catch (err) {
        console.error('Failed to answer season direction:', err);
        return { success: false, error: String(err) };
      }
    },
  );

  // List a season's conversation / crosstalk log (17b). Seeds the Conversation
  // tab; live updates arrive via the `season:conversation:appended` broadcast.
  ipcMain.handle(
    'season:conversation:list',
    async (
      _event,
      seasonId: string,
      opts?: { kind?: ConversationKind; agentId?: string; limit?: number; sinceTs?: string },
    ) => {
      try {
        return { entries: readConversation(seasonId, opts) };
      } catch (err) {
        console.error('Failed to list season conversation:', err);
        return { entries: [], error: String(err) };
      }
    },
  );

  // Two-way Jira sync (17d): pull the season's linked Jira project and upsert its
  // issues as season-scoped kanban tasks (matched by jiraKey). Resilient — the
  // service never throws; a disabled/unlinked/error case comes back as a clear
  // result. Live `kanban:task-created/updated` broadcasts refresh the board.
  ipcMain.handle('season:jira:import', async (_event, seasonId: string) => {
    return importJiraToBoard(seasonId);
  });

  // Lightweight gate for the board's Sync button: is Jira enabled + which
  // project (if any) is linked to this season.
  ipcMain.handle('season:jira:status', async (_event, seasonId: string) => {
    return jiraStatusForSeason(seasonId);
  });

  // Branch-per-Epic + PR-on-completion (17e): manually open (or resolve) the
  // team-factory PR for a specific epic/story from the UI. Resilient — the
  // service never throws; a non-GitHub / no-gh / nothing-to-review case comes
  // back as `{ opened: false, reason }`. Never auto-merges.
  ipcMain.handle('season:epic:open-pr', async (_event, seasonId: string, epicTaskId: string) => {
    return forceOpenEpicPR(seasonId, epicTaskId);
  });

  // ── #22a — season mode + human hybrid dev team ──────────────────────────────

  // Set the season's operating mode (autonomous vs collaborative). Persists +
  // broadcasts + logs a system entry. Returns the updated season.
  ipcMain.handle('season:mode:set', async (_event, seasonId: string, mode: SeasonMode) => {
    try {
      const season = setSeasonMode(seasonId, mode);
      if (!season) return { success: false, error: 'Season not found.' };
      return { success: true, season };
    } catch (err) {
      console.error('Failed to set season mode:', err);
      return { success: false, error: String(err) };
    }
  });

  // Populate (or clear) the season's human hybrid dev team. Stops the cast agent
  // for each newly human-owned archetype; an empty array clears the team. Returns
  // the updated season.
  ipcMain.handle('season:humanteam:set', async (_event, seasonId: string, seats: HumanSeat[]) => {
    try {
      const season = setHumanTeam(seasonId, Array.isArray(seats) ? seats : []);
      if (!season) return { success: false, error: 'Season not found.' };
      return { success: true, season };
    } catch (err) {
      console.error('Failed to set human team:', err);
      return { success: false, error: String(err) };
    }
  });

  // Best-effort fetch of the humans who could own a role (GitHub collaborators +
  // Jira assignable users). Never throws — unavailable sources come back empty
  // with a reason.
  ipcMain.handle('season:humanteam:candidates', async (_event, seasonId: string) => {
    try {
      return await listHumanTeamCandidates(seasonId);
    } catch (err) {
      console.error('Failed to list human team candidates:', err);
      return { github: [], jira: [], reasons: { github: String(err), jira: String(err) } };
    }
  });

  // ── #22b — season ceremony calendar (standups, grooming, reviews, meetings) ──
  // Each handler validates input backend-side (the core functions never throw)
  // and returns the updated season for the renderer; the `season:updated`
  // broadcast keeps the live control board in sync.

  ipcMain.handle('season:ceremony:add', async (_event, seasonId: string, input: SeasonCeremonyInput) => {
    try {
      const season = addCeremony(seasonId, input ?? {});
      if (!season) return { success: false, error: 'Season not found.' };
      return { success: true, season };
    } catch (err) {
      console.error('Failed to add ceremony:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(
    'season:ceremony:update',
    async (_event, seasonId: string, ceremonyId: string, patch: SeasonCeremonyInput) => {
      try {
        const season = updateCeremony(seasonId, ceremonyId, patch ?? {});
        if (!season) return { success: false, error: 'Season not found.' };
        return { success: true, season };
      } catch (err) {
        console.error('Failed to update ceremony:', err);
        return { success: false, error: String(err) };
      }
    },
  );

  ipcMain.handle('season:ceremony:remove', async (_event, seasonId: string, ceremonyId: string) => {
    try {
      const season = removeCeremony(seasonId, ceremonyId);
      if (!season) return { success: false, error: 'Season not found.' };
      return { success: true, season };
    } catch (err) {
      console.error('Failed to remove ceremony:', err);
      return { success: false, error: String(err) };
    }
  });
}
