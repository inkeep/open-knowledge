export const DEFAULT_SIGTERM_GRACE_MS = 10_000;

export const DEFAULT_SIGTERM_POLL_MS = 200;

export const SPAWN_ERROR_LOG = 'last-spawn-error.log';

export const SPAWN_ERROR_LOG_MAX_BYTES = 256 * 1024;

export const SPAWN_ATTEMPT_MARKER = '=== spawn attempt ';

export function spawnErrorLogOpenMode(currentSizeBytes: number | undefined): 'a' | 'w' {
  if (currentSizeBytes === undefined) return 'a';
  return currentSizeBytes >= SPAWN_ERROR_LOG_MAX_BYTES ? 'w' : 'a';
}

export function formatSpawnAttemptHeader(startedAt: Date, spawningPid: number): string {
  return `\n${SPAWN_ATTEMPT_MARKER}${startedAt.toISOString()} pid=${spawningPid} ===\n`;
}

export function sliceLastSpawnAttempt(raw: string): string {
  const lastHeader = raw.lastIndexOf(SPAWN_ATTEMPT_MARKER);
  if (lastHeader === -1) return raw;
  const endOfHeaderLine = raw.indexOf('\n', lastHeader);
  return endOfHeaderLine === -1 ? '' : raw.slice(endOfHeaderLine + 1);
}

export const SERVER_EXIT_LOG = 'last-server-exit.json';

export const SERVER_CRASH_LOG = 'last-server-crash.json';
