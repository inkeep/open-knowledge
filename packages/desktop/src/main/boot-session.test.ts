import { describe, expect, test } from 'bun:test';
import { readBootSessionUuid } from './boot-session.ts';

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
    // Stable within one kernel session — the whole point of the identity.
    expect(readBootSessionUuid('darwin')).toBe(first);
  });

  onLinux('returns a stable per-boot id on Linux', () => {
    const first = readBootSessionUuid('linux');
    expect(first).toBeTruthy();
    expect(readBootSessionUuid('linux')).toBe(first);
  });

  test('a probe failure fails open to null rather than throwing', () => {
    // Probing the "wrong" platform's code path always fails on any real
    // host — the darwin branch's absolute sysctl path doesn't exist on
    // Linux/Windows, and the linux branch's /proc file doesn't exist on
    // macOS/Windows — exercising the catch-to-null contract unconditionally.
    const crossPlatformProbe =
      process.platform === 'linux' ? readBootSessionUuid('darwin') : readBootSessionUuid('linux');
    expect(crossPlatformProbe).toBeNull();
  });
});
