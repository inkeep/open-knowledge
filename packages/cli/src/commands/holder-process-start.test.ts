import { readProcessStart as readServerProcessStart } from '@inkeep/open-knowledge-server';
import pino from 'pino';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  readHolderProcessStart,
  readWindowsNativeProcessStart,
  registerWindowsProcessStartReader,
} from './holder-process-start.ts';

const installedNativeBinding = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('../native/load-native-config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../native/load-native-config.ts')>();
  return {
    ...actual,
    requireNativeConfigModule: (...args: Parameters<typeof actual.requireNativeConfigModule>) =>
      installedNativeBinding.current === undefined
        ? actual.requireNativeConfigModule(...args)
        : installedNativeBinding.current,
  };
});

describe('readWindowsNativeProcessStart', () => {
  test('reads Windows creation time through the native addon', () => {
    const readProcessStart = vi.fn(() => 1_789_000_000_456);
    expect(
      readWindowsNativeProcessStart(123, {
        nativeResolver: { requireModule: () => ({ readProcessStart }) },
      }),
    ).toBe(1_789_000_000_456);
    expect(readProcessStart).toHaveBeenCalledWith(123);
  });

  test.each([null, {}, { readProcessStart: 'invalid' }])(
    'refuses an unavailable Windows addon %j',
    (binding) => {
      expect(
        readWindowsNativeProcessStart(123, {
          nativeResolver: { requireModule: () => binding },
        }),
      ).toBeNull();
    },
  );

  test.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, '123'])(
    'refuses an invalid native process time %j',
    (value) => {
      expect(
        readWindowsNativeProcessStart(123, {
          nativeResolver: { requireModule: () => ({ readProcessStart: () => value }) },
        }),
      ).toBeNull();
    },
  );

  test('refuses a Windows native query error', () => {
    expect(
      readWindowsNativeProcessStart(123, {
        nativeResolver: {
          requireModule: () => ({
            readProcessStart() {
              throw new Error('Access denied');
            },
          }),
        },
      }),
    ).toBeNull();
  });

  test.each([0x1_0000_0000, 0, -1, Number.NaN, 12.5])(
    'refuses PID %j before loading native code',
    (pid) => {
      const requireModule = vi.fn();
      expect(readWindowsNativeProcessStart(pid, { nativeResolver: { requireModule } })).toBeNull();
      expect(requireModule).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['unavailable', () => null, 'did not load or does not export readProcessStart'],
    [
      'invalid result',
      () => ({ readProcessStart: () => 1.5 }),
      'readProcessStart returned an invalid value',
    ],
    [
      'query error',
      () => ({
        readProcessStart: () => {
          throw new Error('OpenProcess: os error 5');
        },
      }),
      'OpenProcess: os error 5',
    ],
    [
      'loader error',
      () => {
        throw new Error('loader failed');
      },
      'loader failed',
    ],
    [
      'wrong-shaped binding',
      () => ({ readProcessStart: 'invalid' }),
      'object keys=[readProcessStart] readProcessStart=string',
    ],
    [
      'non-primitive result',
      () => ({ readProcessStart: () => ({ startedAt: 1 }) }),
      'readProcessStart returned an invalid value: object keys=[startedAt]',
    ],
  ] as const)('reports %s with native debugging enabled', (_name, requireModule, message) => {
    vi.stubEnv('OK_DEBUG_NATIVE', '1');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const onNativeFailure = vi.fn();
    try {
      expect(
        readWindowsNativeProcessStart(123, {
          nativeResolver: { requireModule },
          onNativeFailure,
        }),
      ).toBeNull();
      const written = stderr.mock.calls.map(([value]) => String(value)).join('');
      expect(written).toContain(message);
      expect(written).not.toContain('[object Object]');
      expect(
        onNativeFailure.mock.calls.map(([failure]) => String(failure.reason)).join('; '),
      ).toContain(message);
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  test.each([
    ['x64', 'native-config.win32-x64-msvc.node'],
    ['arm64', 'native-config.win32-arm64-msvc.node'],
    ['ia32', 'native-config.win32-ia32-msvc.node'],
  ] as const)('names the %s addon it looked for when none was found', (arch, target) => {
    const onNativeFailure = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(
        readWindowsNativeProcessStart(123, {
          arch,
          nativeResolver: { requireModule: () => null },
          onNativeFailure,
        }),
      ).toBeNull();
      expect(onNativeFailure).toHaveBeenCalledWith({
        kind: 'unavailable',
        reason: `the Windows native addon (${target}) did not load or does not export readProcessStart: the addon was not found`,
      });
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  test('describes an undefined binding as absent rather than rendering the value', () => {
    const onNativeFailure = vi.fn();
    expect(
      readWindowsNativeProcessStart(123, {
        arch: 'x64',
        nativeResolver: { requireModule: () => undefined },
        onNativeFailure,
      }),
    ).toBeNull();
    expect(onNativeFailure).toHaveBeenCalledWith({
      kind: 'unavailable',
      reason:
        'the Windows native addon (native-config.win32-x64-msvc.node) did not load or does not export readProcessStart: the addon was not found',
    });
  });

  test('leads the native failure record with the message that names the fault', () => {
    const onNativeFailure = vi.fn();
    const dlopen = Object.assign(
      new Error(
        '\\\\?\\C:\\app\\dist\\native\\native-config.win32-x64-msvc.node is not a valid Win32 application.',
      ),
      { code: 'ERR_DLOPEN_FAILED' },
    );
    const missingPackage = Object.assign(
      new Error("Cannot find module '@inkeep/open-knowledge-native-config-win32-x64-msvc'"),
      { code: 'MODULE_NOT_FOUND', cause: dlopen },
    );
    const requireModule = () => {
      throw Object.assign(
        new Error(
          'Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.',
        ),
        { cause: missingPackage },
      );
    };
    expect(
      readWindowsNativeProcessStart(123, {
        arch: 'x64',
        nativeResolver: { requireModule },
        onNativeFailure,
      }),
    ).toBeNull();
    const reasons = onNativeFailure.mock.calls.map(([failure]) => String(failure.reason));
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toContain('bundled loader failed to load: ');
    expect(reasons[1]).toContain('workspace addon failed to load: ');
    expect(reasons.at(-1)).toBe(
      'the Windows native addon (native-config.win32-x64-msvc.node) did not load or does not export readProcessStart: no usable binding was returned',
    );
    for (const earlier of ['is not a valid Win32 application.', "Cannot find module '@inkeep"]) {
      expect(reasons[0]).toContain(earlier);
      expect(reasons[0].indexOf(earlier)).toBeLessThan(
        reasons[0].indexOf('Cannot find native binding.'),
      );
    }
    expect(reasons[0]).toContain('Cannot find native binding.');
  });

  test.each([
    [
      'query-failed',
      'a thrown query',
      () => ({
        readProcessStart: () => {
          throw new Error('OpenProcess: os error 5');
        },
      }),
    ],
    ['unavailable', 'an absent addon', () => null],
    ['unavailable', 'a wrong-shaped binding', () => ({ readProcessStart: 'invalid' })],
    ['unavailable', 'an invalid result', () => ({ readProcessStart: () => 1.5 })],
  ] as const)('classifies %s for %s', (kind, _name, requireModule) => {
    const onNativeFailure = vi.fn();
    expect(
      readWindowsNativeProcessStart(123, {
        arch: 'x64',
        nativeResolver: { requireModule },
        onNativeFailure,
      }),
    ).toBeNull();
    expect(onNativeFailure).toHaveBeenCalled();
    expect(onNativeFailure.mock.calls.at(-1)?.[0]).toMatchObject({ kind });
  });

  test.runIf(process.platform === 'win32')(
    'reads the current process start through the installed addon',
    () => {
      const startedAt = readWindowsNativeProcessStart(process.pid);
      expect(startedAt).not.toBeNull();
      expect(startedAt).toBeLessThanOrEqual(Date.now());
      expect(startedAt).toBeGreaterThan(Date.now() - process.uptime() * 1000 - 10_000);
    },
  );
});

describe('registerWindowsProcessStartReader', () => {
  afterEach(() => {
    installedNativeBinding.current = undefined;
  });

  test('lets the server read Windows process starts through the installed addon until unregistered', () => {
    const readProcessStart = vi.fn(() => 1_789_000_000_456);
    installedNativeBinding.current = { readProcessStart };
    const unregister = registerWindowsProcessStartReader();
    try {
      expect(readServerProcessStart(4242, { platform: 'win32' })).toEqual({
        startedAtMs: 1_789_000_000_456,
        clock: 'creation',
      });
      expect(readProcessStart).toHaveBeenCalledWith(4242);
    } finally {
      unregister();
    }
    expect(readServerProcessStart(4242, { platform: 'win32' })).toBeNull();
  });

  test('records each kind of native failure once, however often the reader is asked', () => {
    const records: Array<Record<string, unknown>> = [];
    installedNativeBinding.current = {
      readProcessStart() {
        throw new Error('OpenProcess: os error 5');
      },
    };
    const unregister = registerWindowsProcessStartReader(
      pino({ level: 'warn' }, { write: (line) => records.push(JSON.parse(line)) }),
    );
    try {
      for (let read = 0; read < 3; read += 1) {
        expect(readServerProcessStart(4242, { platform: 'win32' })).toBeNull();
      }
      installedNativeBinding.current = null;
      for (let read = 0; read < 3; read += 1) {
        expect(readServerProcessStart(4242, { platform: 'win32' })).toBeNull();
      }
    } finally {
      unregister();
    }
    expect(records).toEqual([
      expect.objectContaining({
        event: 'process-start-native-failure',
        pid: process.pid,
        lockPid: 4242,
        kind: 'query-failed',
        reasons: [expect.stringContaining('OpenProcess: os error 5')],
      }),
      expect.objectContaining({
        event: 'process-start-native-failure',
        pid: process.pid,
        lockPid: 4242,
        kind: 'unavailable',
      }),
    ]);
  });
});

describe('readHolderProcessStart', () => {
  afterEach(() => {
    installedNativeBinding.current = undefined;
  });

  test('reads a Windows holder through the installed addon as a creation time', () => {
    const readProcessStart = vi.fn(() => 1_789_000_000_456);
    installedNativeBinding.current = { readProcessStart };
    expect(readHolderProcessStart(4242, { platform: 'win32' })).toEqual({
      startedAtMs: 1_789_000_000_456,
      clock: 'creation',
    });
    expect(readProcessStart).toHaveBeenCalledWith(4242);
  });

  test('reports why the Windows addon could not read the holder', () => {
    installedNativeBinding.current = {
      readProcessStart() {
        throw new Error('OpenProcess: os error 5');
      },
    };
    const onNativeFailure = vi.fn();
    expect(readHolderProcessStart(4242, { platform: 'win32', onNativeFailure })).toBeNull();
    expect(onNativeFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'query-failed' }));
  });

  test.skipIf(process.platform === 'win32')(
    'reads a holder on this host the way the server records it in a lock',
    () => {
      expect(readHolderProcessStart(process.pid)).toEqual(readServerProcessStart(process.pid));
    },
  );
});
