/**
 * `ok init` parity in linked git worktrees.
 *
 * After worktree-aware path resolution, `ok init` (the `initContent`
 * function the CLI calls) needs no worktree-specific behavior. These tests
 * are the assertion that the design works: P3 (first-time evaluator) gets a
 * fresh scaffold; P1 (returning developer with committed `.ok/`) sees a
 * no-op for `config.yml`. After init, the same worktree must boot cleanly.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootServer, ConfigSchema, initContent } from '@inkeep/open-knowledge-server';
import { createLinkedWorktree, type LinkedWorktreeHandle } from './worktree-test-harness.ts';

const TEST_CONFIG = ConfigSchema.parse({});

let handle: LinkedWorktreeHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('initContent in a linked worktree (FR4 / D7)', () => {
  test('fresh worktree (P3): scaffolds .ok/ on first invocation', () => {
    handle = createLinkedWorktree({ seedOkScaffold: false });
    expect(existsSync(resolve(handle.worktreePath, '.ok'))).toBe(false);

    const result = initContent(handle.worktreePath);

    expect(existsSync(resolve(handle.worktreePath, '.ok/config.yml'))).toBe(true);
    expect(existsSync(resolve(handle.worktreePath, '.ok/.gitignore'))).toBe(true);
    expect(result.created).toContain('config.yml');
    expect(result.created).toContain('.gitignore');
  });

  test('committed config.yml (P1): writeIfMissing skip leaves bytes unchanged on second init', () => {
    handle = createLinkedWorktree({ seedOkScaffold: false });
    // Simulate what `git checkout` would have materialized: a custom
    // committed config.yml + .gitignore. The user's bytes must survive.
    const okDir = resolve(handle.worktreePath, '.ok');
    const customConfig = '# user-customized\nlogLevel: debug\n';
    const customGitignore = '# user-customized\nprincipal.json\n';
    // Mirror git checkout's behavior — directory + files materialized by it.
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), customConfig, 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), customGitignore, 'utf-8');

    const result = initContent(handle.worktreePath);

    // config.yml is left exactly as committed.
    expect(readFileSync(resolve(okDir, 'config.yml'), 'utf-8')).toBe(customConfig);
    expect(result.skipped).toContain('config.yml');
    // .gitignore: merged-on-upgrade is acceptable (existing entries preserved).
    const gitignoreAfter = readFileSync(resolve(okDir, '.gitignore'), 'utf-8');
    expect(gitignoreAfter).toContain('# user-customized');
    expect(gitignoreAfter).toContain('principal.json');
  });

  test('init then boot: same worktree, end-to-end pipeline succeeds', async () => {
    handle = createLinkedWorktree({ seedOkScaffold: false });
    initContent(handle.worktreePath);

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
      // Shadow lives under the worktree's gitdir, NOT inside the worktree.
      const expectedShadowHead = resolve(handle.worktreeGitdir, 'ok/HEAD');
      expect(existsSync(expectedShadowHead)).toBe(true);
    } finally {
      await booted.destroy();
    }
  });
});
