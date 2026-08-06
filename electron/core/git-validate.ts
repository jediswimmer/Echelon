/**
 * git-validate.ts — Validate an existing local git clone before adopting it as a
 * season workspace ("local-clone" source-control mode).
 *
 * The user points Echelon at a folder they have already cloned. Before we use it
 * in-place (and cast worktrees off it), we verify, in order:
 *
 *   (a) the path exists and is a directory,
 *   (b) it is inside a git work tree   (git -C <path> rev-parse --is-inside-work-tree),
 *   (c) it has at least one git remote (git -C <path> remote),
 *   (d) that remote is reachable       (git -C <path> ls-remote --exit-code <remote>).
 *
 * Each step returns a clear, actionable, typed failure so the kickoff UI can tell
 * the user exactly what to fix (not a repo / no remote / remote unreachable/auth).
 *
 * Security: every git invocation uses execFile with an args array (NO shell), so
 * the user-supplied path is never interpolated into a shell string. `-C <path>`
 * passes the directory as a discrete argument. PATH is resolved via
 * {@link buildFullPath} (plus any user-configured CLI dirs) so `git` is found
 * even when the app launched without a login-shell PATH. Remote reachability runs
 * with GIT_TERMINAL_PROMPT=0 and a bounded timeout so a credential prompt or a
 * dead network can never hang the spawn.
 */

import * as fs from 'fs';
import { buildFullPath } from '../utils/path-builder';
import type { AppSettings } from '../types';

/** Why a local-clone validation failed (drives the UI's actionable message). */
export type GitValidateFailureReason =
  | 'not-found' // path missing or not a directory
  | 'not-a-repo' // exists but not inside a git work tree
  | 'no-remote' // a git repo, but with no configured remote
  | 'remote-unreachable'; // remote exists but ls-remote failed (network/auth)

/** Result of {@link validateLocalClone}. */
export type GitValidateResult =
  | {
      ok: true;
      /** Realpath-resolved absolute path to the validated clone. */
      resolvedPath: string;
      /** The remote name that was probed (e.g. "origin"). */
      remote: string;
    }
  | {
      ok: false;
      reason: GitValidateFailureReason;
      /** Human-readable, actionable message safe to surface to the user. */
      message: string;
    };

/** How long (ms) to allow the network-touching `ls-remote` probe to run. */
const LS_REMOTE_TIMEOUT_MS = 20_000;
/** How long (ms) to allow the local-only git checks to run. */
const LOCAL_GIT_TIMEOUT_MS = 10_000;

/** Build the child-process env with a resolved PATH + non-interactive git. */
function buildGitEnv(appSettings: AppSettings): NodeJS.ProcessEnv {
  const cliExtraPaths: string[] = [];
  const cliPaths = appSettings.cliPaths;
  if (cliPaths) {
    for (const key of ['gh', 'node'] as const) {
      const p = cliPaths[key];
      if (p) cliExtraPaths.push(require('path').dirname(p));
    }
    if (Array.isArray(cliPaths.additionalPaths)) {
      cliExtraPaths.push(...cliPaths.additionalPaths.filter(Boolean));
    }
  }
  return {
    ...process.env,
    PATH: buildFullPath(cliExtraPaths),
    // Never let git block on a credential/host-key prompt during validation.
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Validate that `inputPath` is an existing local git clone with a reachable
 * remote, suitable for use as a season workspace in-place. Never throws — all
 * failure modes are returned as a typed `{ ok: false }` result.
 */
export async function validateLocalClone(
  inputPath: string,
  appSettings: AppSettings,
): Promise<GitValidateResult> {
  const { execFile } = require('child_process') as typeof import('child_process');
  const { promisify } = require('util') as typeof import('util');
  const execFileAsync = promisify(execFile);

  const raw = (inputPath ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      reason: 'not-found',
      message: 'No folder path was provided. Pick the folder of a repo you have already cloned.',
    };
  }

  // ── (a) exists + is a directory ──
  let resolvedPath: string;
  try {
    const stat = fs.statSync(raw);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        reason: 'not-found',
        message: `That path is not a folder: ${raw}. Point at the root folder of a local git clone.`,
      };
    }
    // Resolve symlinks to a canonical absolute path so worktrees + trust target
    // the real directory.
    resolvedPath = fs.realpathSync(raw);
  } catch {
    return {
      ok: false,
      reason: 'not-found',
      message: `Folder not found: ${raw}. Check the path and make sure the clone exists on this machine.`,
    };
  }

  const env = buildGitEnv(appSettings);
  const localOpts = { env, timeout: LOCAL_GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 };

  // ── (b) inside a git work tree ──
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', resolvedPath, 'rev-parse', '--is-inside-work-tree'],
      localOpts,
    );
    if (String(stdout).trim() !== 'true') {
      return {
        ok: false,
        reason: 'not-a-repo',
        message: `That folder is not a git work tree: ${resolvedPath}. Choose a folder you cloned with git (it must contain a .git), or use "Local workspace only" / a remote repo instead.`,
      };
    }
  } catch {
    return {
      ok: false,
      reason: 'not-a-repo',
      message: `That folder is not a git repository: ${resolvedPath}. Choose a folder you cloned with git, or use "Local workspace only" / a remote repo instead.`,
    };
  }

  // ── (c) at least one remote ──
  let remote: string;
  try {
    const { stdout } = await execFileAsync('git', ['-C', resolvedPath, 'remote'], localOpts);
    const remotes = String(stdout)
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean);
    if (remotes.length === 0) {
      return {
        ok: false,
        reason: 'no-remote',
        message: `This clone has no git remote configured, so Echelon can't validate its connection. Add a remote (e.g. \`git remote add origin <url>\`), or pick a repo that has one.`,
      };
    }
    // Prefer "origin" when present; otherwise probe the first remote.
    remote = remotes.includes('origin') ? 'origin' : remotes[0];
  } catch {
    return {
      ok: false,
      reason: 'no-remote',
      message: `Could not read the git remotes for ${resolvedPath}. Make sure it is a healthy clone with a remote configured.`,
    };
  }

  // ── (d) remote reachable ──
  // `ls-remote --exit-code` returns non-zero when it can't reach/list the remote
  // (network down, host unknown, or auth required). With GIT_TERMINAL_PROMPT=0 it
  // fails fast instead of prompting; the timeout caps any slow hang.
  try {
    await execFileAsync(
      'git',
      ['-C', resolvedPath, 'ls-remote', '--exit-code', remote],
      { env, timeout: LS_REMOTE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch {
    return {
      ok: false,
      reason: 'remote-unreachable',
      message: `Couldn't reach the "${remote}" remote for this clone. Check your network and that you're authenticated for the remote (e.g. credentials / SSH key), then try again.`,
    };
  }

  return { ok: true, resolvedPath, remote };
}
