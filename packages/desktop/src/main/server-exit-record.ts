import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_EXIT_LOG } from '@inkeep/open-knowledge-core';

const REASON_CORRELATION_WINDOW_MS = 3_000;

type ServerExitObserverHost = 'utility-process' | 'detached-spawn';

function assertNeverObserverHost(value: never): never {
  throw new Error(`Unhandled ServerExitObserverHost: ${JSON.stringify(value as unknown)}`);
}

function mayCorrelateGoneReason(observer: ServerExitObserverHost): boolean {
  switch (observer) {
    case 'utility-process':
      return true;
    case 'detached-spawn':
      return false;
    default:
      return assertNeverObserverHost(observer);
  }
}

export interface ServerExitRecord {
  at: string;
  pid: number | null;
  code: number | null;
  signal?: string | null;
  observer?: ServerExitObserverHost;
  reason: string | null;
}

type WrittenServerExitRecord = ServerExitRecord &
  Required<Pick<ServerExitRecord, 'signal' | 'observer'>>;

export interface ServerExitInfo {
  lockDir: string;
  pid: number | null;
  code: number | null;
  signal?: string | null;
  observer: ServerExitObserverHost;
}

interface ServerExitRecorderLogger {
  warn(payload: Record<string, unknown>, msg: string): void;
}

export interface ServerExitRecorderDeps {
  now(): Date;
  logger: ServerExitRecorderLogger;
}

export interface ServerExitRecorder {
  recordExit(info: ServerExitInfo): void;
  noteGoneReason(reason: string): void;
}

export function createServerExitRecorder(deps: ServerExitRecorderDeps): ServerExitRecorder {
  let lastExit: { lockDir: string; record: WrittenServerExitRecord; atMs: number } | null = null;
  let lastReason: { reason: string; atMs: number } | null = null;

  function write(lockDir: string, record: WrittenServerExitRecord): void {
    try {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, SERVER_EXIT_LOG), `${JSON.stringify(record, null, 2)}\n`);
    } catch (err) {
      try {
        deps.logger.warn(
          {
            event: 'server-exit-record.write-failed',
            err,
          },
          'could not record server exit',
        );
      } catch {}
    }
  }

  return {
    recordExit({ lockDir, pid, code, signal = null, observer }): void {
      const now = deps.now();
      const nowMs = now.getTime();
      const correlatable = mayCorrelateGoneReason(observer);
      const reason =
        correlatable &&
        lastReason !== null &&
        nowMs - lastReason.atMs <= REASON_CORRELATION_WINDOW_MS
          ? lastReason.reason
          : null;
      const record: WrittenServerExitRecord = {
        at: now.toISOString(),
        pid,
        code,
        signal,
        observer,
        reason,
      };
      write(lockDir, record);
      lastExit = correlatable ? { lockDir, record, atMs: nowMs } : null;
    },

    noteGoneReason(reason): void {
      const nowMs = deps.now().getTime();
      lastReason = { reason, atMs: nowMs };
      if (
        lastExit !== null &&
        lastExit.record.reason === null &&
        nowMs - lastExit.atMs <= REASON_CORRELATION_WINDOW_MS
      ) {
        const patched: WrittenServerExitRecord = { ...lastExit.record, reason };
        write(lastExit.lockDir, patched);
        lastExit = { ...lastExit, record: patched };
      }
    },
  };
}
