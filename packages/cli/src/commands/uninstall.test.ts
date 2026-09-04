import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { detectInstallMethods, resolveRecentDeinitProjects, runUninstall } from './uninstall.ts';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe('detectInstallMethods', () => {
  test('detects an app bundle, npm-global, and npx', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-detect-'));
    try {
      const userApp = join(home, 'Applications', 'OpenKnowledge.app');
      const npmStub = (args: string[]) =>
        args.includes('@inkeep/open-knowledge') ? '@inkeep/open-knowledge@1.2.3\n' : null;
      const methods = detectInstallMethods(
        home,
        '/Users/x/.npm/_npx/abcd/node_modules/.bin/ok',
        npmStub,
        (p) => p === userApp,
        { platform: 'darwin' },
      );
      const kinds = methods.map((m) => m.method);
      expect(kinds).toContain('app');
      expect(kinds).toContain('npm-global');
      expect(kinds).toContain('npx');
      expect(methods.find((m) => m.method === 'npm-global')?.instruction).toContain(
        'npm uninstall -g',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('detects the Windows NSIS install and points at Settings → Apps', () => {
    const localAppData = 'C:\\Users\\Jane\\AppData\\Local';
    const exe = join(
      localAppData,
      'Programs',
      '@inkeepopen-knowledge-desktop',
      'OpenKnowledge.exe',
    );
    const methods = detectInstallMethods(
      'C:\\Users\\Jane',
      undefined,
      () => null,
      (p) => p === exe,
      {
        platform: 'win32',
        env: { LOCALAPPDATA: localAppData },
      },
    );
    expect(methods.map((m) => m.method)).toEqual(['app']);
    expect(methods[0]?.instruction).toContain('Settings');
  });

  test('detects the Linux deb/rpm install and names both package managers', () => {
    const methods = detectInstallMethods(
      '/home/jane',
      undefined,
      () => null,
      (p) => p === '/opt/OpenKnowledge/openknowledge',
      { platform: 'linux' },
    );
    expect(methods.map((m) => m.method)).toEqual(['app']);
    expect(methods[0]?.instruction).toContain('apt remove openknowledge');
    expect(methods[0]?.instruction).toContain('dnf remove OpenKnowledge');
  });

  test('returns nothing when no install is detected', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-detect-'));
    try {
      expect(
        detectInstallMethods(
          home,
          '/usr/local/bin/ok',
          () => null,
          () => false,
        ),
      ).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('resolveRecentDeinitProjects', () => {
  function twoProjects(): { home: string; a: string; b: string } {
    const home = mkdtempSync(join(tmpdir(), 'ok-recent-'));
    const a = join(home, 'projA');
    const b = join(home, 'projB');
    write(join(a, '.ok', 'config.yml'), 'x\n');
    write(join(b, '.ok', 'config.yml'), 'x\n');
    return { home, a, b };
  }

  test('--yes alone selects NO projects (opt-in — global only)', async () => {
    const { home, a, b } = twoProjects();
    try {
      const selected = await resolveRecentDeinitProjects({
        home,
        platform: 'darwin',
        cwd: a,
        lockDirs: [],
        yes: true,
        readRecents: () => [{ path: b }],
        findRoot: () => ({ rootPath: a, distance: 0 }),
      });
      expect(selected).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--all-projects selects current + recents', async () => {
    const { home, a, b } = twoProjects();
    try {
      const selected = await resolveRecentDeinitProjects({
        home,
        platform: 'darwin',
        cwd: a,
        lockDirs: [],
        yes: true,
        allProjects: true,
        readRecents: () => [{ path: b }],
        findRoot: () => ({ rootPath: a, distance: 0 }),
      });
      expect(selected).toContain(a);
      expect(selected).toContain(b);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--dry-run selects nothing by default (opt-in preview)', async () => {
    const { home, a, b } = twoProjects();
    try {
      const selected = await resolveRecentDeinitProjects({
        home,
        platform: 'darwin',
        cwd: a,
        lockDirs: [],
        dryRun: true,
        readRecents: () => [{ path: b }],
        findRoot: () => ({ rootPath: a, distance: 0 }),
      });
      expect(selected).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('interactive: only the ticked projects are selected (default is none)', async () => {
    const { home, a, b } = twoProjects();
    try {
      const selected = await resolveRecentDeinitProjects({
        home,
        platform: 'darwin',
        cwd: a,
        lockDirs: [],
        isTTY: true,
        readRecents: () => [{ path: b }],
        findRoot: () => ({ rootPath: a, distance: 0 }),
        promptFn: async (candidates) => candidates.filter((c) => c.path === b).map((c) => c.path),
      });
      expect(selected).toEqual([b]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--all-projects skips recent entries whose dir no longer exists / is not an OK project', async () => {
    const { home, a } = twoProjects();
    try {
      const selected = await resolveRecentDeinitProjects({
        home,
        platform: 'darwin',
        cwd: a,
        lockDirs: [],
        allProjects: true,
        readRecents: () => [{ path: join(home, 'deleted-project') }],
        findRoot: () => ({ rootPath: a, distance: 0 }),
      });
      expect(selected).toEqual([a]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('runUninstall', () => {
  test('dry-run renders the plan + binary instructions, removing nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-cmd-'));
    try {
      write(join(home, '.ok', 'auth.yml'), 'x\n');
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        dryRun: true,
        deps: {
          discoverLockDirs: async () => [],
          detectInstallMethods: () => [
            { method: 'app', label: 'OK Desktop', instruction: 'Move to Trash' },
          ],
        },
      });
      expect(result.status).toBe('dry-run');
      expect(result.message).toContain('Would remove');
      expect(result.message).toContain('Move to Trash');
      expect(existsSync(join(home, '.ok'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('refuses to run non-interactively without --yes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-cmd-'));
    try {
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        isTTY: false,
        deps: { discoverLockDirs: async () => [] },
      });
      expect(result.status).toBe('cancelled');
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('empty prompt input aborts and removes nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-cmd-'));
    try {
      write(join(home, '.ok', 'auth.yml'), 'x\n');
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        isTTY: true,
        confirmStream: Readable.from(['\n']),
        deps: { discoverLockDirs: async () => [] },
      });
      expect(result.status).toBe('cancelled');
      expect(existsSync(join(home, '.ok'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reports failed + exit 1 when an op fails (e.g. a server won’t stop)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-cmd-'));
    try {
      write(join(home, '.ok', 'auth.yml'), 'x\n');
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        yes: true,
        deps: {
          discoverLockDirs: async () => ['/some/proj/.ok/local'],
          detectInstallMethods: () => [],
          runRemovalDeps: {
            clearToken: async () => ({ touched: [] }),
            clearEmbeddingsKey: async () => ({ touched: [] }),
            stopServer: () => ({ stopped: 0, failed: [{ pid: 99, error: 'EPERM' }] }),
          },
        },
      });
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--json without --yes is rejected (no interactive prompt possible)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-cmd-'));
    try {
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        json: true,
        deps: { discoverLockDirs: async () => [] },
      });
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--yes success path runs the removal and reports done (creds stubbed)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-cmd-'));
    try {
      write(join(home, '.ok', 'auth.yml'), 'x\n');
      write(join(home, '.agents', 'skills', 'open-knowledge-discovery', 'SKILL.md'), '# d\n');
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        yes: true,
        deps: {
          discoverLockDirs: async () => [],
          detectInstallMethods: () => [],
          runRemovalDeps: {
            clearToken: async () => ({ touched: ['file'] }),
            clearEmbeddingsKey: async () => ({ touched: [] }),
            stopServer: () => ({ stopped: 0, failed: [] }),
          },
        },
      });
      expect(result.status).toBe('done');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('Removed');
      expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(false);
      expect(existsSync(join(home, '.agents', 'skills', 'open-knowledge-discovery'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('runUninstall attached-client disclosure', () => {
  test('names attached clients in the plan without adding a gate', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-clients-'));
    try {
      write(join(home, '.ok', 'auth.yml'), 'x\n');
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        dryRun: true,
        deps: {
          discoverLockDirs: async () => ['/some/proj/.ok/local'],
          detectInstallMethods: () => [],
          probeClients: async () => 1,
        },
      });
      expect(result.status).toBe('dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('1 collaboration client');
      expect(result.message).toContain('restarting will NOT recover them');
      expect(result.message).not.toContain('--force');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--json --dry-run carries the probe result', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-clients-'));
    try {
      write(join(home, '.ok', 'auth.yml'), 'x\n');
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        dryRun: true,
        json: true,
        deps: {
          discoverLockDirs: async () => ['/some/proj/.ok/local'],
          detectInstallMethods: () => [],
          probeClients: async () => 1,
        },
      });
      const json = JSON.parse(result.message);
      expect(json.mode).toBe('dry-run');
      expect(json.attachedClients).toHaveLength(1);
      expect(json.attachedClients[0]).toContain('1 collaboration client');
      expect(json.attachedClients[0]).toContain('restarting will NOT recover them');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--json --dry-run reports an empty probe result when nothing is attached', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-clients-'));
    try {
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        dryRun: true,
        json: true,
        deps: {
          discoverLockDirs: async () => ['/some/proj/.ok/local'],
          detectInstallMethods: () => [],
          probeClients: async () => null,
        },
      });
      expect(JSON.parse(result.message).attachedClients).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('silent when nothing is attached', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-clients-'));
    try {
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        dryRun: true,
        deps: {
          discoverLockDirs: async () => ['/some/proj/.ok/local'],
          detectInstallMethods: () => [],
          probeClients: async () => null,
        },
      });
      expect(result.message).not.toContain('collaboration client');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
