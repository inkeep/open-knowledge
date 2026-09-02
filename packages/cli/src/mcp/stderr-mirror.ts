import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_AGE_DAYS = 7;
const MAX_TOTAL_BYTES = 45 * 1024 * 1024;
const MAX_CONSECUTIVE_FAILURES = 5;

const MIRROR_FILE_PATTERN = /^mcp\.\d{4}-\d{2}-\d{2}\.log$/;

function defaultMcpLogsDir(): string {
  return join(homedir(), '.ok', 'logs');
}

export function pruneMirrorLogs(logsDir: string, now: () => Date = () => new Date()): void {
  try {
    const nowMs = now().getTime();
    const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const files = readdirSync(logsDir)
      .filter((f) => MIRROR_FILE_PATTERN.test(f))
      .flatMap((f) => {
        try {
          const stat = statSync(join(logsDir, f));
          return [{ name: f, mtime: stat.mtimeMs, size: stat.size }];
        } catch {
          return [];
        }
      });

    const remaining: { name: string; mtime: number; size: number }[] = [];
    for (const f of files) {
      if (nowMs - f.mtime > maxAgeMs) {
        try {
          unlinkSync(join(logsDir, f.name));
        } catch {}
      } else {
        remaining.push(f);
      }
    }

    remaining.sort((a, b) => a.mtime - b.mtime);
    let totalSize = remaining.reduce((sum, f) => sum + f.size, 0);
    for (const f of remaining) {
      if (totalSize <= MAX_TOTAL_BYTES) break;
      try {
        unlinkSync(join(logsDir, f.name));
        totalSize -= f.size;
      } catch {}
    }
  } catch {}
}

export interface McpStderrMirror {
  write: (chunk: string) => void;
}

export interface CreateMcpStderrMirrorOpts {
  logsDir?: string;
  now?: () => Date;
  pruneDelayMs?: number;
}

export function createMcpStderrMirror(opts: CreateMcpStderrMirrorOpts = {}): McpStderrMirror {
  const logsDir = opts.logsDir ?? defaultMcpLogsDir();
  const now = opts.now ?? (() => new Date());
  const pruneDelayMs = opts.pruneDelayMs ?? 5000;

  if (pruneDelayMs <= 0) {
    pruneMirrorLogs(logsDir, now);
  } else {
    const timer = setTimeout(() => pruneMirrorLogs(logsDir, now), pruneDelayMs);
    timer.unref?.();
  }

  let consecutiveFailures = 0;
  let dirEnsured = false;
  return {
    write(chunk: string): void {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
      try {
        if (!dirEnsured) {
          mkdirSync(logsDir, { recursive: true });
          dirEnsured = true;
        }
        const timestamp = now().toISOString();
        const file = join(logsDir, `mcp.${timestamp.slice(0, 10)}.log`);
        appendFileSync(file, `${timestamp} ${chunk}`);
        consecutiveFailures = 0;
      } catch {
        dirEnsured = false;
        consecutiveFailures++;
      }
    },
  };
}
