import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runClean } from './clean.ts';
import { makeServerLockCheck } from './diagnose-health-checks/server-lock.ts';
import { inspectLock } from './lock-state.ts';
import { runPs } from './ps.ts';
import { buildStatusReport, renderStatusText } from './status.ts';
import { runStop } from './stop.ts';
import { stopServerForRemoval } from './stop-for-removal.ts';

let project: string;
let lockDir: string;
let lockPath: string;
const raw = JSON.stringify({ pid: 4242 });
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'ok-unverified-owner-owned-'));
  lockDir = join(project, '.ok', 'local');
  mkdirSync(lockDir, { recursive: true });
  lockPath = join(lockDir, 'server.lock');
  writeFileSync(lockPath, raw);
});
afterEach(() => rmSync(project, { recursive: true, force: true }));
const inspect = () => inspectLock(lockDir, 'server', { isAlive: () => true });

test('models a live PID-only lock without asserting absent metadata', () => {
  expect(inspect()).toEqual({ status: 'unverified-owner', lockPath, pid: 4242 });
});

test('clean refuses without suggesting deletion of a lock with a live PID', () => {
  const error = vi.fn();
  const unlink = vi.fn();
  const outcome = runClean({ lockDir, inspect, error, unlink, log: vi.fn() });
  expect(outcome.failed).toHaveLength(1);
  expect(unlink).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.stringContaining('process 4242'));
  expect(error).toHaveBeenCalledWith(expect.stringContaining('Do not remove the lock file'));
  expect(error.mock.calls.flat().join(' ')).not.toMatch(/stale lock|Only then remove/);
  expect(readFileSync(lockPath, 'utf8')).toBe(raw);
});

test('status identifies unverified ownership without inventing a host or server liveness', () => {
  const report = buildStatusReport(inspect());
  expect(report.server).toEqual({
    name: 'server',
    state: 'unverified-owner',
    pid: 4242,
    alive: 'unknown',
  });
  const text = renderStatusText(report);
  expect(text).toContain('unverified owner');
  expect(text).toContain('pid=4242');
  expect(text).not.toContain('undefined');
});

test('diagnose points to the live local PID and protects its lock', async () => {
  const result = await makeServerLockCheck({ inspect }).run({ cwd: project });
  expect(result.status).toBe('warn');
  expect(result.summary).toContain('unverified owner');
  expect(result.remediation).toContain('process 4242');
  expect(result.remediation).toContain('Do not remove the lock file');
  expect(JSON.stringify(result)).not.toContain('undefined');
});

test.each([
  { json: false, layout: 'current' },
  { json: true, layout: 'current' },
  { json: false, layout: 'legacy' },
  { json: true, layout: 'legacy' },
  { json: false, layout: 'custom' },
  { json: true, layout: 'custom' },
])(
  'ps reports the project directory for $layout locks with json=$json',
  async ({ json, layout }) => {
    if (layout !== 'current') {
      lockDir = join(project, layout === 'legacy' ? '.ok' : 'custom-state');
      mkdirSync(lockDir, { recursive: true });
      lockPath = join(lockDir, 'server.lock');
      writeFileSync(lockPath, raw);
    }
    const log = vi.fn();
    await runPs({
      discover: async () => [lockDir],
      inspect,
      resolveCommand: () => null,
      resolveUsage: () => null,
      log,
      json,
    });
    const output = log.mock.calls[0]?.[0];
    expect(output).toContain('unverified');
    expect(output).toContain('4242');
    expect(output).not.toContain('undefined');
    if (json)
      expect(JSON.parse(output)[0]).toMatchObject({
        directory: layout === 'custom' ? null : project,
        hostname: null,
        server: { port: null, startedAt: null },
      });
    else {
      expect(output).toContain('— / —');
      expect(output).not.toContain('null');
      expect(output).not.toContain(lockDir);
      if (layout !== 'custom') expect(output).toContain(project);
    }
  },
);

test('stop never signals an unverified owner even with force', async () => {
  const kill = vi.fn();
  const outcome = await runStop({
    lockDir,
    inspect,
    kill,
    force: true,
    isAlive: () => true,
    log: vi.fn(),
    error: vi.fn(),
  });
  expect(kill).not.toHaveBeenCalled();
  expect(outcome.stopped).toEqual([]);
});

test('global-only cleanup retains an unattributed live PID lock and reports its evidence', async () => {
  const outcome = await stopServerForRemoval(lockDir, {
    preserveProjectState: true,
    isAlive: () => true,
    scanProcesses: async () => ({ candidates: [], unavailable: [] }),
  });
  expect(outcome).toMatchObject({
    stopped: 0,
    failed: [],
    skipped: expect.stringContaining('unverified owner'),
  });
  expect(outcome.skipped).toContain('process 4242');
  expect(outcome.skipped).toContain('could not attribute');
  expect(readFileSync(lockPath, 'utf8')).toBe(raw);
});

test('global-only cleanup still refuses an associated live server candidate', async () => {
  await expect(
    stopServerForRemoval(lockDir, {
      preserveProjectState: true,
      isAlive: () => true,
      scanProcesses: async () => ({
        candidates: [{ lockDir: realpathSync(lockDir), pid: 4242, source: 'process-cwd' }],
        unavailable: [],
      }),
    }),
  ).rejects.toThrow('unverified');
  expect(readFileSync(lockPath, 'utf8')).toBe(raw);
});
