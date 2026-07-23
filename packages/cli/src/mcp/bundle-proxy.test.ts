import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import {
  emitBundleProxyEvent,
  findBundledOkPath,
  proxyToBundle,
  shouldProxyToBundle,
} from './bundle-proxy.ts';

const userBundle = '/Users/alice/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh';
const systemBundle = '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh';

describe('findBundledOkPath', () => {
  test('returns the user-local bundle before /Applications', () => {
    const seen = new Set([userBundle, systemBundle]);
    expect(findBundledOkPath('darwin', '/Users/alice', { existsSync: (p) => seen.has(p) })).toBe(
      userBundle,
    );
  });

  test('returns the system bundle when it is the only candidate', () => {
    expect(
      findBundledOkPath('darwin', '/Users/alice', { existsSync: (p) => p === systemBundle }),
    ).toBe(systemBundle);
  });

  test('returns null for absent bundles and non-macOS platforms', () => {
    expect(findBundledOkPath('darwin', '/Users/alice', { existsSync: () => false })).toBeNull();
    expect(findBundledOkPath('linux', '/Users/alice', { existsSync: () => true })).toBeNull();
  });
});

describe('shouldProxyToBundle', () => {
  test('suppresses via env, flag, platform, and bundled self detection', () => {
    expect(
      shouldProxyToBundle({ OK_BUNDLE_PROXY: '0' }, ['node', 'cli.mjs', 'mcp'], 'darwin'),
    ).toEqual({
      proxy: false,
      suppressedBy: 'env',
    });
    expect(
      shouldProxyToBundle({}, ['node', 'cli.mjs', 'mcp', '--no-bundle-proxy'], 'darwin'),
    ).toEqual({
      proxy: false,
      suppressedBy: 'flag',
    });
    expect(shouldProxyToBundle({}, ['node', 'cli.mjs', 'mcp'], 'linux')).toEqual({
      proxy: false,
      suppressedBy: 'platform',
    });
    expect(
      shouldProxyToBundle(
        {},
        ['node', '/Applications/OpenKnowledge.app/Contents/Resources/cli/dist/cli.mjs', 'mcp'],
        'darwin',
      ),
    ).toEqual({ proxy: false, suppressedBy: 'self' });
  });

  test('proxies on macOS when no suppression signal is present', () => {
    expect(shouldProxyToBundle({}, ['node', 'cli.mjs', 'mcp'], 'darwin')).toEqual({
      proxy: true,
      suppressedBy: null,
    });
  });
});

describe('emitBundleProxyEvent', () => {
  test('emits a parseable JSON line with the suppression hint as a field', () => {
    let stderr = '';
    emitBundleProxyEvent({
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
      mode: 'fallback-absent',
      bundlePath: null,
      reason: 'no bundle',
    });

    const parsed = JSON.parse(stderr);
    expect(parsed).toMatchObject({
      event: 'mcp-bundle-proxy',
      mode: 'fallback-absent',
      bundlePath: null,
      reason: 'no bundle',
    });
    expect(parsed.hint).toContain('--no-bundle-proxy');
  });
});

describe('proxyToBundle', () => {
  test('rejects for non-zero startup exit so caller can fall back in-process', async () => {
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
    child.kill = () => true;
    const promise = proxyToBundle({
      bundlePath: systemBundle,
      argv: ['mcp'],
      env: {},
      stderr: { write: () => true } as NodeJS.WriteStream,
      spawnImpl: (() => child) as never,
      startupFailureWindowMs: 1_000,
      now: () => 10,
      exitProcess: (() => {
        throw new Error('should not exit');
      }) as never,
    });

    child.emit('exit', 69, null);

    await expect(promise).rejects.toThrow('bundle process exited during startup with code 69');
  });

  test('forwards established child exits to the parent process exit code', async () => {
    let currentTime = 0;
    let exitedWith: number | null = null;
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
    child.kill = () => true;
    const promise = proxyToBundle({
      bundlePath: systemBundle,
      argv: ['mcp'],
      env: {},
      stderr: { write: () => true } as NodeJS.WriteStream,
      spawnImpl: (() => child) as never,
      startupFailureWindowMs: 1_000,
      now: () => currentTime,
      exitProcess: ((code: number) => {
        exitedWith = code;
        return undefined as never;
      }) as never,
    });
    promise.catch(() => undefined);

    currentTime = 2_000;
    child.emit('exit', 2, null);

    expect(exitedWith).toBe(2);
  });
});
