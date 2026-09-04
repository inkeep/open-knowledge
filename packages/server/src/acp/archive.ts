import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { normalize, sep } from 'node:path';
import { Readable } from 'node:stream';

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
  fetchImpl?: typeof fetch;
}

export async function downloadToFileWithSha(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { signal: opts.signal });
  if (!res.ok || res.body === null) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  const lenHeader = res.headers.get('content-length');
  const totalBytes = lenHeader !== null && lenHeader !== '' ? Number(lenHeader) : null;
  const hash = createHash('sha256');
  let receivedBytes = 0;
  const sink = createWriteStream(destPath);
  const source = Readable.fromWeb(
    res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
  );
  source.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    receivedBytes += chunk.length;
    opts.onProgress?.({
      receivedBytes,
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    source
      .pipe(sink)
      .on('finish', () => resolvePromise())
      .on('error', rejectPromise);
    source.on('error', rejectPromise);
  });
  return hash.digest('hex');
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
