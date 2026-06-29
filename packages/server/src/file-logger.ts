import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LoggerOptions, Logger as PinoLoggerInstance } from 'pino';
import pino from 'pino';

const OK_LOGS_DIR = join(homedir(), '.ok', 'logs');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per file before rotation
const MAX_ROTATED_FILES = 2; // keep 2 archives + 1 active = 3 files ≈ 15 MB per logger
const MAX_AGE_DAYS = 7;
const MAX_DIR_SIZE_BYTES = 45 * 1024 * 1024; // 45 MB aggregate cap (NFR2)

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

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = statSync(filePath);
    if (stat.size < MAX_FILE_SIZE) return;
  } catch {
    return;
  }

  for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const dst = `${filePath}.${i}`;
    try {
      renameSync(src, dst);
    } catch {}
  }

  try {
    unlinkSync(`${filePath}.${MAX_ROTATED_FILES + 1}`);
  } catch {}
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

    for (const f of files) {
      if (now - f.mtime > maxAge) {
        try {
          unlinkSync(join(dir, f.name));
        } catch {}
      }
    }

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

export interface FileLoggerOptions {
  name: string;
  filePath?: string;
  project?: string;
  additionalOptions?: Partial<LoggerOptions>;
  _setTimeout?: typeof setTimeout;
}

export function createFileLogger(opts: FileLoggerOptions): PinoLoggerInstance {
  ensureDir(OK_LOGS_DIR);

  const date = todayDateString();
  const filePath = opts.filePath ?? join(OK_LOGS_DIR, `${opts.name}.${date}.log`);

  rotateIfNeeded(filePath);
  const scheduleTimer = opts._setTimeout ?? setTimeout;
  scheduleTimer(() => pruneLogsDir(OK_LOGS_DIR), 5000).unref();

  const dest = pino.destination({ dest: filePath, append: true, sync: true });

  const level = resolveLogLevel();

  const logger = pino(
    {
      level,
      name: opts.name,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: {
        pid: process.pid,
        hostname: undefined,
        runtime: 'cli',
        project: opts.project ?? '<no-project>',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      ...opts.additionalOptions,
    },
    dest,
  );

  return logger;
}

interface FlushableStream {
  fd?: number;
  flushSync?: () => void;
  once?: (event: string, cb: () => void) => void;
}

export function flushFileLogger(
  logger: PinoLoggerInstance | undefined,
  timeoutMs = 250,
): Promise<void> {
  return new Promise((resolve) => {
    if (!logger) {
      resolve();
      return;
    }
    const stream = (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] as
      | FlushableStream
      | undefined;
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (!stream || typeof stream.flushSync !== 'function') {
      done();
      return;
    }
    const flushAndDone = (): void => {
      try {
        stream.flushSync?.();
      } catch {
      }
      done();
    };
    const timer = setTimeout(done, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    if (typeof stream.fd === 'number' && stream.fd >= 0) {
      clearTimeout(timer);
      flushAndDone();
    } else if (typeof stream.once === 'function') {
      stream.once('ready', () => {
        clearTimeout(timer);
        flushAndDone();
      });
    } else {
      clearTimeout(timer);
      flushAndDone();
    }
  });
}

export function getLogFilePath(name: string): string {
  return join(OK_LOGS_DIR, `${name}.${todayDateString()}.log`);
}

export function getLogsDir(): string {
  return OK_LOGS_DIR;
}

export { MAX_FILE_SIZE };
