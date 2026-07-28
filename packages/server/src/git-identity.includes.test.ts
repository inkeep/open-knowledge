/**
 * Integration tests for resolveGitIdentity against a real git repo whose
 * identity is supplied through `include` / `includeIf` directives.
 *
 * Regression: users who switch committer identity via
 * `includeIf "gitdir:…"` or `includeIf "hasconfig:remote.*.url:…"` in their
 * global config saw OK fail to discover any identity. The old chain probed
 * `--worktree` / `--local` / `--global` scopes one at a time, and a
 * scope-limited read never resolves included config — only the effective
 * merged read (`git config --get`) does.
 *
 * Isolation: GIT_CONFIG_GLOBAL points git at a temp global file and
 * GIT_CONFIG_SYSTEM is neutralized, so the ambient developer / CI git identity
 * cannot leak in. All other GIT_* vars are scrubbed so an inherited GIT_DIR
 * doesn't redirect the reads into the surrounding repo.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resolveGitIdentity } from './git-identity.ts';

function run(cwd: string, ...args: string[]): { status: number; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 });
  return { status: result.status ?? -1, stderr: result.stderr?.trim() ?? '' };
}

describe('resolveGitIdentity with included git config', () => {
  let tmp: string;
  let repo: string;
  let identityFile: string;
  let globalFile: string;
  let savedGitEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Scrub inherited GIT_* so a parent shell can't redirect our reads, then
    // pin the global/system config so the developer's real identity can't leak.
    savedGitEnv = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('GIT_')) {
        savedGitEnv[k] = process.env[k];
        delete process.env[k];
      }
    }

    tmp = mkdtempSync(join(tmpdir(), 'ok-git-identity-inc-'));
    repo = join(tmp, 'repo');
    identityFile = join(tmp, 'identity');
    globalFile = join(tmp, 'gitconfig');

    process.env.GIT_CONFIG_GLOBAL = globalFile;
    process.env.GIT_CONFIG_NOSYSTEM = '1';

    writeFileSync(identityFile, '[user]\n\tname = Included Dev\n\temail = included@example.com\n');

    expect(run(tmp, 'init', '-b', 'main', 'repo').status).toBe(0);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('GIT_')) delete process.env[k];
    }
    for (const [k, v] of Object.entries(savedGitEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('resolves identity from an unconditional [include] directive', async () => {
    writeFileSync(globalFile, `[include]\n\tpath = ${identityFile}\n`);
    const resolved = await resolveGitIdentity(repo);
    expect(resolved).toEqual({ name: 'Included Dev', email: 'included@example.com' });
  });

  test('resolves identity from includeIf "gitdir:" matching the repo', async () => {
    // Glob on the unique temp-dir basename so symlinked temp roots
    // (e.g. macOS /var -> /private/var) still match.
    const marker = basename(tmp);
    writeFileSync(globalFile, `[includeIf "gitdir:**/${marker}/**"]\n\tpath = ${identityFile}\n`);
    const resolved = await resolveGitIdentity(repo);
    expect(resolved).toEqual({ name: 'Included Dev', email: 'included@example.com' });
  });

  test('resolves identity from includeIf "hasconfig:remote.*.url:" once the remote matches', async () => {
    writeFileSync(
      globalFile,
      '[includeIf "hasconfig:remote.*.url:git@github.com:acme/**"]\n' +
        `\tpath = ${identityFile}\n`,
    );

    // Before the matching remote exists the condition is false → no identity.
    expect(await resolveGitIdentity(repo)).toBeNull();

    expect(run(repo, 'remote', 'add', 'origin', 'git@github.com:acme/thing.git').status).toBe(0);
    const resolved = await resolveGitIdentity(repo);
    expect(resolved).toEqual({ name: 'Included Dev', email: 'included@example.com' });
  });
});
