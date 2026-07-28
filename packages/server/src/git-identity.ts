/**
 * Git identity resolution chain.
 *
 * Resolves git user.name + user.email for auto-save commits via:
 *   1. Effective (merged) git config — the identity git itself would commit
 *      with, read from the project dir
 *   2. Stored token entry (login + name/email from OAuth profile)
 *   3. null — caller must prompt
 *
 * Step 1 reads the *merged* config (`git config --get <key>`, no scope flag)
 * rather than probing `--worktree` / `--local` / `--global` in turn. The merged
 * read is what git resolves for a commit: it honors the full scope precedence
 * (system < global < local < worktree) AND — critically — resolves `include` /
 * `includeIf` directives (e.g. `gitdir:` or `hasconfig:remote.*.url:` identity
 * switching). Scope-limited reads only see values written literally in that one
 * file, so an identity supplied through an included config is invisible to them.
 *
 * Uses spawnSync('git', ['config', …]) instead of simple-git so this module
 * has no runtime dependency on simple-git (avoids broken symlink in test env).
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';

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
 * Reads the *effective* (merged) config from `projectDir`, i.e. what git
 * resolves for a commit after applying scope precedence and all `include` /
 * `includeIf` directives — not a single scope's raw file.
 *
 * @param projectDir  Absolute path to the git root.
 * @param key         Git config key (e.g. 'user.name').
 * @returns The trimmed value, or null if not set / not found.
 */
export type GitConfigReader = (projectDir: string, key: string) => string | null;

// ─── Default reader (production) ─────────────────────────────────────────────

/**
 * Production config reader — spawns `git config --get <key>` (no scope flag) so
 * git returns the effective merged value: full scope precedence plus resolved
 * `include` / `includeIf` directives. Returns null on any error (non-zero exit,
 * missing key, spawn failure).
 */
const defaultGitConfigReader: GitConfigReader = (projectDir, key) => {
  const result = spawnSync(
    'git',
    ['config', '--get', key],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
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
  const gd = spawnSync(
    'git',
    ['rev-parse', '--git-dir'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
  const cd = spawnSync(
    'git',
    ['rev-parse', '--git-common-dir'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
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
  const probe = spawnSync(
    'git',
    ['config', '--local', '--get', 'extensions.worktreeConfig'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
  if (probe.status === 0 && /^(true|yes|on|1)$/i.test(probe.stdout.trim())) return;

  const enable = spawnSync(
    'git',
    ['config', '--local', 'extensions.worktreeConfig', 'true'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
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
 *   1. effective merged git config (`git config --get`; resolves scope
 *      precedence + `include` / `includeIf` directives)
 *   2. TokenStore entry (login as name fallback; entry.name preferred)
 *   3. null (caller must prompt)
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
  // ── Step 1: effective merged git config ────────────────────────────────────
  // The identity git itself commits with. The merged read resolves the full
  // scope precedence (system < global < local < worktree) and — unlike a
  // scope-limited read — any identity supplied through an `include` /
  // `includeIf` directive (gitdir / hasconfig identity switching).
  const configName = _reader(projectDir, 'user.name');
  const configEmail = _reader(projectDir, 'user.email');
  if (configName && configEmail) {
    return { name: configName, email: configEmail };
  }

  // ── Step 2: stored token entry ─────────────────────────────────────────────
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

  // ── Step 3: unresolved ─────────────────────────────────────────────────────
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
    const result = spawnSync(
      'git',
      ['config', scopeFlag, key, value],
      withHiddenWindowsConsole({
        cwd: projectDir,
        encoding: 'utf-8',
        timeout: 5_000,
      }),
    );
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      const spawnErr = result.error ? ` [${result.error.message}]` : '';
      throw new Error(`git config ${scopeFlag} ${key} failed: ${stderr}${spawnErr}`);
    }
  };
  setConfig('user.name', name);
  setConfig('user.email', email);
}
