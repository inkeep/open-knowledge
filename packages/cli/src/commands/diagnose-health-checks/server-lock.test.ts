import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessLockMetadata } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LockState } from '../lock-state.ts';
import { makeServerLockCheck } from './server-lock.ts';

let tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-health-lock-'));
  tmpDirs.push(dir);
  return dir;
}

function makeProjectWithLockDir(): string {
  const dir = makeProject();
  mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
  return dir;
}

function makeLockMeta(overrides: Partial<ProcessLockMetadata> = {}): ProcessLockMetadata {
  return {
    pid: 1234,
    hostname: 'this-host',
    port: 5173,
    startedAt: '2026-05-27T10:00:00.000Z',
    worktreeRoot: '/tmp/whatever',
    ...overrides,
  };
}

describe('server-lock check', () => {
  test('passes when no .ok/local directory exists', async () => {
    const cwd = makeProject();
    const def = makeServerLockCheck();
    const result = await def.run({ cwd });
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('no server lock');
  });

  test('passes when .ok/local exists but no server.lock', async () => {
    const cwd = makeProjectWithLockDir();
    const def = makeServerLockCheck({
      inspect: (): LockState => ({ status: 'missing', lockPath: '' }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('no server holding the lock');
  });

  test('fails when a live server holds the lock', async () => {
    const cwd = makeProjectWithLockDir();
    const def = makeServerLockCheck({
      inspect: (): LockState => ({
        status: 'alive',
        lockPath: '/x/server.lock',
        lock: makeLockMeta(),
      }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('pid 1234');
    expect(result.summary).toContain('on this host');
    expect(result.remediation).toContain('ok stop');
    expect(result.detail).toContain('port: 5173');
  });

  test('warns on foreign-host', async () => {
    const cwd = makeProjectWithLockDir();
    const def = makeServerLockCheck({
      inspect: (): LockState => ({
        status: 'foreign-host',
        lockPath: '/x/server.lock',
        lock: makeLockMeta({ hostname: 'other-host' }),
      }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('other-host');
    expect(result.remediation).toContain('owning machine');
  });

  test('a lock with another machine ID from this host is not called a foreign host and names the account and home folder remedies', async () => {
    const cwd = makeProjectWithLockDir();
    const def = makeServerLockCheck({
      inspect: (): LockState => ({
        status: 'foreign-host',
        lockPath: '/x/server.lock',
        lock: makeLockMeta({
          hostname: hostname(),
          machineId: '6f1c2d4e-0000-4000-8000-000000000000',
        }),
      }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).not.toContain('foreign host');
    expect(result.summary).toContain('records a machine ID different from the one in');
    expect(result.remediation).not.toMatch(/^Cannot verify shutdown/);
    expect(result.remediation).toContain(
      'If the server was started on this machine from another account, run `ok stop` as that account while it is running, or `ok clean` once it has exited.',
    );
    expect(result.remediation).toMatch(/with `(HOME|USERPROFILE)` set to that folder/);
  });

  test('warns on dead-pid', async () => {
    const cwd = makeProjectWithLockDir();
    const def = makeServerLockCheck({
      inspect: (): LockState => ({
        status: 'dead-pid',
        lockPath: '/x/server.lock',
        lock: makeLockMeta({ pid: 999999 }),
        text: '',
      }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('999999');
    expect(result.remediation).toContain('ok clean');
  });

  test('warns on a lock whose pid now belongs to another process', async () => {
    const cwd = makeProjectWithLockDir();
    const def = makeServerLockCheck({
      inspect: (): LockState => ({
        status: 'reused-pid',
        lockPath: '/x/server.lock',
        lock: makeLockMeta({ pid: 4242 }),
        text: '',
      }),
    });
    const result = await def.run({ cwd });
    expect(result).toEqual({
      name: 'server-lock',
      status: 'warn',
      summary: 'stale lock; recorded pid 4242 now belongs to another process',
      remediation: 'Run `ok clean` to prune.',
      detail: 'lockPath: /x/server.lock',
    });
  });

  test('warns on corrupt lockfile', async () => {
    const cwd = makeProjectWithLockDir();
    const def = makeServerLockCheck({
      inspect: (): LockState => ({
        status: 'corrupt',
        lockPath: '/x/server.lock',
        text: '{',
      }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('corrupt');
    expect(result.remediation).toContain('Delete');
  });
});

test('reports a read failure with access guidance rather than suggesting deletion', async () => {
  const cwd = makeProjectWithLockDir();
  const result = await makeServerLockCheck({
    inspect: () => ({ status: 'read-error', lockPath: '/x/server.lock', error: 'EACCES' }),
  }).run({ cwd });
  expect(result.status).toBe('fail');
  expect(result.remediation).toContain('Restore file and parent-directory access');
  expect(result.detail).toContain('EACCES');
});

describe('server-lock remediation names the running channel CLI', () => {
  afterEach(() => vi.unstubAllEnvs());

  test.each([
    ['stable', 'ok'],
    ['beta', 'ok-beta'],
  ])('%s: live and dead locks name %s stop and clean', async (channel, command) => {
    vi.stubEnv('OK_CHANNEL', channel);
    const remediationFor = async (state: LockState) =>
      (await makeServerLockCheck({ inspect: () => state }).run({ cwd: makeProjectWithLockDir() }))
        .remediation;
    expect(
      await remediationFor({ status: 'alive', lockPath: '/x/server.lock', lock: makeLockMeta() }),
    ).toBe(`Stop the other OpenKnowledge process or run \`${command} stop\`.`);
    expect(
      await remediationFor({
        status: 'dead-pid',
        lockPath: '/x/server.lock',
        lock: makeLockMeta({ pid: 999999 }),
        text: '',
      }),
    ).toBe(`Run \`${command} clean\` to prune.`);
    expect(
      await remediationFor({
        status: 'reused-pid',
        lockPath: '/x/server.lock',
        lock: makeLockMeta({ pid: 999999 }),
        text: '',
      }),
    ).toBe(`Run \`${command} clean\` to prune.`);
  });
});
