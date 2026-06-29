import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createEphemeralProjectDir, isProcessAlive } from '@inkeep/open-knowledge-server';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_MJS_PATH = resolve(HERE, '../../../cli/dist/cli.mjs');
const SHELL_DIST_PATH = resolve(HERE, '../../../cli/dist/public');

const LOCK_POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

interface ServerLockMetadata {
  pid: number;
  port: number;
  worktreeRoot: string;
}

function readLock(lockDir: string): ServerLockMetadata | null {
  const lockPath = join(lockDir, 'server.lock');
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as ServerLockMetadata;
    return typeof parsed.port === 'number' && parsed.port > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function waitForLock(lockDir: string): Promise<ServerLockMetadata> {
  const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lock = readLock(lockDir);
    if (lock) return lock;
    await wait(POLL_INTERVAL_MS);
  }
  throw new Error(`server.lock with a bound port did not appear at ${lockDir}`);
}

describe('ephemeral single-file lifecycle (real CLI)', () => {
  let userDir: string; // stands in for the user's real directory
  let notesDir: string; // the file's parent — the ephemeral contentDir
  let filePath: string; // the opened markdown file
  let tempProjectDir: string; // throwaway projectDir (where `.ok/` is allowed)
  let serverPid: number | null = null;

  beforeEach(async () => {
    userDir = await mkdtemp(resolve(tmpdir(), 'ok-ephemeral-it-'));
    notesDir = join(userDir, 'notes');
    mkdirSync(notesDir, { recursive: true });
    filePath = join(notesDir, 'todo.md');
    writeFileSync(filePath, '# Todo\n\n- one\n- two\n', 'utf-8');
    writeFileSync(join(notesDir, 'other.md'), '# Other\n', 'utf-8');
    writeFileSync(join(notesDir, 'pic.png'), 'not-a-real-png', 'utf-8');
    tempProjectDir = createEphemeralProjectDir(notesDir);
  });

  afterEach(async () => {
    if (serverPid !== null && isProcessAlive(serverPid)) {
      try {
        process.kill(serverPid, 'SIGKILL');
      } catch {}
      await wait(200);
    }
    serverPid = null;
    await rm(userDir, { recursive: true, force: true });
    await rm(tempProjectDir, { recursive: true, force: true });
  });

  test('boots with no user-dir artifacts (G4), reports singleFile, and tears down cleanly (G7)', async () => {
    if (!existsSync(CLI_MJS_PATH)) {
      throw new Error(`CLI dist not built at ${CLI_MJS_PATH}. Run 'bun run build' first.`);
    }

    const child = spawn(
      process.execPath,
      [
        CLI_MJS_PATH,
        'start',
        '--single-file',
        filePath,
        '--project-dir',
        tempProjectDir,
        '--port',
        '0',
        '--host',
        '127.0.0.1',
        '--serve-content-assets',
        '--react-shell-dist-dir',
        SHELL_DIST_PATH,
        '--no-color',
      ],
      {
        env: { ...process.env, OK_LOCK_KIND: 'interactive', NODE_ENV: 'test' },
        detached: true,
        stdio: 'ignore',
        cwd: tempProjectDir,
      },
    );
    child.unref();
    serverPid = child.pid ?? null;
    expect(serverPid).not.toBeNull();

    const lockDir = join(tempProjectDir, '.ok', 'local');
    const lock = await waitForLock(lockDir);

    expect(lock.worktreeRoot).toBe(tempProjectDir);
    expect(lock.pid).toBe(child.pid as number);

    expect(readdirSync(notesDir).sort()).toEqual(['other.md', 'pic.png', 'todo.md']);

    const res = await fetch(`http://127.0.0.1:${lock.port}/api/config`, {
      headers: { Accept: 'application/json', Host: `127.0.0.1:${lock.port}` },
    });
    expect(res.status).toBe(200);
    const config = (await res.json()) as { singleFile?: boolean };
    expect(config.singleFile).toBe(true);

    process.kill(lock.pid, 'SIGTERM');
    const releaseDeadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
    let released = false;
    let exited = false;
    while (Date.now() < releaseDeadline) {
      const current = readLock(lockDir);
      if (current === null || current.pid !== lock.pid) released = true;
      if (!isProcessAlive(lock.pid)) exited = true;
      if (released && exited) break;
      await wait(POLL_INTERVAL_MS);
    }
    expect(released).toBe(true);
    expect(exited).toBe(true);
    serverPid = null; // reaped — afterEach must not SIGKILL

    await rm(tempProjectDir, { recursive: true, force: true });
    expect(existsSync(tempProjectDir)).toBe(false);
    expect(readdirSync(notesDir).sort()).toEqual(['other.md', 'pic.png', 'todo.md']);
    expect(readFileSync(filePath, 'utf-8')).toBe('# Todo\n\n- one\n- two\n');
  }, 60_000);
});
