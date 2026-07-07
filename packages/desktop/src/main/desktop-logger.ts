import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

const OK_LOGS_DIR = join(homedir(), '.ok', 'logs');
const MAX_AGE_DAYS = 7;
const MAX_DIR_SIZE_BYTES = 45 * 1024 * 1024; // 45 MB aggregate cap

const REDACT_PATHS = [
  'authorization',
  'password',
  'token',
  'apiKey',
  'secret',
  '*.authorization',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.secret',
];

function resolveLogLevel(): string {
  const envLevel = process.env.OK_LOG_LEVEL ?? process.env.LOG_LEVEL;
  if (envLevel) {
    const allowed = ['fatal', 'error', 'warn', 'info', 'debug'];
    const normalized = envLevel.toLowerCase();
    if (allowed.includes(normalized)) return normalized;
  }
  if (process.env.NODE_ENV === 'test') return 'silent';
  return 'info';
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function pruneLogsDir(dir: string): void {
  try {
    const now = Date.now();
    const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.log') || /\.log\.\d+$/.test(f))
      .map((f) => {
        try {
          const stat = statSync(join(dir, f));
          return { name: f, mtime: stat.mtimeMs, size: stat.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as { name: string; mtime: number; size: number }[];

    // Pass 1: delete files older than MAX_AGE_DAYS
    for (const f of files) {
      if (now - f.mtime > maxAge) {
        try {
          unlinkSync(join(dir, f.name));
        } catch {}
      }
    }

    // Pass 2: if total size still exceeds cap, delete oldest files first
    const remaining = files
      .filter((f) => now - f.mtime <= maxAge)
      .sort((a, b) => a.mtime - b.mtime);

    let totalSize = remaining.reduce((sum, f) => sum + f.size, 0);
    for (const f of remaining) {
      if (totalSize <= MAX_DIR_SIZE_BYTES) break;
      try {
        unlinkSync(join(dir, f.name));
        totalSize -= f.size;
      } catch {}
    }
  } catch {}
}

const _isLauncher = !process.argv.some(
  (a) => a.includes('--content-dir') || a.includes('contentDir'),
);
const loggerName = 'desktop';
const logFileName = `${loggerName}.${todayDateString()}.log`;

let rootLogger: pino.Logger | undefined;
// Module-scoped handle on the async destination so `flushDesktopLogger()` can
// force-drain its buffer before a hard exit. The destination is `sync: false`,
// so on a process kill (auto-update swap, app quit) any unwritten tail is lost.
let rootDest: { flushSync: () => void } | undefined;

function getRootLogger(): pino.Logger {
  if (rootLogger) return rootLogger;

  mkdirSync(OK_LOGS_DIR, { recursive: true });
  setTimeout(() => pruneLogsDir(OK_LOGS_DIR), 5000);

  const filePath = join(OK_LOGS_DIR, logFileName);
  const dest = pino.destination({ dest: filePath, append: true, sync: false });
  rootDest = dest as unknown as { flushSync: () => void };

  rootLogger = pino(
    {
      level: resolveLogLevel(),
      name: loggerName,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: { pid: process.pid, hostname: undefined, runtime: 'desktop' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
  );

  return rootLogger;
}

export interface DesktopLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
  debug(data: Record<string, unknown>, message: string): void;
}

const loggerCache = new Map<string, DesktopLogger>();

export function getLogger(subsystem: string): DesktopLogger {
  const cached = loggerCache.get(subsystem);
  if (cached) return cached;

  const dl: DesktopLogger = {
    info: (data, msg) => getRootLogger().info({ subsystem, ...data }, msg),
    warn: (data, msg) => getRootLogger().warn({ subsystem, ...data }, msg),
    error: (data, msg) => getRootLogger().error({ subsystem, ...data }, msg),
    debug: (data, msg) => getRootLogger().debug({ subsystem, ...data }, msg),
  };

  loggerCache.set(subsystem, dl);
  return dl;
}

export function getRootDesktopLogger(): pino.Logger {
  return getRootLogger();
}

/**
 * Force-drain the async log destination synchronously. Created with
 * `sync: false`, the destination buffers writes — so a process killed without
 * draining (an auto-update `quitAndInstall` → Squirrel SIGKILL, or any app
 * quit) loses its unwritten tail, which is precisely the window where the most
 * diagnostic lines are emitted. Shutdown-path callers invoke this so those
 * lines reach disk. Best-effort: never throws, so it can't derail a shutdown.
 */
export function flushDesktopLogger(): void {
  try {
    rootDest?.flushSync();
  } catch {
    // Not yet initialized, or the fd is already closing — a failed flush must
    // not block or crash the shutdown it's running on.
  }
}
