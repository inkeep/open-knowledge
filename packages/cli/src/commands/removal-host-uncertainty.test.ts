import { type ChildProcess, type SpawnSyncReturns, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
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
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { startDefunctProcess } from './defunct-process.test-helper.ts';

const spawnSyncMock = vi.fn();

let realSpawnSync: typeof import('node:child_process').spawnSync;
let buildDeinitPlan: typeof import('./removal-plan.ts').buildDeinitPlan;
let runRemoval: typeof import('./removal-plan.ts').runRemoval;
let isProcessAlive: typeof import('@inkeep/open-knowledge-server').isProcessAlive;
let stopServerForRemoval: typeof import('./stop-for-removal.ts').stopServerForRemoval;

beforeAll(async () => {
  const realCp = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  realSpawnSync = realCp.spawnSync;
  vi.doMock('node:child_process', () => ({ ...realCp, spawnSync: spawnSyncMock }));
  ({ buildDeinitPlan, runRemoval } = await import('./removal-plan.ts'));
  ({ isProcessAlive } = await import('@inkeep/open-knowledge-server'));
  ({ stopServerForRemoval } = await import('./stop-for-removal.ts'));
});

interface HostProcess {
  pid: number;
  command: string;
}

interface HostPlan {
  processes: HostProcess[];
  cwdQueries?: Array<{ pids: string; result: SpawnSyncReturns<string> }>;
}

function spawnResult(overrides: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  };
}

const LSOF_HEADER = 'COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\n';

describe.skipIf(process.platform === 'win32')(
  'removal under machine-global process-inspection uncertainty',
  () => {
    let root: string;
    let project: string;
    let home: string;
    let escapedSpawns: string[];
    const children: ChildProcess[] = [];

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-removal-host-')));
      project = join(root, 'project');
      home = join(root, 'home');
      escapedSpawns = [];
      write(join(project, '.ok', 'local', 'server.lock'), 'not json');
      write(join(project, 'notes.md'), '# Keep');
      spawnSyncMock.mockReset();
    });

    afterEach(async () => {
      for (const child of children.splice(0)) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      spawnSyncMock.mockReset();
      rmSync(root, { recursive: true, force: true });
      expect(escapedSpawns).toEqual([]);
    });

    function write(path: string, bytes: string): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }

    function installHost(plan: HostPlan): void {
      const scriptedCwds = new Map((plan.cwdQueries ?? []).map((q) => [q.pids, q.result]));
      spawnSyncMock.mockImplementation(
        (command: string, args: readonly string[] = [], options?: unknown) => {
          if (command === 'pgrep') {
            return spawnResult({ stdout: plan.processes.map((p) => `${p.pid}\n`).join('') });
          }
          if (command === 'ps' && args[0] === '-axo') {
            const rows = plan.processes.map((p) => `${p.pid} ${p.command}`);
            return spawnResult({ stdout: `  PID COMMAND\n${rows.join('\n')}\n` });
          }
          if (command === 'lsof' && args[0] === '-iTCP') {
            return spawnResult({ stdout: LSOF_HEADER });
          }
          if (command === 'lsof' && args[0] === '-p') {
            const scripted = scriptedCwds.get(String(args[1]));
            if (scripted !== undefined) return scripted;
            return realSpawnSync(command, args, options as never);
          }
          escapedSpawns.push(`${command} ${args.join(' ')}`);
          return realSpawnSync(command, args, options as never);
        },
      );
    }

    async function startLiveProcess(cwd: string): Promise<number> {
      mkdirSync(cwd, { recursive: true });
      const child = spawn(
        process.execPath,
        ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
        { cwd, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      children.push(child);
      await once(child, 'message');
      if (child.pid === undefined) throw new Error('Live fixture failed to start');
      return child.pid;
    }

    function detailOf(results: Array<{ detail?: string }>): string {
      return results.map((result) => result.detail ?? '').join('\n');
    }

    function installFailingPsProbe(): string {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      const shim = join(binDir, 'ps');
      writeFileSync(shim, '#!/bin/sh\necho "ps: process state unavailable" >&2\nexit 1\n');
      chmodSync(shim, 0o755);
      return binDir;
    }

    test('routes a caller-supplied probe reporter through the fallback process scan', async () => {
      const live = await startLiveProcess(project);
      const scanOnly = await startLiveProcess(join(root, 'other'));
      installHost({
        processes: [
          { pid: live, command: 'open-knowledge-server notes' },
          { pid: scanOnly, command: 'open-knowledge-server notes' },
        ],
        cwdQueries: [
          {
            pids: `${live},${scanOnly}`,
            result: spawnResult({ stdout: `p${live}\nn${project}\n` }),
          },
        ],
      });
      const binDir = installFailingPsProbe();
      const originalPath = process.env.PATH;
      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      const reportedToCaller: number[] = [];
      const stderrChunks: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });

      try {
        await expect(
          stopServerForRemoval(join(project, '.ok', 'local'), {
            probe: () => ({
              onProbeFailure: (failure) => {
                reportedToCaller.push(failure.pid);
              },
            }),
          }),
        ).rejects.toThrow(/Cannot verify shutdown/);
      } finally {
        stderrSpy.mockRestore();
        process.env.PATH = originalPath;
      }

      const cwdQuery = spawnSyncMock.mock.calls.find(
        ([command, args]: [string, readonly string[]]) => command === 'lsof' && args[0] === '-p',
      );
      expect(cwdQuery?.[1][1]).toBe(`${live},${scanOnly}`);
      expect(reportedToCaller).toContain(scanOnly);
      expect(reportedToCaller).toContain(live);
      expect(stderrChunks.filter((chunk) => chunk.includes('[process-scan]'))).toEqual([]);
    });

    test('removes project state when the only host uncertainty is a defunct process', async () => {
      const defunct = await startDefunctProcess(root, children);
      expect(defunct.state).toMatch(/^Z/);
      expect(isProcessAlive(defunct.pid)).toBe(true);
      installHost({ processes: [{ pid: defunct.pid, command: 'open-knowledge-server notes' }] });

      const outcome = await runRemoval(buildDeinitPlan(project, home));

      expect(detailOf(outcome.failed)).toBe('');
      expect(outcome.failed).toEqual([]);
      expect(outcome.results[0]).toMatchObject({
        status: 'skipped',
        detail: expect.stringContaining('No server was stopped'),
      });
      expect(existsSync(join(project, '.ok'))).toBe(false);
      expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# Keep');
    });

    test('removes project state when a lock-dir-marked process is defunct', async () => {
      const defunct = await startDefunctProcess(root, children);
      expect(defunct.state).toMatch(/^Z/);
      expect(isProcessAlive(defunct.pid)).toBe(true);
      const marker = Buffer.from(join(project, '.ok', 'local')).toString('base64url');
      installHost({
        processes: [
          { pid: defunct.pid, command: `open-knowledge-server --ok-lock-dir-b64=${marker}` },
        ],
      });

      const outcome = await runRemoval(buildDeinitPlan(project, home));

      expect(detailOf(outcome.failed)).toBe('');
      expect(outcome.failed).toEqual([]);
      expect(existsSync(join(project, '.ok'))).toBe(false);
      expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# Keep');
    });

    test('removes project state when a well-formed lock records a defunct process', async () => {
      const defunct = await startDefunctProcess(root, children);
      expect(defunct.state).toMatch(/^Z/);
      expect(isProcessAlive(defunct.pid)).toBe(true);
      write(
        join(project, '.ok', 'local', 'server.lock'),
        JSON.stringify({
          pid: defunct.pid,
          hostname: hostname(),
          port: 7391,
          startedAt: new Date().toISOString(),
          worktreeRoot: project,
        }),
      );
      installHost({ processes: [] });

      const outcome = await runRemoval(buildDeinitPlan(project, home));

      expect(detailOf(outcome.failed)).toBe('');
      expect(outcome.failed).toEqual([]);
      expect(existsSync(join(project, '.ok'))).toBe(false);
      expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# Keep');
    });

    test('refuses removal while a live server is attributable to this project', async () => {
      const server = await startLiveProcess(project);
      expect(isProcessAlive(server)).toBe(true);
      installHost({ processes: [{ pid: server, command: 'open-knowledge-server notes' }] });

      const outcome = await runRemoval(buildDeinitPlan(project, home));

      expect(detailOf(outcome.failed)).toContain('live process candidates');
      expect(detailOf(outcome.failed)).toContain(String(server));
      expect(existsSync(join(project, '.ok', 'local', 'server.lock'))).toBe(true);
      expect(readFileSync(join(project, '.ok', 'local', 'server.lock'), 'utf8')).toBe('not json');
      expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# Keep');
    });

    test('reports an unreadable process state once per run, not once per probing caller', async () => {
      const server = await startLiveProcess(project);
      installHost({ processes: [{ pid: server, command: 'open-knowledge-server notes' }] });
      const binDir = installFailingPsProbe();
      const diagnostics: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        diagnostics.push(String(chunk));
        return true;
      });

      const originalPath = process.env.PATH;
      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      let outcome: Awaited<ReturnType<typeof runRemoval>>;
      try {
        outcome = await runRemoval(buildDeinitPlan(project, home));
      } finally {
        process.env.PATH = originalPath;
        vi.restoreAllMocks();
      }

      expect(detailOf(outcome.failed)).toContain('live process candidates');
      expect(detailOf(outcome.failed)).toContain(String(server));
      const reports = diagnostics
        .join('')
        .split('\n')
        .filter((line) => line.includes(`could not read the state of process ${server}`));
      expect(reports).toHaveLength(1);
    });

    test('refuses removal while a live process keeps its working directory unreadable', async () => {
      const opaque = await startLiveProcess(join(root, 'opaque-project'));
      expect(isProcessAlive(opaque)).toBe(true);
      installHost({
        processes: [{ pid: opaque, command: 'open-knowledge-server notes' }],
        cwdQueries: [{ pids: String(opaque), result: spawnResult({ stdout: '' }) }],
      });

      const outcome = await runRemoval(buildDeinitPlan(project, home));

      expect(detailOf(outcome.failed)).toContain(String(opaque));
      expect(existsSync(join(project, '.ok', 'local', 'server.lock'))).toBe(true);
      expect(readFileSync(join(project, '.ok', 'local', 'server.lock'), 'utf8')).toBe('not json');
    });
  },
);
