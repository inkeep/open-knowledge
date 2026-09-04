import { resolve } from 'node:path';
import { LOCAL_DIR, OK_DIR } from '@inkeep/open-knowledge-core';
import { acquireServerLock, updateServerLockPort } from '../../server-lock.ts';

const TEST_UI_PORT = 5173;

export function bindTestUiServerLock(cwd: string, port = TEST_UI_PORT): string {
  bindTestServerLock(cwd, port, ['http', 'ws', 'ui']);
  return `http://localhost:${port}`;
}

export function bindTestServerLock(cwd: string, port = 4321, capabilities?: string[]): void {
  const lockDir = resolve(cwd, OK_DIR, LOCAL_DIR);
  acquireServerLock(lockDir, {
    port: 0,
    worktreeRoot: cwd,
    ...(capabilities !== undefined ? { capabilities } : {}),
  });
  updateServerLockPort(lockDir, port);
}
