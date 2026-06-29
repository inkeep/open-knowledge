import type { ChildProcess } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_PACKAGE_ROOT = resolve(HELPERS_DIR, '..', '..', '..');

export const VITE_E2E_SEED_DIR = join(APP_PACKAGE_ROOT, 'node_modules', '.vite-e2e-seed');

export function viteSeedIsReady(): boolean {
  return existsSync(join(VITE_E2E_SEED_DIR, 'deps', '_metadata.json'));
}

export function prepareViteCacheDir(prefix: string): string {
  mkdirSync(join(APP_PACKAGE_ROOT, 'node_modules'), { recursive: true });
  const dir = mkdtempSync(join(APP_PACKAGE_ROOT, 'node_modules', `.vite-${prefix}-`));
  if (viteSeedIsReady()) {
    cpSync(VITE_E2E_SEED_DIR, dir, { recursive: true, force: true });
  }
  return dir;
}

export interface ServerLog {
  path: string;
  fd: number;
}

export function openServerLog(label: string): ServerLog {
  const path = join(
    tmpdir(),
    `ok-e2e-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`,
  );
  return { path, fd: openSync(path, 'w') };
}

export function closeServerLog(log: ServerLog): void {
  try {
    closeSync(log.fd);
  } catch {}
}

export function tailServerLog(log: ServerLog, lines = 40): string {
  try {
    const content = readFileSync(log.path, 'utf-8');
    return content.split('\n').slice(-lines).join('\n');
  } catch {
    return '(server log unreadable)';
  }
}

export async function checkCollabSync(
  port: number,
  timeoutMs = 10_000,
  loopbackHost: '127.0.0.1' | '::1' = '127.0.0.1',
): Promise<void> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://${loopbackHost === '::1' ? '[::1]' : '127.0.0.1'}:${port}/collab`,
    name: SYSTEM_DOC_NAME,
    document: doc,
    connect: false,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`/collab sync round-trip did not complete within ${timeoutMs}ms`));
      }, timeoutMs);
      provider.on('synced', () => {
        clearTimeout(timer);
        resolve();
      });
      provider.connect();
    });
  } finally {
    try {
      provider.destroy();
    } catch {}
    try {
      doc.destroy();
    } catch {}
  }
}

export async function getFreePort(
  loopbackHost: '127.0.0.1' | '::1' = '127.0.0.1',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, loopbackHost === '::1' ? '::1' : '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export async function waitForHttpReady(baseURL: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseURL}/`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 || res.status === 404) return;
      lastErr = new Error(`unexpected status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await wait(250);
  }
  throw new Error(
    `dev server at ${baseURL} did not become ready within ${timeoutMs}ms. Last error: ${String(lastErr)}`,
  );
}

export async function killGracefully(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  try {
    proc.kill('SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    return;
  }
  await Promise.race([exited, wait(timeoutMs)]);
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
    await exited;
  }
}
