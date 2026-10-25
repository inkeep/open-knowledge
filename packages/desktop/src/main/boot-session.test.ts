import { describe, expect, test } from 'vitest';
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
