import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { normalize, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalize(root) + sep;
  const normalizedCandidate = normalize(candidate);
  return `${normalizedCandidate}${sep}`.startsWith(normalizedRoot);
}

export function sanitizeSegment(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

export function extractArchive(
  archivePath: string,
  destDir: string,
  isZip: boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const [cmd, args] = isZip
    ? process.platform === 'darwin'
      ? ['ditto', ['-x', '-k', archivePath, destDir]]
      : process.platform === 'win32'
        ? ['tar', ['-xf', archivePath, '-C', destDir]]
        : ['unzip', ['-q', archivePath, '-d', destDir]]
    : ['tar', ['-xf', archivePath, '-C', destDir]];
  return new Promise((resolvePromise, rejectPromise) => {
    const child: ChildProcess = spawn(cmd, args as string[], {
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`${cmd} timed out after ${timeoutMs}ms extracting ${archivePath}`));
    }, timeoutMs);
    timer.unref?.();
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${cmd} exited ${code}: ${stderr}`));
    });
  });
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  onRetry?: (
    r: DownloadProgress & { attempt: number; resumeFromBytes: number; error: Error },
  ) => void;
  fetchImpl?: typeof fetch;
  stallTimeoutMs?: number;
  maxAttemptsWithoutProgress?: number;
  retryDelayMs?: number;
}

const DEFAULT_STALL_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS_WITHOUT_PROGRESS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

class FatalDownloadError extends Error {}

interface ResumeValidator {
  header: 'etag' | 'last-modified';
  value: string;
}

interface Transfer {
  hash: Hash;
  receivedBytes: number;
  totalBytes: number | null;
  validator: ResumeValidator | null;
}

export async function downloadToFileWithSha(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const attemptLimit = opts.maxAttemptsWithoutProgress ?? DEFAULT_ATTEMPTS_WITHOUT_PROGRESS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const transfer: Transfer = {
    hash: createHash('sha256'),
    receivedBytes: 0,
    totalBytes: null,
    validator: null,
  };
  let attempt = 0;
  let attemptsWithoutProgress = 0;
  let furthestBytes = 0;
  let knownTotalBytes: number | null = null;
  for (;;) {
    attempt += 1;
    try {
      await downloadAttempt(url, destPath, transfer, opts);
      return transfer.hash.digest('hex');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      attemptsWithoutProgress =
        transfer.receivedBytes > furthestBytes ? 0 : attemptsWithoutProgress + 1;
      furthestBytes = Math.max(furthestBytes, transfer.receivedBytes);
      knownTotalBytes = transfer.totalBytes ?? knownTotalBytes;
      const progress = { receivedBytes: furthestBytes, totalBytes: knownTotalBytes };
      if (
        opts.signal?.aborted === true ||
        error instanceof FatalDownloadError ||
        attemptsWithoutProgress >= attemptLimit
      ) {
        throw new Error(`${describeError(error)} (${describeProgress(progress, attempt)})`, {
          cause: error,
        });
      }
      opts.onRetry?.({
        attempt,
        ...progress,
        resumeFromBytes: transfer.validator === null ? 0 : transfer.receivedBytes,
        error,
      });
      await sleep(retryDelayMs * 2 ** attemptsWithoutProgress, undefined, {
        signal: opts.signal,
      });
    }
  }
}

async function downloadAttempt(
  url: string,
  destPath: string,
  transfer: Transfer,
  opts: DownloadOptions,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const resumeFrom = transfer.receivedBytes;
  if (resumeFrom > 0 && resumeFrom === transfer.totalBytes) return;
  const validator = resumeFrom > 0 ? transfer.validator : null;
  const headers: Record<string, string> = { 'accept-encoding': 'identity' };
  if (validator !== null) {
    headers.range = `bytes=${resumeFrom}-`;
    headers['if-range'] = validator.value;
  }
  const stall = new AbortController();
  const signal =
    opts.signal === undefined ? stall.signal : AbortSignal.any([opts.signal, stall.signal]);
  const res = await withinStallWindow(fetchImpl(url, { signal, headers }), stallTimeoutMs, stall);
  if (res.status === 416 && validator !== null) {
    await res.body?.cancel().catch(() => {});
    if (transfer.totalBytes === null && unsatisfiedRangeTotal(res) === resumeFrom) return;
    resetTransfer(transfer, null, null);
    throw new Error(`download failed: server no longer has the requested byte range for ${url}`);
  }
  if (!res.ok || res.body === null) {
    await res.body?.cancel().catch(() => {});
    const message = `download failed: HTTP ${res.status} for ${url}`;
    throw RETRYABLE_HTTP_STATUSES.has(res.status)
      ? new Error(message)
      : new FatalDownloadError(message);
  }

  const range = res.status === 206 ? parseContentRange(res.headers.get('content-range')) : null;
  const encoded = isEncoded(res);
  const responseEtag = nonEmpty(res.headers.get('etag'));
  const resumed =
    range !== null &&
    validator !== null &&
    !encoded &&
    range.start === resumeFrom &&
    range.total !== null &&
    (transfer.totalBytes === null || range.total === transfer.totalBytes) &&
    (responseEtag === null || validator.header !== 'etag' || responseEtag === validator.value);
  if (res.status === 206 && !resumed) {
    await res.body.cancel().catch(() => {});
    resetTransfer(transfer, null, null);
    throw new Error(`download failed: server answered with an unexpected byte range for ${url}`);
  }
  if (resumed) {
    transfer.totalBytes = range.total;
  } else {
    resetTransfer(
      transfer,
      encoded ? null : declaredLength(res.headers.get('content-length')),
      encoded ? null : resumeValidator(responseEtag, nonEmpty(res.headers.get('last-modified'))),
    );
  }

  const sink = await open(destPath, resumed ? 'a' : 'w').catch(async (err: Error) => {
    await res.body?.cancel().catch(() => {});
    throw new FatalDownloadError(`could not write ${destPath}: ${err.message}`, { cause: err });
  });
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await withinStallWindow(reader.read(), stallTimeoutMs, stall);
      if (done) break;
      transfer.hash.update(value);
      transfer.receivedBytes += value.length;
      await sink.write(value).catch((err: Error) => {
        throw new FatalDownloadError(`could not write ${destPath}: ${err.message}`, {
          cause: err,
        });
      });
      opts.onProgress?.({
        receivedBytes: transfer.receivedBytes,
        totalBytes: transfer.totalBytes,
      });
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    await sink.close();
  }
  if (transfer.totalBytes !== null && transfer.receivedBytes < transfer.totalBytes) {
    throw new Error(`download ended early for ${url}`);
  }
}

async function withinStallWindow<T>(
  pending: Promise<T>,
  stallTimeoutMs: number,
  stall: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`download stalled: no data for ${stallTimeoutMs / 1000}s`);
      stall.abort(err);
      reject(err);
    }, stallTimeoutMs);
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function resetTransfer(
  transfer: Transfer,
  totalBytes: number | null,
  validator: ResumeValidator | null,
): void {
  transfer.hash = createHash('sha256');
  transfer.receivedBytes = 0;
  transfer.totalBytes = totalBytes;
  transfer.validator = validator;
}

function resumeValidator(etag: string | null, lastModified: string | null): ResumeValidator | null {
  if (etag !== null) return /^"[^"]*"$/.test(etag) ? { header: 'etag', value: etag } : null;
  return lastModified === null ? null : { header: 'last-modified', value: lastModified };
}

function isEncoded(res: Response): boolean {
  const encoding = res.headers.get('content-encoding')?.trim().toLowerCase() ?? '';
  return encoding !== '' && encoding !== 'identity';
}

function describeError(error: Error): string {
  const cause = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as NodeJS.ErrnoException).code;
  const detail = typeof code === 'string' ? code : cause.message;
  return error.message.includes(detail) ? error.message : `${error.message} (${detail})`;
}

function nonEmpty(header: string | null): string | null {
  return header === null || header === '' ? null : header;
}

function unsatisfiedRangeTotal(res: Response): number | null {
  const match = /^bytes \*\/(\d+)$/.exec(res.headers.get('content-range')?.trim() ?? '');
  return match === null ? null : Number(match[1]);
}

function declaredLength(header: string | null): number | null {
  if (header === null || header === '') return null;
  const n = Number(header);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function parseContentRange(header: string | null): { start: number; total: number | null } | null {
  const match = header === null ? null : /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(header.trim());
  if (match === null) return null;
  return { start: Number(match[1]), total: match[2] === '*' ? null : Number(match[2]) };
}

function describeProgress(progress: DownloadProgress, attempt: number): string {
  const total = progress.totalBytes === null ? 'an unknown size' : formatBytes(progress.totalBytes);
  const attempts = attempt === 1 ? '1 attempt' : `${attempt} attempts`;
  return `received ${formatBytes(progress.receivedBytes)} of ${total} after ${attempts}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function fetchText(
  url: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} for ${url}`);
  return res.text();
}

export function shaForFile(checksums: string, filename: string): string | null {
  for (const line of checksums.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match === null) continue;
    const [, sha, name] = match;
    const base = name.trim().split(/[\\/]/).pop();
    if (base === filename) return sha.toLowerCase();
  }
  return null;
}
