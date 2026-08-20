import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  acquireServerLock,
  markServerLockDraining,
  releaseServerLock,
  updateServerLockPort,
} from './server-lock.ts';
import { resolveUiRedirectPort } from './ui-redirect-port.ts';

describe('resolveUiRedirectPort — clone-redirect server.lock chain', () => {
  const dirs: string[] = [];

  function makeLockDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ok-ui-redirect-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ui-capable server.lock resolves to the server port (single-listener)', () => {
    const lockDir = makeLockDir();
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: lockDir,
      capabilities: ['http', 'ws', 'ui'],
    });
    updateServerLockPort(lockDir, 45001, 'http://127.0.0.1:45001');
    try {
      expect(resolveUiRedirectPort(lockDir)).toBe(45001);
    } finally {
      releaseServerLock(lockDir);
    }
  });

  test('explicit no-ui server.lock is a definitive no-ui', () => {
    const lockDir = makeLockDir();
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: lockDir,
      capabilities: ['http', 'ws'],
    });
    updateServerLockPort(lockDir, 45004, 'http://127.0.0.1:45004');
    try {
      expect(resolveUiRedirectPort(lockDir)).toBe('no-ui');
    } finally {
      releaseServerLock(lockDir);
    }
  });

  test('server.lock with NO capabilities field is treated as ui-capable (indeterminate → optimistic)', () => {
    const lockDir = makeLockDir();
    acquireServerLock(lockDir, { port: 0, worktreeRoot: lockDir });
    updateServerLockPort(lockDir, 45006, 'http://127.0.0.1:45006');
    try {
      expect(resolveUiRedirectPort(lockDir)).toBe(45006);
    } finally {
      releaseServerLock(lockDir);
    }
  });

  test('unbound (port 0) server.lock does not resolve and does not classify no-ui', () => {
    const lockDir = makeLockDir();
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: lockDir,
      capabilities: ['http', 'ws'],
    });
    try {
      expect(resolveUiRedirectPort(lockDir)).toBeNull();
    } finally {
      releaseServerLock(lockDir);
    }
  });

  test('no lock at all resolves to null', () => {
    expect(resolveUiRedirectPort(makeLockDir())).toBeNull();
  });

  test('a DRAINING no-ui server.lock resolves to null, not no-ui (spawn beats erroring on a dying holder)', () => {
    const lockDir = makeLockDir();
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: lockDir,
      capabilities: ['http', 'ws'],
    });
    updateServerLockPort(lockDir, 45007, 'http://127.0.0.1:45007');
    markServerLockDraining(lockDir);
    try {
      expect(resolveUiRedirectPort(lockDir)).toBeNull();
    } finally {
      releaseServerLock(lockDir);
    }
  });
});
