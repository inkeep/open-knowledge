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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';
import { APP_PACKAGE_ROOT } from './seed-key.ts';
import { removeAllStrictDuringTeardown } from './teardown-fs.ts';

export { APP_PACKAGE_ROOT };

export const VITE_E2E_SEED_DIR = join(APP_PACKAGE_ROOT, 'node_modules', '.vite-e2e-seed');

export function viteSeedIsReady(): boolean {
  return existsSync(join(VITE_E2E_SEED_DIR, 'deps', '_metadata.json'));
}

export function rollbackPreparedViteCacheDir(
  dir: string,
  remove: (target: string) => void = removeAllStrictDuringTeardown,
): string | undefined {
  try {
    remove(dir);
  } catch (err) {
    return `rolling back ${dir} after the vite seed copy failed did not complete: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (existsSync(dir)) {
    return `rolling back ${dir} after the vite seed copy failed left the directory on disk`;
  }
  return undefined;
}

export function prepareViteCacheDir(prefix: string): string {
  mkdirSync(join(APP_PACKAGE_ROOT, 'node_modules'), { recursive: true });
  const dir = mkdtempSync(join(APP_PACKAGE_ROOT, 'node_modules', `.vite-${prefix}-`));
  if (viteSeedIsReady()) {
    try {
      cpSync(VITE_E2E_SEED_DIR, dir, { recursive: true, force: true });
    } catch (err) {
      const rollbackFailure = rollbackPreparedViteCacheDir(dir);
      if (rollbackFailure !== undefined) console.warn(`[e2e teardown] ${rollbackFailure}`);
      throw err;
    }
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

export function requireBoundMs(bound: number, callSite: string): number {
  if (typeof bound === 'number' && Number.isFinite(bound) && bound > 0) return bound;
  throw new TypeError(
    `${callSite} needs its caller to name the millisecond bound it spends and received ${String(bound)}; an omitted bound reaches the timer as undefined, which Node clamps to 1ms and reports as a near-instant failure rather than as the missing argument it is`,
  );
}

export async function checkCollabSync(
  port: number,
  timeoutMs: number,
  loopbackHost: '127.0.0.1' | '::1' = '127.0.0.1',
): Promise<void> {
  requireBoundMs(timeoutMs, 'checkCollabSync');
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

export { getFreePort } from '../../free-port.test-helper.ts';

function describeExit(proc: ChildProcess): string {
  return proc.signalCode === null ? `with code ${proc.exitCode}` : `on ${proc.signalCode}`;
}

export async function waitForHttpReady(
  baseURL: string,
  timeoutMs: number,
  proc?: ChildProcess,
): Promise<void> {
  requireBoundMs(timeoutMs, 'waitForHttpReady');
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
    if (proc !== undefined && (proc.exitCode !== null || proc.signalCode !== null)) {
      throw new Error(
        `dev server command for ${baseURL} exited ${describeExit(proc)} after ${Date.now() - start}ms without becoming ready. Last error: ${String(lastErr)}`,
      );
    }
    await wait(250);
  }
  throw new Error(
    `dev server at ${baseURL} did not become ready within ${timeoutMs}ms. Last error: ${String(lastErr)}`,
  );
}

function tolerateDuringTeardown(err: unknown, attempt: string): false {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ESRCH') return false;
  if (code === 'EPERM') {
    console.warn(`[e2e teardown] ${attempt} reported EPERM; treating the group as already gone`);
    return false;
  }
  throw err;
}

export function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    return tolerateDuringTeardown(err, `kill(-${pid}, ${signal})`);
  }
}

export function signalTree(proc: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = proc.pid;
  if (pid === undefined) return false;
  if (killGroup(pid, signal)) return true;

  let emitted: Error | undefined;
  const capture = (err: Error) => {
    emitted = err;
  };
  proc.on('error', capture);
  let signalled: boolean;
  try {
    signalled = proc.kill(signal);
  } finally {
    proc.off('error', capture);
  }
  if (emitted !== undefined) return tolerateDuringTeardown(emitted, `child.kill(${signal})`);
  return signalled;
}

export async function killGracefully(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    if (proc.pid !== undefined) killGroup(proc.pid, 'SIGKILL');
    return;
  }
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  if (!signalTree(proc, 'SIGTERM')) return;
  await Promise.race([exited, wait(timeoutMs)]);
  if (proc.exitCode === null && proc.signalCode === null) {
    signalTree(proc, 'SIGKILL');
    await exited;
  } else if (proc.pid !== undefined) {
    killGroup(proc.pid, 'SIGKILL');
  }
}
