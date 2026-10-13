import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { APP_PACKAGE_ROOT } from '../stress/_helpers/seed-key.ts';

const OWNER = join(APP_PACKAGE_ROOT, 'tests', 'stress', '_helpers', 'worker-server-lifetime.cjs');
const FAILING_SEND = join(import.meta.dirname, 'worker-lifetime', 'failing-ipc-send.cjs');

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a worker server lifetime owner whose caller is gone', () => {
  test('a failed IPC send does not crash the owner, and the disconnect still runs its teardown', async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lifetime-ipc-')));
    scratchDirs.push(scratch);
    const contentDir = join(scratch, 'content');
    const viteCacheDir = join(scratch, 'vite-cache');
    const receiptDir = join(scratch, 'receipt');
    const serverLogPath = join(scratch, 'server.log');
    for (const dir of [contentDir, viteCacheDir, receiptDir]) mkdirSync(dir);
    writeFileSync(serverLogPath, '');
    const launch = {
      request: {
        host: '127.0.0.1',
        nonce: 'lifetime-ipc',
        receiptDir,
        receiptPath: join(receiptDir, 'receipt.json'),
        environment: {},
      },
      workerServerEnv: {},
      contentDir,
      viteCacheDir,
      serverLog: { path: serverLogPath, fd: 1 },
      serving: { kind: 'prebuilt' },
      command: null,
      reapMs: 1_000,
    };

    const owner = spawn(
      process.execPath,
      ['--require', FAILING_SEND, OWNER, JSON.stringify(launch)],
      { cwd: APP_PACKAGE_ROOT, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    const sendFailed = new Promise<void>((resolve) => {
      owner.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.includes('failing ipc send: launch-error')) resolve();
      });
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      owner.once('exit', (code, signal) => resolve({ code, signal })),
    );

    await sendFailed;
    if (owner.connected) owner.disconnect();

    expect(await exited, stderr).toEqual({ code: 0, signal: null });
    expect(
      [contentDir, viteCacheDir, receiptDir, serverLogPath].filter((path) => existsSync(path)),
    ).toEqual([]);
  });
});
