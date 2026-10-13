import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REUSE_RUN_ENV, REUSE_SOCKET_ENV } from './lease-protocol.ts';

function runDirectory(run: string): string {
  return join(tmpdir(), `ok-e2e-reuse-run-${run}`);
}

function runAbortRecord(run: string): string {
  return join(runDirectory(run), 'aborted');
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function recordRunAbort(run: string, reason: string): void {
  try {
    writeFileSync(runAbortRecord(run), reason, { flag: 'wx' });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
}

export function runAbortReason(run: string): string | undefined {
  try {
    return readFileSync(runAbortRecord(run), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export default function assignReuseRun(): (() => void) | undefined {
  if (process.env[REUSE_SOCKET_ENV] === undefined || process.env[REUSE_SOCKET_ENV] === '') {
    return undefined;
  }
  const run = randomUUID();
  const directory = runDirectory(run);
  mkdirSync(directory, { mode: 0o700 });
  process.env[REUSE_RUN_ENV] = run;
  return () => rmSync(directory, { recursive: true, force: true });
}
