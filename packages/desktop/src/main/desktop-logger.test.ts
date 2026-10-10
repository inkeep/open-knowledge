import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { flushDesktopLogger, getLogger, getRootDesktopLogger } from './desktop-logger.ts';

describe('a process that exits in the same tick it first logs', () => {
  test('exits cleanly and the line reaches the log file', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-desktop-logs-exit-'));
    const loggerUrl = pathToFileURL(join(import.meta.dirname, 'desktop-logger.ts')).href;
    const { OK_CHANNEL: _channel, ...inheritedEnv } = process.env;
    try {
      const child = spawnSync(
        process.execPath,
        [
          '--conditions=development',
          '--input-type=module',
          '-e',
          `const { getLogger } = await import(${JSON.stringify(loggerUrl)});
           getLogger('exit-probe').info({}, 'logged before exit');
           process.exit(0);`,
        ],
        {
          encoding: 'utf-8',
          timeout: 20_000,
          env: {
            ...inheritedEnv,
            HOME: home,
            USERPROFILE: home,
            NODE_ENV: 'production',
            OK_LOG_LEVEL: 'info',
          },
        },
      );
      expect(child.stderr).not.toContain('sonic boom is not ready yet');
      expect(child.status, `signal=${child.signal}\n${child.stderr}`).toBe(0);
      const logFiles = readdirSync(home, { recursive: true, encoding: 'utf-8' }).filter((f) =>
        /desktop\.\d{4}-\d{2}-\d{2}\.log$/.test(f),
      );
      expect(logFiles).toHaveLength(1);
      expect(readFileSync(join(home, logFiles[0] as string), 'utf-8')).toContain(
        'logged before exit',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('flushDesktopLogger', () => {
  test('does not throw when called before any logging has initialized the destination', () => {
    expect(() => flushDesktopLogger()).not.toThrow();
  });

  test('does not throw after the destination has been initialized by a log call', () => {
    getLogger('test-flush').info({}, 'init destination');
    expect(() => flushDesktopLogger()).not.toThrow();
    expect(() => flushDesktopLogger()).not.toThrow();
  });
});

describe('error serialization (what the raw-err discipline buys)', () => {
  test("this package's root logger binds the stack-preserving serializer on both err keys", () => {
    const serializers = (
      getRootDesktopLogger() as unknown as Record<symbol, Record<string, unknown>>
    )[pino.symbols.serializersSym];
    for (const key of ['err', 'error'] as const) {
      const serializer = serializers?.[key];
      expect(serializer).toBe(pino.stdSerializers.err);
      const rendered = (serializer as (e: Error) => { message?: string; stack?: string })(
        new Error('boom-probe'),
      );
      expect(rendered.message).toBe('boom-probe');
      expect(rendered.stack ?? '').toContain('boom-probe');
    }
  });
});

describe('logs dir per channel', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test('importing under an unsupported OK_CHANNEL does not throw', async () => {
    vi.stubEnv('OK_CHANNEL', 'bogus');
    vi.resetModules();
    await expect(import('./desktop-logger.ts')).resolves.toBeDefined();
  });

  test('Beta writes logs under ~/.ok-beta/logs, not ~/.ok/logs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-desktop-logs-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('OK_CHANNEL', 'beta');
    vi.resetModules();
    try {
      const { getRootDesktopLogger } = await import('./desktop-logger.ts');
      const stream = (
        getRootDesktopLogger() as unknown as Record<symbol, NodeJS.EventEmitter & { end(): void }>
      )[pino.symbols.streamSym];
      const closed = once(stream, 'close');
      stream.end();
      await closed;
      expect(existsSync(join(home, '.ok-beta', 'logs'))).toBe(true);
      expect(existsSync(join(home, '.ok', 'logs'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
