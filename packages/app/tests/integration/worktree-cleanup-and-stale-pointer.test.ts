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
    const projectRoot = mkdtempSync(resolve(tmpdir(), 'ok-stale-pointer-'));
    adhocDirs.push(projectRoot);
    const missingTarget = resolve(tmpdir(), 'ok-stale-target-does-not-exist');
    writeFileSync(resolve(projectRoot, '.git'), `gitdir: ${missingTarget}\n`);
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

    rmSync(resolve(projectRoot, '.git'), { force: true });
    mkdirSync(resolve(projectRoot, '.git'), { recursive: true });

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
      expect(existsSync(resolve(projectRoot, '.git/ok/HEAD'))).toBe(true);
    } finally {
      await booted.destroy();
    }
  });
});
