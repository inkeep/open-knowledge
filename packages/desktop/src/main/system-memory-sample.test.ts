import { describe, expect, test, vi } from 'vitest';
import {
  createMacMemoryPressureProbe,
  parseMacMemorySysctl,
  readSystemMemorySample,
} from './system-memory-sample.ts';

describe('parseMacMemorySysctl', () => {
  test.each([
    ['1', 'normal'],
    ['2', 'warn'],
    ['4', 'critical'],
  ] as const)('maps pressure level %s to %s', (level, pressure) => {
    expect(
      parseMacMemorySysctl(
        `${level}\ntotal = 2048.00M  used = 1186.25M  free = 861.75M  (encrypted)\n`,
      ),
    ).toEqual({ pressure, swapUsedKb: 1_214_720 });
  });

  test('reads gigabyte swap figures', () => {
    expect(
      parseMacMemorySysctl('4\ntotal = 8192.00M  used = 6.50G  free = 1.50G  (encrypted)')
        .swapUsedKb,
    ).toBe(6_815_744);
  });

  test('reports an unknown level and missing swap line as unreadable rather than guessing', () => {
    expect(parseMacMemorySysctl('3\n')).toEqual({
      pressure: 'unreadable',
      swapUsedKb: null,
      unreadableCause: 'unparsed',
    });
    expect(parseMacMemorySysctl('')).toEqual({
      pressure: 'unreadable',
      swapUsedKb: null,
      unreadableCause: 'unparsed',
    });
  });
});

describe('createMacMemoryPressureProbe', () => {
  test('caches the latest reading with the time it was taken', async () => {
    let calls = 0;
    const probe = createMacMemoryPressureProbe({
      runSysctl: async () => {
        calls++;
        return '2\ntotal = 1024.00M  used = 512.00M  free = 512.00M  (encrypted)';
      },
      now: () => new Date('2026-10-19T09:17:59.000Z'),
    });
    expect(probe.latest()).toBeNull();
    probe.refresh();
    probe.refresh();
    await vi.waitFor(() => expect(probe.latest()).not.toBeNull());
    expect(calls).toBe(1);
    expect(probe.latest()).toEqual({
      pressure: 'warn',
      swapUsedKb: 524_288,
      readAt: '2026-10-19T09:17:59.000Z',
    });
  });

  test('takes a fresh reading on every refresh once the previous one settles', async () => {
    const levels = ['1', '4'];
    const probe = createMacMemoryPressureProbe({
      runSysctl: async () => `${levels.shift() ?? '2'}\n`,
      now: () => new Date('2026-10-19T09:17:59.000Z'),
    });
    probe.refresh();
    await vi.waitFor(() => expect(probe.latest()?.pressure).toBe('normal'));
    probe.refresh();
    await vi.waitFor(() => expect(probe.latest()?.pressure).toBe('critical'));
  });

  test.each([
    [
      'a timeout',
      Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }),
      'timeout',
    ],
    [
      'a signal the probe did not send',
      Object.assign(new Error('Command failed'), { killed: false, code: null, signal: 'SIGKILL' }),
      'signal',
    ],
    ['a non-zero exit', Object.assign(new Error('Command failed'), { code: 1 }), 'exit'],
    ['a spawn failure', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }), 'spawn'],
  ] as const)('records %s as unreadable with its cause', async (_label, failure, cause) => {
    const probe = createMacMemoryPressureProbe({
      runSysctl: async () => {
        throw failure;
      },
      now: () => new Date('2026-10-19T09:17:59.000Z'),
    });
    probe.refresh();
    await vi.waitFor(() => expect(probe.latest()?.unreadableCause).toBe(cause));
    expect(probe.latest()?.pressure).toBe('unreadable');
    expect(readSystemMemorySample({ total: 1, free: 1 }, probe.latest())).toMatchObject({
      pressure: 'unreadable',
      pressureUnreadableCause: cause,
    });
  });
});

describe('readSystemMemorySample', () => {
  test('combines Electron memory figures with the macOS pressure reading', () => {
    expect(
      readSystemMemorySample(
        { total: 16_777_216, free: 204_800 },
        { pressure: 'critical', swapUsedKb: 3_145_728, readAt: '2026-10-19T09:17:59.000Z' },
      ),
    ).toEqual({
      totalKb: 16_777_216,
      freeKb: 204_800,
      swapUsedKb: 3_145_728,
      pressure: 'critical',
      pressureReadAt: '2026-10-19T09:17:59.000Z',
    });
  });

  test('derives swap use from Electron swap figures where the platform reports them', () => {
    expect(
      readSystemMemorySample(
        { total: 8_000_000, free: 1_000_000, swapTotal: 2_000_000, swapFree: 500_000 },
        null,
      ),
    ).toEqual({
      totalKb: 8_000_000,
      freeKb: 1_000_000,
      swapTotalKb: 2_000_000,
      swapFreeKb: 500_000,
      swapUsedKb: 1_500_000,
    });
  });
});
