/**
 * Claude pre-trust helper.
 *
 * Echelon owns the season workspace + per-agent worktrees (under
 * `~/.echelon/seasons/<id>/...`). When an agent launches the Claude CLI in one
 * of those directories, Claude would normally show its per-folder "Do you trust
 * the files in this folder?" dialog, which blocks a headless season launch.
 *
 * This module marks Echelon-owned directories as already-trusted in Claude's
 * config (`~/.claude.json`) by setting `hasTrustDialogAccepted: true` and
 * `hasCompletedProjectOnboarding: true` on that directory's `projects` entry.
 *
 * Scope: this is a TARGETED fix for Echelon-owned directories only — it never
 * disables permission prompts globally, and it never touches directories the
 * user opens themselves. The agent's per-action permission posture (normal /
 * auto / bypass) is a separate, user-selected concern handled in spawnSeason.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Absolute path to Claude's global config file. */
function claudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/** Shape of a single `projects[<dir>]` entry we care about (rest preserved). */
interface ClaudeProjectEntry {
  hasTrustDialogAccepted?: boolean;
  hasCompletedProjectOnboarding?: boolean;
  [key: string]: unknown;
}

interface ClaudeConfig {
  projects?: Record<string, ClaudeProjectEntry>;
  [key: string]: unknown;
}

/**
 * Mark a single directory as trusted in `~/.claude.json`.
 *
 * Preserves every other key in the file and in the project entry. Creates the
 * `projects` map and/or the per-directory entry if they don't exist. Returns
 * `true` if the file was written (i.e. a change was needed), `false` if the
 * directory was already trusted or on any non-fatal error.
 */
export function trustClaudeProject(dir: string): boolean {
  if (!dir) return false;

  const configPath = claudeConfigPath();
  const resolved = path.resolve(dir);

  let config: ClaudeConfig = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ClaudeConfig;
    }
  } catch (err) {
    // A corrupt config is not ours to repair — bail without clobbering it.
    console.warn(`trustClaudeProject: could not read ${configPath}:`, err);
    return false;
  }

  if (!config.projects || typeof config.projects !== 'object') {
    config.projects = {};
  }

  const existing = config.projects[resolved] ?? {};
  const alreadyTrusted =
    existing.hasTrustDialogAccepted === true &&
    existing.hasCompletedProjectOnboarding === true;
  if (alreadyTrusted) return false;

  config.projects[resolved] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };

  // Atomic write: write to a temp file in the same dir, then rename over the
  // target so a concurrent reader never sees a half-written file.
  try {
    const tmpPath = `${configPath}.echelon-${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch (err) {
    console.warn(`trustClaudeProject: could not write ${configPath}:`, err);
    return false;
  }
}

/**
 * Mark several directories as trusted in one pass. De-duplicates and ignores
 * falsy entries. Returns the count of entries that were newly trusted.
 */
export function trustClaudeProjects(dirs: Array<string | undefined>): number {
  const unique = Array.from(new Set(dirs.filter((d): d is string => Boolean(d))));
  let changed = 0;
  for (const dir of unique) {
    if (trustClaudeProject(dir)) changed++;
  }
  return changed;
}
