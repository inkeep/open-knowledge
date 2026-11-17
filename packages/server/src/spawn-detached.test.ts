import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { excludeWorkingDirectoryFromProgramLookup } from '@inkeep/open-knowledge-core/util/windows-program-lookup';
import { describe, expect, onTestFinished, test } from 'vitest';
import { spawnDetached } from './spawn-detached.ts';

const NEVER_HIT = 5_000;

describe('spawnDetached — success path', () => {
  test('spawning the running Node binary resolves to { ok: true }', async () => {
    const outcome = await spawnDetached(process.execPath, ['--version'], NEVER_HIT);
    expect(outcome).toEqual({ ok: true });
  });

  test('arguments pass argv-style (shell: false) — metacharacters survive verbatim', async () => {
    const outcome = await spawnDetached(
      process.execPath,
      ['-e', 'process.exit(0) /* $(touch /tmp/pwned) && rm -rf /tmp/pwned */'],
      NEVER_HIT,
    );
    expect(outcome).toEqual({ ok: true });
  });
});

describe('spawnDetached — error classification', () => {
  test('ENOENT (binary not found) → { ok: false, reason: "not-installed" }', async () => {
    const outcome = await spawnDetached('/nonexistent/binary-that-does-not-exist', [], NEVER_HIT);
    expect(outcome).toEqual({ ok: false, reason: 'not-installed' });
  });

  test('EACCES (no exec permission on POSIX) → { ok: false, reason: "not-installed" }', async (ctx) => {
    ctx.skip(process.platform === 'win32', 'exec permission bits are POSIX-only');
    const dir = await mkdtemp(join(tmpdir(), 'ok-spawn-noexec-'));
    try {
      const script = join(dir, 'noexec.sh');
      await writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      const outcome = await spawnDetached(script, [], NEVER_HIT);
      expect(outcome).toEqual({ ok: false, reason: 'not-installed' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const SWITCH = 'NoDefaultCurrentDirectoryInExePath';

const REPORT = `const socket = require('node:net').connect(Number(process.argv[1]), '127.0.0.1', () => socket.end(JSON.stringify({ cwd: process.cwd(), value: process.env.${SWITCH} ?? null })));`;

async function launchedReport(): Promise<{ cwd: string; value: string | null }> {
  const server = createServer();
  onTestFinished(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  const report = new Promise<{ cwd: string; value: string | null }>((resolve) => {
    server.on('connection', (socket) => {
      let text = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        text += chunk;
      });
      socket.on('end', () => resolve(JSON.parse(text)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const outcome = await spawnDetached(process.execPath, ['-e', REPORT, String(port)], NEVER_HIT);
  expect(outcome).toEqual({ ok: true });
  return report;
}

function restoreSwitchAfterTest(): void {
  const before = process.env[SWITCH];
  onTestFinished(() => {
    if (before === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = before;
  });
}

function receivedThenStarted(received: string | undefined): void {
  delete process.env[SWITCH];
  if (received !== undefined) process.env[SWITCH] = received;
  excludeWorkingDirectoryFromProgramLookup(process.env, 'win32');
}

describe('spawnDetached — the app it starts belongs to the person', () => {
  test('starts the app outside the launching process working directory, in a system directory', async () => {
    const { cwd } = await launchedReport();
    expect(cwd).not.toBe(process.cwd());
    expect(cwd).toBe(
      process.platform === 'win32'
        ? win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
        : '/',
    );
  });

  test('passes the program lookup switch on as the launching process received it', async () => {
    restoreSwitchAfterTest();
    receivedThenStarted(undefined);
    expect((await launchedReport()).value).toBeNull();
    receivedThenStarted('1');
    expect((await launchedReport()).value).toBe('1');
  });
});
