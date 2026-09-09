import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { withPiTrustLock, withPiTrustLockSync } from './pi-trust-lock.ts';

const CHILD_WRITER = `
  import { readFileSync, writeFileSync } from 'node:fs';
  const [helperUrl, mode, configured, canonical] = process.argv.slice(1);
  const { withPiTrustLock, withPiTrustLockSync } = await import(helperUrl);
  const write = () => {
    process.send('entered');
    const state = JSON.parse(readFileSync(canonical, 'utf8'));
    if (mode === 'async') state.openknowledge = true;
    else delete state.openknowledge;
    writeFileSync(canonical, JSON.stringify(state));
  };
  process.send('ready');
  try {
    if (mode === 'async') await withPiTrustLock(configured, canonical, write);
    else withPiTrustLockSync(configured, canonical, write);
    process.disconnect();
  } catch (error) {
    process.stderr.write(String(error));
    process.exitCode = 1;
    process.disconnect();
  }
`;

describe.each(['async', 'sync'] as const)('Pi trust lock (%s)', (mode) => {
  let root: string;
  let configured: string;
  let canonical: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ok-pi-trust-lock-'));
    configured = join(root, 'configured', 'trust.json');
    canonical = join(root, 'canonical', 'trust.json');
    mkdirSync(dirname(configured));
    mkdirSync(dirname(canonical));
    writeFileSync(canonical, '{}');
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function runLock(fn: () => void): Promise<void> {
    if (mode === 'async') await withPiTrustLock(configured, canonical, fn);
    else withPiTrustLockSync(configured, canonical, fn);
  }

  test('coordinates with a separate Pi writer and preserves its update', async () => {
    const original =
      mode === 'sync' ? { existing: false, openknowledge: true } : { existing: false };
    writeFileSync(canonical, JSON.stringify(original));
    const releasePi = lockfile.lockSync(dirname(configured), {
      realpath: false,
      lockfilePath: `${configured}.lock`,
    });
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--conditions=development',
        '--input-type=module',
        '-e',
        CHILD_WRITER,
        new URL('./pi-trust-lock.ts', import.meta.url).href,
        mode,
        configured,
        canonical,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true },
    );
    children.push(child);
    let entered = false;
    let stderr = '';
    child.on('message', (message) => {
      if (message === 'entered') entered = true;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const exited = once(child, 'exit');
    try {
      await vi.waitFor(
        () => {
          expect(child.exitCode, stderr).toBeNull();
          expect(existsSync(`${canonical}.ok.lock`), stderr).toBe(true);
        },
        { timeout: 15_000, interval: 10 },
      );
      expect(entered).toBe(false);
      writeFileSync(canonical, JSON.stringify({ ...original, pi: true }));
    } finally {
      releasePi();
    }
    expect((await exited)[0], stderr).toBe(0);
    expect(entered).toBe(true);
    expect(JSON.parse(readFileSync(canonical, 'utf8'))).toEqual(
      mode === 'async'
        ? { existing: false, pi: true, openknowledge: true }
        : { existing: false, pi: true },
    );
    expect(existsSync(`${canonical}.ok.lock`)).toBe(false);
    expect(existsSync(`${configured}.lock`)).toBe(false);
  });

  test('uses the same canonical lock when configured aliases differ', async () => {
    const otherConfigured = join(root, 'other-configured', 'trust.json');
    mkdirSync(dirname(otherConfigured));
    const canonicalLock = `${canonical}.ok.lock`;
    writeFileSync(canonicalLock, 'held through another alias');
    configured = otherConfigured;
    const callback = vi.fn();
    await expect(runLock(callback)).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    expect(callback).not.toHaveBeenCalled();
    expect(readFileSync(canonicalLock, 'utf8')).toBe('held through another alias');
    expect(existsSync(`${configured}.lock`)).toBe(false);
  });

  test('refuses a busy Pi directory lock and releases the canonical lock', async () => {
    mkdirSync(`${configured}.lock`);
    const callback = vi.fn();
    const pending = runLock(callback);
    await expect(pending).rejects.toMatchObject({ code: 'ELOCKED' });
    await expect(pending).rejects.toThrow(`${configured}.lock within 5000ms`);
    expect(callback).not.toHaveBeenCalled();
    expect(lstatSync(`${configured}.lock`).isDirectory()).toBe(true);
    expect(existsSync(`${canonical}.ok.lock`)).toBe(false);
  });

  test('recovers a stale Pi directory lock with Pi default expiry', async () => {
    mkdirSync(`${configured}.lock`);
    const old = new Date(Date.now() - 20_000);
    utimesSync(`${configured}.lock`, old, old);
    const callback = vi.fn(() => {
      expect(lstatSync(`${configured}.lock`).isDirectory()).toBe(true);
      expect(lstatSync(`${canonical}.ok.lock`).isFile()).toBe(true);
    });
    await runLock(callback);
    expect(callback).toHaveBeenCalledOnce();
    expect(existsSync(`${configured}.lock`)).toBe(false);
    expect(existsSync(`${canonical}.ok.lock`)).toBe(false);
  });

  test('preserves an incompatible regular lock artifact instead of claiming it', async () => {
    writeFileSync(`${configured}.lock`, 'another lock protocol');
    const old = new Date(Date.now() - 20_000);
    utimesSync(`${configured}.lock`, old, old);
    const callback = vi.fn();
    await expect(runLock(callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(readFileSync(`${configured}.lock`, 'utf8')).toBe('another lock protocol');
    expect(existsSync(`${canonical}.ok.lock`)).toBe(false);
  });

  test('releases both locks when the synchronous writer throws', async () => {
    const failure = new Error('trust write failed');
    await expect(
      runLock(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(existsSync(`${configured}.lock`)).toBe(false);
    expect(existsSync(`${canonical}.ok.lock`)).toBe(false);
    await runLock(() => writeFileSync(canonical, '{"recovered":true}'));
    expect(readFileSync(canonical, 'utf8')).toBe('{"recovered":true}');
  });

  test('propagates Pi release failure while releasing the canonical lock', async () => {
    const unexpectedFile = join(`${configured}.lock`, 'unexpected');
    await expect(
      runLock(() => writeFileSync(unexpectedFile, 'preserve this file')),
    ).rejects.toThrow();
    expect(readFileSync(unexpectedFile, 'utf8')).toBe('preserve this file');
    expect(existsSync(`${canonical}.ok.lock`)).toBe(false);
  });

  test('preserves both writer and release failures in the caller-visible message', async () => {
    const writeFailure = new Error('trust write failed; repair the receipt before retrying');
    const unexpectedFile = join(`${configured}.lock`, 'unexpected');
    const failure: unknown = await runLock(() => {
      writeFileSync(unexpectedFile, 'preserve this file');
      throw writeFailure;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(writeFailure);
    const releaseFailure: unknown = failure.errors[1];
    expect(releaseFailure).toBeInstanceOf(Error);
    if (!(releaseFailure instanceof Error)) throw releaseFailure;
    expect(failure.message).toContain(writeFailure.message);
    expect(failure.message).toContain(releaseFailure.message);
    expect(failure.message).toContain(`${configured}.lock`);
    expect(readFileSync(unexpectedFile, 'utf8')).toBe('preserve this file');
    expect(existsSync(`${canonical}.ok.lock`)).toBe(false);
  });
});
