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

  test('reads a Windows process creation time without losing milliseconds', () => {
    const run = vi.fn(() => '\uFEFF2026-09-08T20:21:34.4567890Z\r\n');
    expect(
      readRemovalProcessStart(123, {
        platform: 'win32',
        env: { SYSTEMROOT: 'D:\\Windows' },
        run,
      }),
    ).toBe(Date.parse('2026-09-08T20:21:34.456Z'));
    expect(run).toHaveBeenCalledWith(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      expect.arrayContaining([
        '-NoProfile',
        '-NonInteractive',
        expect.stringContaining('(Get-Process -Id 123).StartTime.ToUniversalTime()'),
      ]),
      expect.objectContaining({ timeout: 5000, windowsHide: true }),
    );
  });

  test.each([undefined, '', '   ', 'relative-windows'])(
    'uses an absolute PowerShell fallback for an unusable SystemRoot %j',
    (systemRoot) => {
      const run = vi.fn(() => '2026-09-08T20:21:34.000Z');
      readRemovalProcessStart(123, {
        platform: 'win32',
        env: { SystemRoot: systemRoot },
        run,
      });
      expect(run).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        expect.any(Array),
        expect.any(Object),
      );
    },
  );

  test.each(['', 'permission denied', 'Tue Sep  8 20:21:34 2026\nTue Sep  8 20:21:34 2026'])(
    'refuses unusable process start output %j',
    (output) => {
      expect(readRemovalProcessStart(123, { platform: 'darwin', run: () => output })).toBeNull();
    },
  );

  test('refuses an unavailable, unsuccessful, or timed out probe', () => {
    expect(
      readRemovalProcessStart(123, {
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

  test('reads the current process start on the current operating system', () => {
    const startedAt = readRemovalProcessStart(process.pid);
    expect(startedAt).not.toBeNull();
    expect(startedAt).toBeLessThanOrEqual(Date.now());
    expect(startedAt).toBeGreaterThan(Date.now() - process.uptime() * 1000 - 10_000);
  });
});
