/**
 * `git worktree remove` cleans up the per-worktree shadow at the same
 * time as Git's own admin directory.
 *
 * A stale `.git` pointer file (left by an aborted `worktree remove` or
 * a manual `rm -rf` of the admin dir without `git worktree prune`) surfaces
 * a typed `MalformedGitPointerError` at the boot level instead of crashing
 * downstream in `mkdirSync`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bootServer, ConfigSchema } from '@inkeep/open-knowledge-server';
import { createLinkedWorktree, type LinkedWorktreeHandle } from './worktree-test-harness.ts';

const TEST_CONFIG = ConfigSchema.parse({});

let handle: LinkedWorktreeHandle | null = null;
const adhocDirs: string[] = [];

afterEach(() => {
  handle?.cleanup();
  handle = null;
  for (const d of adhocDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('git worktree remove cleans up the per-worktree shadow (FR6)', () => {
  test('after boot+remove, <repo>/.git/worktrees/<name>/ no longer exists (shadow vanished too)', async () => {
    handle = createLinkedWorktree({ seedOkScaffold: true });
    const adminDir = handle.worktreeGitdir;
    const shadowHead = resolve(adminDir, 'ok/HEAD');

    // Boot once so initShadowRepo lazy-creates the shadow under the admin dir.
    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir: handle.worktreePath,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    await booted.ready;
    expect(existsSync(shadowHead)).toBe(true);
    await booted.destroy();

    // git worktree remove tears down the worktree path AND the admin dir
    // (which contains the shadow). Note: `--force` covers the case where
    // git considers the worktree dirty (it will be — we just wrote a shadow).
    execFileSync('git', [
      '-C',
      handle.repoRoot,
      'worktree',
      'remove',
      '--force',
      handle.worktreePath,
    ]);

    expect(existsSync(handle.worktreePath)).toBe(false);
    expect(existsSync(adminDir)).toBe(false);
    expect(existsSync(shadowHead)).toBe(false);
  });
});

describe('MalformedGitPointerError at boot when .git pointer is stale (FR7)', () => {
  test('bootServer rejects with MalformedGitPointerError when .git points at a missing admin dir', async () => {
    // Build a project root by hand: .git is a file pointing at a path that
    // does not exist on disk. Mirrors the post-aborted-remove failure mode.
    const projectRoot = mkdtempSync(resolve(tmpdir(), 'ok-stale-pointer-'));
    adhocDirs.push(projectRoot);
    const missingTarget = resolve(tmpdir(), 'ok-stale-target-does-not-exist');
    writeFileSync(resolve(projectRoot, '.git'), `gitdir: ${missingTarget}\n`);
    // Pre-listen check needs config too — but the boot path resolves the
    // shadow dir before reaching the check site, so the pointer error is
    // what surfaces. Seed config so the test isolates the pointer contract.
    const okDir = resolve(projectRoot, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');

    let caught: unknown;
    try {
      await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir: projectRoot,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const e = caught as Error & { name?: string; resolvedTarget?: string };
    expect(e.name).toBe('MalformedGitPointerError');
    expect(e.resolvedTarget).toBe(missingTarget);
    expect(e.message).toContain(missingTarget);
    expect(e.message).toContain('git worktree prune');
  });

  test('healthy .git pointer (real worktree) does NOT throw — STOP_IF guard against an over-broad detector', async () => {
    handle = createLinkedWorktree({ seedOkScaffold: true });

    // If MalformedGitPointerError fires here, the detector is too aggressive.
    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir: handle.worktreePath,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    try {
      await booted.ready;
      expect(booted.port).toBeGreaterThan(0);
    } finally {
      await booted.destroy();
    }
  });

  test('recovery: stale pointer → remove orphan .git → retry boot succeeds', async () => {
    // Stage 1: synthesize a stale pointer + assert MalformedGitPointerError
    // fires. Same shape as the test above, but this time we follow the
    // recovery hint end-to-end rather than stopping at the error.
    const projectRoot = mkdtempSync(resolve(tmpdir(), 'ok-stale-recover-'));
    adhocDirs.push(projectRoot);
    const missingTarget = resolve(tmpdir(), 'ok-stale-recover-target-does-not-exist');
    writeFileSync(resolve(projectRoot, '.git'), `gitdir: ${missingTarget}\n`);
    const okDir = resolve(projectRoot, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');

    let firstAttemptError: unknown;
    try {
      await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir: projectRoot,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
    } catch (err) {
      firstAttemptError = err;
    }
    expect((firstAttemptError as Error).name).toBe('MalformedGitPointerError');

    // Stage 2: apply the recovery hint. The error message recommends `git
    // worktree prune`, but the orphan `.git` pointer file in projectRoot is
    // not under any source repo Git knows about (this directory was hand-
    // built), so prune from a sibling source repo would be a no-op. The
    // user-facing recovery is to remove the orphaned pointer file (or to
    // recreate the worktree). We exercise the simpler path here: remove the
    // pointer file and replace it with a fresh `.git` directory (simulating
    // a clean re-init of the same path).
    rmSync(resolve(projectRoot, '.git'), { force: true });
    mkdirSync(resolve(projectRoot, '.git'), { recursive: true });

    // Stage 3: retry boot. With the pointer fixed and config still in place,
    // boot resolves successfully.
    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir: projectRoot,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    try {
      await booted.ready;
      expect(booted.port).toBeGreaterThan(0);
      // Shadow now lives at the legacy main-worktree path because we replaced
      // the pointer with a real `.git/` directory.
      expect(existsSync(resolve(projectRoot, '.git/ok/HEAD'))).toBe(true);
    } finally {
      await booted.destroy();
    }
  });
});
