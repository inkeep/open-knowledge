import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SERVER_EXIT_LOG } from '@inkeep/open-knowledge-core';
import { getLocalDir, isProcessAlive } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { attachServerExitObserver } from '../../src/main/server-exit-observer.ts';
import {
  createServerExitRecorder,
  type ServerExitRecord,
} from '../../src/main/server-exit-record.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_MJS_PATH = resolve(HERE, '../../../cli/dist/cli.mjs');

const LOCK_POLL_TIMEOUT_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 50;

interface ServerLockMetadata {
  pid: number;
  hostname: string;
  port: number;
  startedAt: string;
  worktreeRoot: string;
  kind?: 'interactive' | 'mcp-spawned';
  capabilities?: string[];
}

async function waitForLock(lockDir: string): Promise<ServerLockMetadata> {
  const lockPath = join(lockDir, 'server.lock');
  const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(lockPath)) {
      try {
        const raw = readFileSync(lockPath, 'utf-8');
        const parsed = JSON.parse(raw) as ServerLockMetadata;
        if (typeof parsed.port === 'number' && parsed.port > 0) {
          return parsed;
        }
      } catch {}
    }
    await wait(LOCK_POLL_INTERVAL_MS);
  }
  throw new Error(`server.lock did not appear at ${lockPath} within ${LOCK_POLL_TIMEOUT_MS}ms`);
}

function getPgid(pid: number): number | null {
  const getpgid = (process as unknown as { getpgid?: (pid: number) => number }).getpgid;
  if (typeof getpgid !== 'function') return null;
  try {
    return getpgid(pid);
  } catch {
    return null;
  }
}

describe('detached-server lifecycle integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-detached-lifecycle-'));
    const okDir = resolve(tmpDir, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('spawn-detached CLI is in its own process group + survives parent exit', async () => {
    if (!existsSync(CLI_MJS_PATH)) {
      throw new Error(
        `CLI dist not built at ${CLI_MJS_PATH}. Run 'pnpm build' from packages/cli first.`,
      );
    }
    const lockDir = resolve(tmpDir, '.ok', 'local');

    const child = spawn(process.execPath, [CLI_MJS_PATH, 'start', '--port', '0'], {
      env: {
        ...process.env,
        OK_LOCK_KIND: 'interactive',
        NODE_ENV: 'test',
      },
      detached: true,
      stdio: 'ignore',
      cwd: tmpDir,
    });
    child.unref();

    let lock: ServerLockMetadata | null = null;
    try {
      lock = await waitForLock(lockDir);

      expect(lock.port).toBeGreaterThan(0);
      expect(lock.pid).toBe(child.pid as number);

      expect(isProcessAlive(lock.pid)).toBe(true);

      const pgid = getPgid(lock.pid);
      if (pgid !== null) {
        expect(pgid).toBe(lock.pid);
      }

      const myPgid = getPgid(process.pid);
      if (pgid !== null && myPgid !== null) {
        expect(pgid).not.toBe(myPgid);
      }
    } finally {
      if (lock !== null) {
        try {
          process.kill(lock.pid, 'SIGKILL');
        } catch {}
        await wait(200);
      }
    }
  }, 60_000);

  test('an unref-ed detached child still reports its exit code and signal', async () => {
    async function captureExit(
      args: string[],
    ): Promise<{ code: number | null; signal: string | null }> {
      const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
      await new Promise<void>((res, rej) => {
        child.once('spawn', res);
        child.once('error', rej);
      });

      let exitRecord: { code: number | null; signal: string | null } | null = null;
      child.on('exit', (code, signal) => {
        exitRecord = { code, signal };
      });
      child.unref();

      const deadline = Date.now() + 10_000;
      while (exitRecord === null && Date.now() < deadline) {
        await wait(25);
      }
      if (exitRecord === null) throw new Error('child exit was never observed');
      return exitRecord;
    }

    expect(await captureExit(['-e', 'process.exit(3)'])).toEqual({ code: 3, signal: null });
  }, 30_000);

  test('a signal-killed detached child reports the signal, not an exit code', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((res, rej) => {
      child.once('spawn', res);
      child.once('error', rej);
    });

    let exitRecord: { code: number | null; signal: string | null } | null = null;
    child.on('exit', (code, signal) => {
      exitRecord = { code, signal };
    });
    child.unref();

    process.kill(child.pid as number, 'SIGKILL');

    const deadline = Date.now() + 10_000;
    while (exitRecord === null && Date.now() < deadline) {
      await wait(25);
    }
    expect(exitRecord).toEqual({ code: null, signal: 'SIGKILL' });
  }, 30_000);

  async function recordDeathOf(
    script: string,
    killWith: NodeJS.Signals | null,
  ): Promise<{
    record: ServerExitRecord;
    infoLines: Array<Record<string, unknown>>;
    warnings: string[];
  }> {
    const lockDir = getLocalDir(tmpDir);
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    await new Promise<void>((res, rej) => {
      child.once('spawn', res);
      child.once('error', rej);
    });

    const warnings: string[] = [];
    const infoLines: Array<Record<string, unknown>> = [];
    const recorder = createServerExitRecorder({
      now: () => new Date(),
      logger: { warn: (_payload, msg) => warnings.push(msg) },
    });

    attachServerExitObserver(child, {
      lockDir,
      recordExit: (info) => {
        recorder.recordExit(info);
      },
      logger: { info: (payload) => infoLines.push(payload) },
    });
    child.unref();

    if (killWith !== null) process.kill(child.pid as number, killWith);

    const recordPath = join(lockDir, SERVER_EXIT_LOG);
    const deadline = Date.now() + 10_000;
    let lastParseError: unknown = null;
    while (Date.now() < deadline) {
      if (existsSync(recordPath)) {
        try {
          const record = JSON.parse(readFileSync(recordPath, 'utf-8')) as ServerExitRecord;
          return { record, infoLines, warnings };
        } catch (err) {
          lastParseError = err;
        }
      }
      await wait(25);
    }
    throw new Error(
      lastParseError === null
        ? `server exit record did not appear at ${recordPath}`
        : `server exit record at ${recordPath} never parsed: ${
            lastParseError instanceof Error ? lastParseError.message : String(lastParseError)
          }`,
    );
  }

  test('a SIGKILLed detached child leaves a record naming the signal', async () => {
    const { record, infoLines, warnings } = await recordDeathOf(
      'setTimeout(() => {}, 60000)',
      'SIGKILL',
    );

    expect(record.code).toBeNull();
    expect(record.signal).toBe('SIGKILL');
    expect(record.pid).toBeGreaterThan(0);
    expect(new Date(record.at).toISOString()).toBe(record.at);
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]).toMatchObject({
      event: 'server-exit.detached-child-exited',
      lockDir: getLocalDir(tmpDir),
      code: null,
      signal: 'SIGKILL',
    });
    expect(record.reason).toBeNull();
    expect(record.observer).toBe('detached-spawn');
    expect(warnings).toEqual([]);
  }, 30_000);

  test('a cleanly exiting detached child is distinguishable on disk', async () => {
    const { record } = await recordDeathOf('process.exit(0)', null);

    expect(record.code).toBe(0);
    expect(record.signal).toBeNull();
  }, 30_000);
});
