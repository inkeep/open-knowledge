import { lockAdvertisesUi, readServerLock } from './server-lock.ts';

export function resolveUiRedirectPort(lockDir: string): number | 'no-ui' | null {
  const server = readServerLock(lockDir);
  if (server === null || server.port <= 0 || server.draining === true) return null;
  return lockAdvertisesUi(server) ? server.port : 'no-ui';
}
