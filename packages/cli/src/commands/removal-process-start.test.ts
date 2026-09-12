import { describe, expect, test, vi } from 'vitest';
import { readRemovalProcessStart } from './removal-process-start.ts';

describe('readRemovalProcessStart', () => {
  test.each(['darwin', 'linux'] as const)(
    'reads %s process start with second precision in UTC regardless of inherited locale',
    (platform) => {
      const run = vi.fn(() => 'Tue Sep  8 20:21:34 2026\n');
      expect(
        readRemovalProcessStart(123, {
          platform,
          env: { LC_ALL: 'fr_FR.UTF-8', TZ: 'America/New_York' },
          run,
        }),
      ).toBe(Date.parse('2026-09-08T20:21:34.000Z'));
      expect(run).toHaveBeenCalledWith(
        '/bin/ps',
        ['-p', '123', '-o', 'lstart='],
        expect.objectContaining({
          timeout: 5000,
          env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC0' }),
        }),
      );
    },
  );

  test('reads Windows creation time through the native addon without launching a shell', () => {
    const readProcessStart = vi.fn(() => 1_789_000_000_456);
    const run = vi.fn(() => '');
    expect(
      readRemovalProcessStart(123, {
        platform: 'win32',
        nativeResolver: { requireModule: () => ({ readProcessStart }) },
        run,
      }),
    ).toBe(1_789_000_000_456);
    expect(readProcessStart).toHaveBeenCalledWith(123);
    expect(run).not.toHaveBeenCalled();
  });

  test.each([null, {}, { readProcessStart: 'invalid' }])(
    'refuses an unavailable Windows addon %j',
    (binding) => {
      const run = vi.fn(() => '');
      expect(
        readRemovalProcessStart(123, {
          platform: 'win32',
          nativeResolver: { requireModule: () => binding },
          run,
        }),
      ).toBeNull();
      expect(run).not.toHaveBeenCalled();
    },
  );

  test.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, '123'])(
    'refuses an invalid native process time %j',
    (value) => {
      expect(
        readRemovalProcessStart(123, {
          platform: 'win32',
          nativeResolver: { requireModule: () => ({ readProcessStart: () => value }) },
        }),
      ).toBeNull();
    },
  );

  test('refuses a Windows native query error without a shell fallback', () => {
    const run = vi.fn(() => '');
    expect(
      readRemovalProcessStart(123, {
        platform: 'win32',
        nativeResolver: {
          requireModule: () => ({
            readProcessStart() {
              throw new Error('Access denied');
            },
          }),
        },
        run,
      }),
    ).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  test('refuses a PID outside the 32-bit process-id range before loading native code', () => {
    const requireModule = vi.fn();
    expect(
      readRemovalProcessStart(0x1_0000_0000, {
        platform: 'win32',
        nativeResolver: { requireModule },
      }),
    ).toBeNull();
    expect(requireModule).not.toHaveBeenCalled();
  });

  test('refuses a PID outside the 32-bit process-id range before querying ps', () => {
    const run = vi.fn(() => 'Tue Sep  8 20:21:34 2026\n');
    expect(readRemovalProcessStart(0x1_0000_0000, { platform: 'darwin', run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  test.each(['', 'permission denied', 'Tue Sep  8 20:21:34 2026\nTue Sep  8 20:21:34 2026'])(
    'refuses unusable process start output %j',
    (output) => {
      expect(readRemovalProcessStart(123, { platform: 'darwin', run: () => output })).toBeNull();
    },
  );

  test('refuses an unavailable, unsuccessful, or timed out probe', () => {
    expect(
      readRemovalProcessStart(123, {
        platform: 'darwin',
        run: () => {
          throw new Error('process query failed');
        },
      }),
    ).toBeNull();
  });

  test.each([0, -1, Number.NaN, 12.5])('never queries an invalid PID %j', (pid) => {
    const run = vi.fn(() => '2026-09-08T20:21:34.000Z');
    expect(readRemovalProcessStart(pid, { run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

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
        readRemovalProcessStart(123, {
          platform: 'win32',
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
        readRemovalProcessStart(123, {
          platform: 'win32',
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
      readRemovalProcessStart(123, {
        platform: 'win32',
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
      readRemovalProcessStart(123, {
        platform: 'win32',
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
      readRemovalProcessStart(123, {
        platform: 'win32',
        arch: 'x64',
        nativeResolver: { requireModule },
        onNativeFailure,
      }),
    ).toBeNull();
    expect(onNativeFailure).toHaveBeenCalled();
    expect(onNativeFailure.mock.calls.at(-1)?.[0]).toMatchObject({ kind });
  });

  test('reads the current process start on the current operating system', () => {
    const startedAt = readRemovalProcessStart(process.pid);
    expect(startedAt).not.toBeNull();
    expect(startedAt).toBeLessThanOrEqual(Date.now());
    expect(startedAt).toBeGreaterThan(Date.now() - process.uptime() * 1000 - 10_000);
  });
});
