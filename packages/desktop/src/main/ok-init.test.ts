import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runOkInit } from './ok-init.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

describe('runOkInit', () => {
  let testRoot: string | null = null;
  afterEach(() => {
    if (testRoot !== null) rmSync(testRoot, { recursive: true, force: true });
    testRoot = null;
  });

  test('refuses an empty projectPath', async () => {
    const result = await runOkInit('');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('not-a-git-worktree');
    }
  });

  test('refuses a relative projectPath', async () => {
    const result = await runOkInit('relative/path');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('not-a-git-worktree');
      expect(result.message).toContain('absolute');
    }
  });

  test('reports not-a-git-worktree when path has no .git', async () => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-init-main-')));
    const result = await runOkInit(testRoot);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('not-a-git-worktree');
    }
  });

  test('reports not-a-git-worktree when path does not exist', async () => {
    const result = await runOkInit('/does/not/exist/anywhere');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('not-a-git-worktree');
      expect(result.message).toContain('not accessible');
    }
  });

  test('scaffolds .ok/ inside a main-checkout git directory', async () => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-init-main-')));
    await git(testRoot, 'init', '--initial-branch=main', '.');
    const result = await runOkInit(testRoot);
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.projectPath).toBe(testRoot);
    }
    expect(existsSync(join(testRoot, '.ok', 'config.yml'))).toBe(true);
    expect(existsSync(join(testRoot, '.ok', '.gitignore'))).toBe(true);
    expect(existsSync(join(testRoot, '.okignore'))).toBe(true);
  });

  test('scaffolds .ok/ inside a linked-worktree root', async () => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-init-main-')));
    const mainRepo = join(testRoot, 'main');
    mkdirSync(mainRepo);
    await git(mainRepo, 'init', '--initial-branch=main', '.');
    await git(mainRepo, 'config', 'user.email', 'test@example.com');
    await git(mainRepo, 'config', 'user.name', 'Test');
    writeFileSync(join(mainRepo, 'README.md'), '# main\n');
    await git(mainRepo, 'add', 'README.md');
    await git(mainRepo, 'commit', '-m', 'initial');
    const wt = join(testRoot, 'wt-feat');
    await git(mainRepo, 'worktree', 'add', '-b', 'feat', wt);
    const result = await runOkInit(wt);
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.projectPath).toBe(realpathSync(wt));
    }
    expect(existsSync(join(wt, '.ok', 'config.yml'))).toBe(true);
  });

  test('idempotent on already-initialized projects (no rewrite)', async () => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-init-main-')));
    await git(testRoot, 'init', '--initial-branch=main', '.');
    const first = await runOkInit(testRoot);
    expect(first.ok).toBe(true);
    const configPath = join(testRoot, '.ok', 'config.yml');
    const userMarker = '# user-customized\n';
    writeFileSync(configPath, userMarker);
    const second = await runOkInit(testRoot);
    expect(second.ok).toBe(true);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(configPath, 'utf-8')).toBe(userMarker);
  });

  test('coalesces concurrent calls on the same path', async () => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-init-main-')));
    await git(testRoot, 'init', '--initial-branch=main', '.');
    const [a, b, c] = await Promise.all([
      runOkInit(testRoot),
      runOkInit(testRoot),
      runOkInit(testRoot),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
    expect(existsSync(join(testRoot, '.ok', 'config.yml'))).toBe(true);
  });

  test('returns canonical realpath in result', async () => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-init-main-')));
    await git(testRoot, 'init', '--initial-branch=main', '.');
    const result = await runOkInit(testRoot);
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.projectPath).toBe(realpathSync(testRoot));
    }
  });
});
