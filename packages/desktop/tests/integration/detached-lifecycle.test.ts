import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from '@inkeep/open-knowledge-server';

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
        `CLI dist not built at ${CLI_MJS_PATH}. Run 'bun run build' from packages/cli first.`,
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
});
