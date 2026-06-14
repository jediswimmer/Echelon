import { ipcMain, BrowserWindow } from 'electron';
import {
  getAllSeasons,
  getSeason,
  spawnSeason,
  launchSeasonAgents,
  archiveSeason,
  restoreSeason,
} from '../core/season-manager';
import type { SeasonRuntimeDeps } from '../core/season-manager';
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
}
