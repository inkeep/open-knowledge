import { describe, expect, test } from 'vitest';
import { readBootSessionUuid, readBootStartedAtMs } from './boot-session.ts';

const onDarwin = process.platform === 'darwin' ? test : test.skip;
const onLinux = process.platform === 'linux' ? test : test.skip;

describe('readBootSessionUuid', () => {
  test('unsupported platforms fail open to null', () => {
    expect(readBootSessionUuid('win32')).toBeNull();
    expect(readBootSessionUuid('freebsd')).toBeNull();
  });

  onDarwin('returns a stable per-boot UUID on macOS', () => {
    const first = readBootSessionUuid('darwin');
    expect(first).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i);
    expect(readBootSessionUuid('darwin')).toBe(first);
  });

  onLinux('returns a stable per-boot id on Linux', () => {
    const first = readBootSessionUuid('linux');
    expect(first).toBeTruthy();
    expect(readBootSessionUuid('linux')).toBe(first);
  });

  test('a probe failure fails open to null rather than throwing', () => {
    const crossPlatformProbe =
      process.platform === 'linux' ? readBootSessionUuid('darwin') : readBootSessionUuid('linux');
    expect(crossPlatformProbe).toBeNull();
  });
});

describe('readBootStartedAtMs', () => {
  test('dates the boot by subtracting uptime from now', () => {
    expect(readBootStartedAtMs(1_000_000_000, () => 120.4)).toBe(1_000_000_000 - 120_400);
  });

  test('an unusable uptime fails open to null rather than throwing', () => {
    expect(readBootStartedAtMs(1_000_000_000, () => 0)).toBeNull();
    expect(readBootStartedAtMs(1_000_000_000, () => Number.NaN)).toBeNull();
    expect(
      readBootStartedAtMs(1_000_000_000, () => {
        throw new Error('uptime unavailable');
      }),
    ).toBeNull();
  });

  test('the live boot instant precedes now', () => {
    const now = Date.now();
    const bootStartedAtMs = readBootStartedAtMs(now);
    expect(bootStartedAtMs).not.toBeNull();
    expect(bootStartedAtMs).toBeLessThan(now);
  });
});
