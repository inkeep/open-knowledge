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

      expect(bootedA.port).toBeGreaterThan(0);
      expect(bootedB.port).toBeGreaterThan(0);
      expect(bootedA.port).not.toBe(bootedB.port);

      expect(bootedA.lockDir).toBe(resolve(a.worktreePath, '.ok', 'local'));
      expect(bootedB.lockDir).toBe(resolve(b.worktreePath, '.ok', 'local'));
      expect(bootedA.lockDir).not.toBe(bootedB.lockDir);

      expect(existsSync(expectedShadowA)).toBe(true);
      expect(existsSync(expectedShadowB)).toBe(true);
      expect(expectedShadowA).not.toBe(expectedShadowB);

      const lockPathA = resolve(bootedA.lockDir, 'server.lock');
      const lockPathB = resolve(bootedB.lockDir, 'server.lock');
      expect(existsSync(lockPathA)).toBe(true);
      expect(existsSync(lockPathB)).toBe(true);
      const lockContentsA = readFileSync(lockPathA, 'utf-8');
      const lockContentsB = readFileSync(lockPathB, 'utf-8');
      expect(lockContentsA).toContain(String(bootedA.port));
      expect(lockContentsB).toContain(String(bootedB.port));
      expect(lockContentsA).not.toContain(String(bootedB.port));

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
      expect(typeof refsA).toBe('string');
      expect(typeof refsB).toBe('string');

      await bootedA.destroy();
      expect(existsSync(expectedShadowB)).toBe(true);
      expect(bootedB.port).toBeGreaterThan(0);
    } finally {
      try {
        await bootedB.destroy();
      } catch {}
    }
  });
});
