
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDiagnose } from './diagnose.ts';
import type { LockState } from './lock-state.ts';


function makeTmpDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'ok-diagnose-test-'));
}

function makeServerLock(pid: number, worktreeRoot: string, port = 5173): LockState {
  return {
    status: 'alive',
    lockPath: `${worktreeRoot}/.ok/local/server.lock`,
    lock: {
      pid,
      hostname: 'test-host',
      port,
      startedAt: '2026-05-06T10:00:00.000Z',
      worktreeRoot,
    },
  };
}

function makeBaseDeps(outDir: string) {
  return {
    discover: async () => [],
    inspect: (_: string, __: 'server' | 'ui'): LockState => ({ status: 'missing', lockPath: '' }),
    resolveCommand: (_: number) => '/usr/local/bin/node /tmp/cli.ts start',
    resolveUsage: (_: number) => ({ cpuPercent: 1.2, memPercent: 0.4 }),
    collectLsofFn: (_: number) => 'COMMAND  PID  USER  FD  TYPE  DEVICE  SIZE  NAME\n',
    getEndpoints: (_: number): unknown[] | null => null,
    profiler: async () => false,
    isAlive: (_: number) => true,
    sendSignal: (_: number, __: string) => {},
    sleep: async (_: number) => {},
    output: outDir,
    log: (_: string) => {},
  };
}

function makeFakeProfile(): string {
  return JSON.stringify({
    nodes: [
      {
        id: 1,
        hitCount: 0,
        callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 },
        children: [2],
      },
      {
        id: 2,
        hitCount: 5,
        callFrame: {
          functionName: 'readSyncMessage',
          url: 'file:///app.mjs',
          lineNumber: 172,
          columnNumber: 10,
        },
        children: [],
      },
    ],
    samples: [2, 2, 2, 2, 2],
    startTime: 0,
    endTime: 15000000,
  });
}


let tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});


describe('runDiagnose', () => {
  test('exits early when pid does not exist', async () => {
    const out = makeTmpDir();
    tmpDirs.push(out);
    const logs: string[] = [];

    await runDiagnose(
      { pid: 999999999, noInspector: true, output: out },
      {
        ...makeBaseDeps(out),
        isAlive: () => false,
        log: (m) => logs.push(m),
      },
    );

    expect(logs.some((l) => l.includes('No process'))).toBe(true);
    expect(existsSync(join(out, 'metadata.json'))).toBe(false);
  });

  test('writes metadata.json and lsof.txt with --no-inspector', async () => {
    const out = makeTmpDir();
    tmpDirs.push(out);

    await runDiagnose({ pid: process.pid, noInspector: true, output: out }, makeBaseDeps(out));

    const meta = JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf-8'));
    expect(meta.pid).toBe(process.pid);
    expect(meta.command).toContain('cli.ts');
    expect(meta.usage?.cpuPercent).toBe(1.2);
    expect(existsSync(join(out, 'lsof.txt'))).toBe(true);
    expect(existsSync(join(out, 'cpu.cpuprofile'))).toBe(false);
    expect(existsSync(join(out, 'inspector-endpoints.json'))).toBe(false);
  });

  test('lockInfo populated when pid matches a discovered lock', async () => {
    const out = makeTmpDir();
    tmpDirs.push(out);
    const pid = process.pid;
    const worktreeRoot = '/tmp/my-content';

    await runDiagnose(
      { pid, noInspector: true, output: out },
      {
        ...makeBaseDeps(out),
        discover: async () => [`${worktreeRoot}/.ok/local`],
        inspect: (_lockDir, name) =>
          name === 'server'
            ? makeServerLock(pid, worktreeRoot)
            : { status: 'missing', lockPath: '' },
      },
    );

    const meta = JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf-8'));
    expect(meta.lockInfo).not.toBeNull();
    expect(meta.lockInfo.lock.pid).toBe(pid);
    expect(meta.lockInfo.lock.worktreeRoot).toBe(worktreeRoot);
  });

  test('output dir defaults to contentDir/.ok/local/diagnostics when lock found', async () => {
    const contentDir = makeTmpDir();
    tmpDirs.push(contentDir);
    const pid = process.pid;
    const logs: string[] = [];

    await runDiagnose(
      { pid, noInspector: true }, // no --output
      {
        ...makeBaseDeps(contentDir),
        discover: async () => [`${contentDir}/.ok/local`],
        inspect: (_lockDir, name) =>
          name === 'server' ? makeServerLock(pid, contentDir) : { status: 'missing', lockPath: '' },
        log: (m) => logs.push(m),
      },
    );

    const outputLine = logs.find((l) => l.startsWith('Output:')) ?? '';
    expect(outputLine).toContain(join(contentDir, '.ok', 'local', 'diagnostics'));
  });

  test('writes inspector-endpoints.json, cpu.cpuprofile, and stacks.txt when endpoints available', async () => {
    const out = makeTmpDir();
    tmpDirs.push(out);
    const fakeProfile = makeFakeProfile();

    await runDiagnose(
      { pid: process.pid, output: out },
      {
        ...makeBaseDeps(out),
        getEndpoints: () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc' }],
        profiler: async (_wsUrl, _ms, _pid, outDir) => {
          writeFileSync(join(outDir, 'cpu.cpuprofile'), fakeProfile);
          return true;
        },
      },
    );

    expect(existsSync(join(out, 'inspector-endpoints.json'))).toBe(true);
    expect(existsSync(join(out, 'cpu.cpuprofile'))).toBe(true);
    expect(existsSync(join(out, 'stacks.txt'))).toBe(true);
    const stacks = readFileSync(join(out, 'stacks.txt'), 'utf-8');
    expect(stacks).toContain('readSyncMessage');
    expect(stacks).toContain('Top leaf nodes');
    expect(stacks).toContain('Top stacks');
  });

  test('sends SIGUSR1 when inspector not initially available', async () => {
    const out = makeTmpDir();
    tmpDirs.push(out);
    let signalSent = false;

    await runDiagnose(
      { pid: process.pid, output: out },
      {
        ...makeBaseDeps(out),
        getEndpoints: () => null,
        sendSignal: (_pid, signal) => {
          signalSent = signal === 'SIGUSR1';
        },
      },
    );

    expect(signalSent).toBe(true);
  });

  test('does not send SIGUSR1 when noInspector is true', async () => {
    const out = makeTmpDir();
    tmpDirs.push(out);
    let signalSent = false;

    await runDiagnose(
      { pid: process.pid, noInspector: true, output: out },
      {
        ...makeBaseDeps(out),
        sendSignal: () => {
          signalSent = true;
        },
      },
    );

    expect(signalSent).toBe(false);
  });

  test('process-stats.jsonl written when profiler emits stats', async () => {
    const out = makeTmpDir();
    tmpDirs.push(out);
    const pid = process.pid;
    const fakeProfile = makeFakeProfile();

    await runDiagnose(
      { pid, output: out },
      {
        ...makeBaseDeps(out),
        getEndpoints: () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc' }],
        profiler: async (_wsUrl, _ms, _pid, outDir, onStat) => {
          writeFileSync(join(outDir, 'cpu.cpuprofile'), fakeProfile);
          onStat({
            ts: '2026-05-06T10:00:00Z',
            pid,
            cpuPercent: 99.5,
            memPercent: 1.0,
            rssKb: 512000,
            vszKb: 1000000,
          });
          onStat({
            ts: '2026-05-06T10:00:01Z',
            pid,
            cpuPercent: 98.2,
            memPercent: 1.1,
            rssKb: 513000,
            vszKb: 1000000,
          });
          return true;
        },
      },
    );

    expect(existsSync(join(out, 'process-stats.jsonl'))).toBe(true);
    const lines = readFileSync(join(out, 'process-stats.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ cpuPercent: 99.5 });
  });

  test('SIGUSR1 retry succeeds: profiles when second endpoint call returns results', async () => {
    const out = makeTmpDir();
    tmpDirs.push(out);
    const fakeProfile = makeFakeProfile();
    let callCount = 0;

    await runDiagnose(
      { pid: process.pid, output: out },
      {
        ...makeBaseDeps(out),
        getEndpoints: () => {
          callCount++;
          if (callCount === 1) return null;
          return [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc' }];
        },
        sendSignal: () => {},
        sleep: async () => {},
        profiler: async (_wsUrl, _ms, _pid, outDir) => {
          writeFileSync(join(outDir, 'cpu.cpuprofile'), fakeProfile);
          return true;
        },
      },
    );

    expect(callCount).toBe(2);
    expect(existsSync(join(out, 'inspector-endpoints.json'))).toBe(true);
    expect(existsSync(join(out, 'cpu.cpuprofile'))).toBe(true);
    expect(existsSync(join(out, 'stacks.txt'))).toBe(true);
  });

  test('gracefully handles profiler failure — no crash, no profile artifacts', async () => {
    const out = makeTmpDir();
    tmpDirs.push(out);
    const logs: string[] = [];

    await runDiagnose(
      { pid: process.pid, output: out },
      {
        ...makeBaseDeps(out),
        getEndpoints: () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc' }],
        profiler: async () => false, // fails without writing a file
        log: (m) => logs.push(m),
      },
    );

    expect(existsSync(join(out, 'cpu.cpuprofile'))).toBe(false);
    expect(existsSync(join(out, 'stacks.txt'))).toBe(false);
    expect(logs.some((l) => l.includes('CPU profile capture failed'))).toBe(true);
  });

  test('privacy warning mentions all artifact types', async () => {
    const out = makeTmpDir();
    tmpDirs.push(out);
    const logs: string[] = [];

    await runDiagnose(
      { pid: process.pid, noInspector: true, output: out },
      {
        ...makeBaseDeps(out),
        log: (m) => logs.push(m),
      },
    );

    const allOutput = logs.join('\n');
    expect(allOutput).toContain('Before sharing');
    expect(allOutput).toContain('metadata.json');
    expect(allOutput).toContain('lsof.txt');
    expect(allOutput).toContain('cpu.cpuprofile');
    expect(allOutput).toContain('safe to share');
  });
});
