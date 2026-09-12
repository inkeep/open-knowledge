import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isProcessAlive } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildDeinitPlan, buildUninstallPlan, runRemoval } from './removal-plan.ts';
import { runUninstall } from './uninstall.ts';

describe.skipIf(process.platform === 'win32')('uninstall lock recovery in an isolated home', () => {
  let root: string;
  const children: ChildProcess[] = [];
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-uninstall-recovery-')));
  });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  });
  function write(path: string, bytes: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  async function childServer(project: string) {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.title = 'open-knowledge-server fixture'; process.send('ready'); setInterval(() => {}, 1000)",
      ],
      { cwd: project, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    children.push(child);
    await once(child, 'message');
    if (child.pid === undefined) throw new Error('Fixture failed to start');
    return child;
  }
  test.each([false, true])(
    'cleans global state with mixed lock residue (deinit selected=%s)',
    async (deinit) => {
      const home = join(root, 'home');
      const settings = join(home, 'Library', 'Application Support', 'OpenKnowledge', 'state.json');
      const skill = join(home, '.ok', 'skills', 'mine', 'SKILL.md');
      write(settings, '{"recentProjects":[]}');
      write(join(home, '.ok', 'auth.yml'), 'fixture auth');
      write(skill, '# My skill');
      write(
        join(home, '.zshrc'),
        'export EDITOR=vim\n# >>> open-knowledge cli >>>\nmanaged\n# <<< open-knowledge cli <<<\n',
      );
      const kinds = ['valid', 'absent', 'stale', 'pid-only', 'malformed', 'zero', 'one'];
      const projects = kinds.map((kind) => join(root, kind));
      const locks: string[] = [];
      let livePid: number | undefined;
      for (const [index, project] of projects.entries()) {
        const kind = kinds[index];
        write(join(project, 'notes.md'), '# Keep my notes');
        write(join(project, '.ok', 'config.yml'), '{}');
        const lockDir = join(project, '.ok', 'local');
        mkdirSync(lockDir);
        locks.push(lockDir);
        if (kind === 'absent') continue;
        let raw = 'not json';
        if (kind === 'valid' || kind === 'stale' || kind === 'pid-only') {
          const child = await childServer(project);
          if (kind === 'stale' || kind === 'pid-only') {
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            await exited;
          } else livePid = child.pid;
          raw = JSON.stringify({
            pid: child.pid,
            ...(kind === 'pid-only' ? {} : { hostname: hostname() }),
            port: 0,
            startedAt: new Date().toISOString(),
          });
        } else if (kind === 'zero' || kind === 'one') {
          raw = JSON.stringify({
            pid: kind === 'zero' ? 0 : 1,
            hostname: hostname(),
          });
        }
        write(join(lockDir, 'server.lock'), raw);
      }
      const result = await runUninstall({
        home,
        cwd: root,
        platform: 'darwin',
        env: {},
        yes: true,
        json: true,
        deps: {
          discoverLockDirs: async () => locks,
          resolveRecentProjects: async () => (deinit ? projects : []),
          detectInstallMethods: () => [],
          runRemovalDeps: {
            clearToken: async () => ({ touched: [] }),
            clearEmbeddingsKey: async () => ({ touched: [] }),
          },
        },
      });
      expect(result.exitCode, result.message).toBe(0);
      const json = JSON.parse(result.message);
      expect(json.failed).toEqual([]);
      expect(
        json.skipped.filter((item: { kind: string }) => item.kind === 'stop-server'),
      ).toHaveLength(deinit ? 10 : 5);
      expect(
        json.removed.filter((item: { kind: string }) => item.kind === 'stop-server'),
      ).toHaveLength(deinit ? 2 : 1);
      expect(existsSync(settings)).toBe(false);
      expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(false);
      expect(readFileSync(skill, 'utf8')).toBe('# My skill');
      expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('export EDITOR=vim\n');
      if (livePid === undefined) throw new Error('Missing live fixture PID');
      expect(isProcessAlive(livePid)).toBe(false);
      for (const project of projects) {
        expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# Keep my notes');
        expect(existsSync(join(project, '.ok', 'config.yml'))).toBe(!deinit);
      }
      if (!deinit)
        expect(readFileSync(join(root, 'malformed', '.ok', 'local', 'server.lock'), 'utf8')).toBe(
          'not json',
        );
    },
  );

  test('shared deinit removes selected project state after harmless invalid residue', async () => {
    const project = join(root, 'project');
    write(join(project, '.ok', 'local', 'server.lock'), 'not json');
    write(join(project, 'notes.md'), '# Keep');
    const outcome = await runRemoval(buildDeinitPlan(project, join(root, 'home')));
    expect(outcome.failed).toEqual([]);
    expect(outcome.results[0]).toMatchObject({
      status: 'skipped',
      detail: expect.stringContaining('No server was stopped'),
    });
    expect(existsSync(join(project, '.ok'))).toBe(false);
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# Keep');
  });

  test.each(
    (
      [
        'global',
        'selected',
        'selected-reversed',
        'deinit',
        'global-legacy',
        'selected-legacy',
        'deinit-legacy',
      ] as const
    ).flatMap((scope) => [0, 99999999].map((pid) => ({ scope, pid }))),
  )('retains foreign project state while applying $scope with PID $pid', async ({ scope, pid }) => {
    const home = join(root, 'home');
    const settings = join(home, '.ok', 'config.yml');
    const project = join(root, 'foreign-project');
    const lockDir = scope.endsWith('legacy') ? join(project, '.ok') : join(project, '.ok', 'local');
    const lockPath = join(lockDir, 'server.lock');
    const raw = JSON.stringify({ pid, hostname: 'remote-host', port: 5173 });
    write(lockPath, raw);
    write(join(project, 'notes.md'), '# Keep');
    write(settings, '{}');
    const plan = scope.startsWith('deinit')
      ? buildDeinitPlan(project, home)
      : buildUninstallPlan({
          home,
          platform: 'darwin',
          env: {},
          host: 'github.com',
          lockDirs: [lockDir],
          marker: null,
          recentDeinitProjectRoots: scope.startsWith('global') ? [] : [project],
          purgeContent: false,
        });
    if (scope === 'selected-reversed') plan.ops.reverse();
    const outcome = await runRemoval(plan, {
      clearToken: async () => ({ touched: [] }),
      clearEmbeddingsKey: async () => ({ touched: [] }),
    });
    if (scope.startsWith('global')) {
      expect(outcome.failed).toEqual([]);
      expect(outcome.results[0]).toMatchObject({
        status: 'skipped',
        detail: expect.stringContaining('foreign-owned'),
      });
      expect(existsSync(settings)).toBe(false);
    } else {
      expect(outcome.failed.some((r) => r.detail?.includes('owning machine'))).toBe(true);
      expect(existsSync(settings)).toBe(true);
    }
    expect(readFileSync(lockPath, 'utf8')).toBe(raw);
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# Keep');
  });

  test.each([
    { associated: false, unrecorded: false },
    { associated: true, unrecorded: false },
    { associated: false, unrecorded: true },
    { associated: true, unrecorded: true },
  ])(
    'retains a live foreign or unverified lock (associated=$associated, unrecorded=$unrecorded)',
    async ({ associated, unrecorded }) => {
      const home = join(root, 'home');
      const settings = join(home, '.ok', 'config.yml');
      const project = join(root, 'foreign-project');
      const otherProject = join(root, 'other-project');
      write(join(project, 'notes.md'), '# Keep');
      mkdirSync(otherProject);
      write(settings, '{}');
      const child = await childServer(associated ? project : otherProject);
      const lockDir = join(project, '.ok', 'local');
      const raw = JSON.stringify({
        pid: child.pid,
        ...(unrecorded ? {} : { hostname: 'remote-host' }),
      });
      write(join(lockDir, 'server.lock'), raw);
      const plan = buildUninstallPlan({
        home,
        platform: 'darwin',
        env: {},
        host: 'github.com',
        lockDirs: [lockDir],
        marker: null,
        recentDeinitProjectRoots: [],
        purgeContent: false,
      });
      const outcome = await runRemoval(plan, {
        clearToken: async () => ({ touched: [] }),
        clearEmbeddingsKey: async () => ({ touched: [] }),
      });
      if (associated) {
        expect(outcome.failed.some((r) => r.detail?.includes('live process candidates'))).toBe(
          true,
        );
        expect(existsSync(settings)).toBe(true);
      } else {
        expect(outcome.failed).toEqual([]);
        expect(existsSync(settings)).toBe(false);
      }
      if (child.pid === undefined) throw new Error('Missing child PID');
      expect(isProcessAlive(child.pid)).toBe(true);
      expect(readFileSync(join(lockDir, 'server.lock'), 'utf8')).toBe(raw);
    },
  );
});
