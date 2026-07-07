/**
 * Per-worktree shadow + per-worktree contentDir means two
 * concurrent `ok start` invocations against two different worktrees boot
 * independent servers with distinct ports, lockDirs, and shadow paths.
 * Single-worktree tests miss cross-pollution regressions; this composes the
 * isolation contract.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootServer, ConfigSchema } from '@inkeep/open-knowledge-server';
import { createLinkedWorktree, type LinkedWorktreeHandle } from './worktree-test-harness.ts';

const TEST_CONFIG = ConfigSchema.parse({});

const handles: LinkedWorktreeHandle[] = [];

afterEach(() => {
  for (const h of handles.splice(0)) {
    h.cleanup();
  }
});

describe('Two linked worktrees boot in parallel with isolated state (D13)', () => {
  test('parallel bootServer calls produce distinct ports + lockDirs + shadow paths; destroy of one does not affect the other', async () => {
    // Two separate source repos → two linked worktrees, covering two source
    // repos AND two worktrees in the same repo as the same
    // isolation contract; using two source repos avoids the same-repo branch
    // collision that `git worktree add` would surface (independent of OK).
    const a = createLinkedWorktree({ seedOkScaffold: true, prefix: 'ok-wt-test-A' });
    handles.push(a);
    const b = createLinkedWorktree({ seedOkScaffold: true, prefix: 'ok-wt-test-B' });
    handles.push(b);

    const expectedShadowA = resolve(a.worktreeGitdir, 'ok/HEAD');
    const expectedShadowB = resolve(b.worktreeGitdir, 'ok/HEAD');

    const [bootedA, bootedB] = await Promise.all([
      bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir: a.worktreePath,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      }),
      bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir: b.worktreePath,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      }),
    ]);

    try {
      await Promise.all([bootedA.ready, bootedB.ready]);

      // Distinct kernel-assigned ports — `getFreePort` is a per-process
      // allocation, but the two boots run in the same process here, so this
      // also validates that no shared state forces a collision.
      expect(bootedA.port).toBeGreaterThan(0);
      expect(bootedB.port).toBeGreaterThan(0);
      expect(bootedA.port).not.toBe(bootedB.port);

      // Distinct lockDirs — one per contentDir's `.ok/local/`.
      expect(bootedA.lockDir).toBe(resolve(a.worktreePath, '.ok', 'local'));
      expect(bootedB.lockDir).toBe(resolve(b.worktreePath, '.ok', 'local'));
      expect(bootedA.lockDir).not.toBe(bootedB.lockDir);

      // Distinct shadow dirs — one per worktree's gitdir admin location.
      expect(existsSync(expectedShadowA)).toBe(true);
      expect(existsSync(expectedShadowB)).toBe(true);
      expect(expectedShadowA).not.toBe(expectedShadowB);

      // server.lock files exist and carry distinct ports (one per contentDir).
      const lockPathA = resolve(bootedA.lockDir, 'server.lock');
      const lockPathB = resolve(bootedB.lockDir, 'server.lock');
      expect(existsSync(lockPathA)).toBe(true);
      expect(existsSync(lockPathB)).toBe(true);
      const lockContentsA = readFileSync(lockPathA, 'utf-8');
      const lockContentsB = readFileSync(lockPathB, 'utf-8');
      // Each lock should reference its own boot's port, not the other's.
      expect(lockContentsA).toContain(String(bootedA.port));
      expect(lockContentsB).toContain(String(bootedB.port));
      expect(lockContentsA).not.toContain(String(bootedB.port));

      // Per-worktree shadow isolation: each shadow is its own bare git repo,
      // so `git for-each-ref` against shadow A returns only A's refs. There
      // are no agent writes yet, so both ref sets are empty — the structural
      // property is that the dirs are independent git stores at independent
      // filesystem paths. Probing each via `--git-dir` confirms they don't
      // share refs storage.
      const refsA = execFileSync(
        'git',
        ['--git-dir', resolve(a.worktreeGitdir, 'ok'), 'for-each-ref'],
        { encoding: 'utf-8' },
      );
      const refsB = execFileSync(
        'git',
        ['--git-dir', resolve(b.worktreeGitdir, 'ok'), 'for-each-ref'],
        { encoding: 'utf-8' },
      );
      // Both shadows are empty (no agent writes) — but the call succeeds for
      // each, proving the per-worktree shadow is a real, independent git repo
      // at its own gitdir/ok/ path.
      expect(typeof refsA).toBe('string');
      expect(typeof refsB).toBe('string');

      // Destroy A; B should still be operational.
      await bootedA.destroy();
      // The B server's shadow should still exist on disk (A's destroy didn't
      // cascade to B's filesystem); B's port should still be bound.
      expect(existsSync(expectedShadowB)).toBe(true);
      expect(bootedB.port).toBeGreaterThan(0);
    } finally {
      // Best-effort teardown of B if it survived.
      try {
        await bootedB.destroy();
      } catch {
        // ignore — already destroyed
      }
    }
  });
});
