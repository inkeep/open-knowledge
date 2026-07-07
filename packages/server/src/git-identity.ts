/**
 * Git identity resolution chain.
 *
 * Resolves git user.name + user.email for auto-save commits via:
 *   1. Per-worktree git config (.git/worktrees/<name>/config.worktree)
 *   2. Repo-local / common git config (.git/config)
 *   3. Global git config (~/.gitconfig)
 *   4. Stored token entry (login + name/email from OAuth profile)
 *   5. null — caller must prompt
 *
 * Step 1 only fires when `extensions.worktreeConfig` is enabled; otherwise
 * `git config --worktree` errors out in linked worktrees, which the reader
 * surfaces as null and the chain falls through.
 *
 * Uses spawnSync('git', ['config', …]) instead of simple-git so this module
 * has no runtime dependency on simple-git (avoids broken symlink in test env).
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Minimal token-store interface (structurally compatible with CLI's TokenStore).
 * Only the `get` side is needed for identity resolution.
 */
export interface GitIdentityTokenStore {
  get(host: string): Promise<{ login: string; name?: string; email?: string } | null>;
}

/**
 * Injectable git-config reader (real or mock in tests).
 *
 * @param projectDir  Absolute path to the git root.
 * @param key         Git config key (e.g. 'user.name').
 * @param scope       'worktree' reads .git/worktrees/<name>/config.worktree (only
 *                    populated when `extensions.worktreeConfig` is enabled);
 *                    'local' reads .git/config; 'global' reads ~/.gitconfig.
 * @returns The trimmed value, or null if not set / not found.
 */
export type GitConfigReader = (
  projectDir: string,
  key: string,
  scope: 'worktree' | 'local' | 'global',
) => string | null;

// ─── Default reader (production) ─────────────────────────────────────────────

/**
 * Production config reader — spawns `git config --worktree|--local|--global <key>`.
 * Returns null on any error (non-zero exit, missing key, spawn failure). `--worktree`
 * in a linked worktree without `extensions.worktreeConfig` exits 128 (fatal); that
 * still maps to null, which is the correct fall-through for the chain.
 */
const defaultGitConfigReader: GitConfigReader = (projectDir, key, scope) => {
  const scopeFlag =
    scope === 'worktree' ? '--worktree' : scope === 'local' ? '--local' : '--global';
  const result = spawnSync('git', ['config', scopeFlag, key], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim() || null;
};

// ─── Worktree helpers ─────────────────────────────────────────────────────────

/**
 * Detect a linked git worktree by comparing `--git-dir` (per-worktree) against
 * `--git-common-dir` (shared with the main checkout). Equal → main worktree or
 * unrelated; different → linked. Returns false on any git error so non-repo
 * `projectDir`s pass through.
 *
 * Why this matters: `git config --local` writes to `$GIT_COMMON_DIR/config`
 * even when invoked from a linked worktree, so a per-checkout identity needs
 * the `--worktree` flag (which requires `extensions.worktreeConfig`).
 */
function isLinkedWorktree(projectDir: string): boolean {
  const gd = spawnSync('git', ['rev-parse', '--git-dir'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  const cd = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (gd.status !== 0 || cd.status !== 0) return false;
  const gdPath = resolve(projectDir, gd.stdout.trim());
  const cdPath = resolve(projectDir, cd.stdout.trim());
  return gdPath !== cdPath;
}

/**
 * Idempotently flip `extensions.worktreeConfig=true` on the common config.
 * No-op when already enabled. Required before any `--worktree` write in a
 * linked worktree (git rejects `--worktree` otherwise with exit 128).
 *
 * Side effect is bounded + additive: existing common-config keys keep applying
 * to every worktree until a per-worktree `--worktree` write overrides them.
 */
function ensureWorktreeConfigExtension(projectDir: string): void {
  // Probe `--local` (not the merged config) so the probe and the enable target
  // the same scope. Git only honors `extensions.*` from the repo-level config,
  // so a stray `extensions.worktreeConfig=true` in `~/.gitconfig` would short-
  // circuit a scope-less probe but git would still reject `--worktree`.
  const probe = spawnSync('git', ['config', '--local', '--get', 'extensions.worktreeConfig'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (probe.status === 0 && /^(true|yes|on|1)$/i.test(probe.stdout.trim())) return;

  const enable = spawnSync('git', ['config', '--local', 'extensions.worktreeConfig', 'true'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (enable.status !== 0) {
    const stderr = enable.stderr?.trim() ?? '';
    const spawnErr = enable.error ? ` [${enable.error.message}]` : '';
    throw new Error(`failed to enable extensions.worktreeConfig: ${stderr}${spawnErr}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve git identity for auto-save commits.
 *
 * Chain (stops at first complete name+email pair):
 *   1. per-worktree config (`--worktree`; only meaningful when extension on)
 *   2. repo-local / common config (`--local`)
 *   3. global config (`--global`)
 *   4. TokenStore entry (login as name fallback; entry.name preferred)
 *   5. null (caller must prompt)
 *
 * @param projectDir  Absolute path to the git root.
 * @param tokenStore  Optional credential store for fallback identity.
 * @param host        Hostname to look up in tokenStore (e.g. 'github.com').
 * @param _reader     Injectable config reader (for unit tests).
 */
export async function resolveGitIdentity(
  projectDir: string,
  tokenStore?: GitIdentityTokenStore | null,
  host?: string | null,
  _reader: GitConfigReader = defaultGitConfigReader,
): Promise<GitIdentity | null> {
  // ── Step 1: per-worktree config ───────────────────────────────────────────
  // Harmless on main worktrees / non-git dirs: reader maps any non-zero exit
  // (incl. "extensions.worktreeConfig not enabled" fatal) to null.
  const worktreeName = _reader(projectDir, 'user.name', 'worktree');
  const worktreeEmail = _reader(projectDir, 'user.email', 'worktree');
  if (worktreeName && worktreeEmail) {
    return { name: worktreeName, email: worktreeEmail };
  }

  // ── Step 2: repo-local / common config ─────────────────────────────────────
  const localName = _reader(projectDir, 'user.name', 'local');
  const localEmail = _reader(projectDir, 'user.email', 'local');
  if (localName && localEmail) {
    return { name: localName, email: localEmail };
  }

  // ── Step 3: global config ──────────────────────────────────────────────────
  const globalName = _reader(projectDir, 'user.name', 'global');
  const globalEmail = _reader(projectDir, 'user.email', 'global');
  if (globalName && globalEmail) {
    return { name: globalName, email: globalEmail };
  }

  // ── Step 4: stored token entry ─────────────────────────────────────────────
  if (tokenStore && host) {
    const entry = await tokenStore.get(host);
    if (entry) {
      const name = entry.name ?? entry.login;
      // email may not be available from the OAuth profile (private email setting)
      const email = entry.email ?? `${entry.login}@users.noreply.github.com`;
      if (name) {
        return { name, email };
      }
    }
  }

  // ── Step 5: unresolved ────────────────────────────────────────────────────
  return null;
}

/**
 * Write git identity to the checkout the caller is in.
 *
 * - Main worktree (or `.git` is a real directory): writes `--local`, i.e.
 *   `<projectDir>/.git/config`. Identity applies to every linked worktree
 *   that doesn't override it.
 * - Linked worktree (`.git` is a pointer file): enables
 *   `extensions.worktreeConfig` once (idempotent) and writes `--worktree`,
 *   i.e. `<commonDir>/worktrees/<name>/config.worktree`. Per-checkout — the
 *   main repo's identity is unaffected.
 *
 * Background: `git config --local` is shared-config-scoped regardless of which
 * worktree it runs from, so without this fork users who set identity from a
 * linked worktree silently rewrote the main checkout's identity.
 *
 * @param projectDir  Absolute path to the worktree the caller is in.
 * @param name        Display name to write.
 * @param email       Email address to write.
 */
export function writeGitIdentity(projectDir: string, name: string, email: string): void {
  let scopeFlag: '--worktree' | '--local' = '--local';
  if (isLinkedWorktree(projectDir)) {
    ensureWorktreeConfigExtension(projectDir);
    scopeFlag = '--worktree';
  }
  const setConfig = (key: string, value: string) => {
    const result = spawnSync('git', ['config', scopeFlag, key, value], {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      const spawnErr = result.error ? ` [${result.error.message}]` : '';
      throw new Error(`git config ${scopeFlag} ${key} failed: ${stderr}${spawnErr}`);
    }
  };
  setConfig('user.name', name);
  setConfig('user.email', email);
}
