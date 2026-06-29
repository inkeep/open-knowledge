
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessLockMetadata } from '@inkeep/open-knowledge-server';
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
      inspect: (_lockDir, _name): LockState => ({ status: 'missing', lockPath: '' }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('no server holding the lock');
  });

  test('fails when a live server holds the lock', async () => {
    const cwd = makeProjectWithLockDir();
    const def = makeServerLockCheck({
      inspect: (_lockDir, _name): LockState => ({
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
      inspect: (_lockDir, _name): LockState => ({
        status: 'foreign-host',
        lockPath: '/x/server.lock',
        lock: makeLockMeta({ hostname: 'other-host' }),
      }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('other-host');
    expect(result.remediation).toContain('ok clean');
  });

  test('warns on dead-pid', async () => {
    const cwd = makeProjectWithLockDir();
    const def = makeServerLockCheck({
      inspect: (_lockDir, _name): LockState => ({
        status: 'dead-pid',
        lockPath: '/x/server.lock',
        lock: makeLockMeta({ pid: 999999 }),
      }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('999999');
    expect(result.remediation).toContain('ok clean');
  });

  test('warns on corrupt lockfile', async () => {
    const cwd = makeProjectWithLockDir();
    const def = makeServerLockCheck({
      inspect: (_lockDir, _name): LockState => ({
        status: 'corrupt',
        lockPath: '/x/server.lock',
      }),
    });
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('corrupt');
    expect(result.remediation).toContain('Delete');
  });
});
