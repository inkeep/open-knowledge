import { describe, expect, test } from 'vitest';
import { asReportableAppVersion } from './crashed-app-version.ts';

describe('versions that describe a real build', () => {
  test('a release version passes through unchanged', () => {
    expect(asReportableAppVersion('0.41.0')).toBe('0.41.0');
  });

  test('a prerelease with build metadata passes through unchanged', () => {
    expect(asReportableAppVersion('0.47.0-beta.3+build.2026')).toBe('0.47.0-beta.3+build.2026');
  });

  test('the full printable-ASCII range is admitted', () => {
    const printable = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
      String.fromCharCode(0x20 + i),
    ).join('');
    expect(asReportableAppVersion(printable)).toBe(printable);
  });
});

describe('values that cannot be vouched for', () => {
  test('an absent version stays absent', () => {
    expect(asReportableAppVersion(null)).toBeNull();
    expect(asReportableAppVersion(undefined)).toBeNull();
    expect(asReportableAppVersion('')).toBeNull();
  });

  const LINE_AFFECTING: Array<{ name: string; codePoint: number }> = [
    { name: 'a line feed', codePoint: 0x0a },
    { name: 'a carriage return', codePoint: 0x0d },
    { name: 'a NUL', codePoint: 0x00 },
    { name: 'an escape (terminal control sequences)', codePoint: 0x1b },
    { name: 'a DEL', codePoint: 0x7f },
    { name: 'a C1 control', codePoint: 0x9b },
    { name: 'a next-line (U+0085)', codePoint: 0x85 },
    { name: 'a line separator (U+2028)', codePoint: 0x2028 },
    { name: 'a paragraph separator (U+2029)', codePoint: 0x2029 },
    { name: 'a right-to-left override (U+202E)', codePoint: 0x202e },
    { name: 'a right-to-left isolate (U+2067)', codePoint: 0x2067 },
  ];

  for (const { name, codePoint } of LINE_AFFECTING) {
    test(`${name} in the middle of an otherwise plausible version is refused`, () => {
      expect(asReportableAppVersion(`0.41${String.fromCodePoint(codePoint)}.0`)).toBeNull();
    });
  }

  test('a version long enough to crowd out the report is refused', () => {
    expect(asReportableAppVersion('9'.repeat(256))).toBe('9'.repeat(256));
    expect(asReportableAppVersion('9'.repeat(257))).toBeNull();
  });

  test('a non-string survives the type boundary without becoming one', () => {
    expect(asReportableAppVersion(41 as unknown as string)).toBeNull();
    expect(asReportableAppVersion({ toString: () => '0.41.0' } as unknown as string)).toBeNull();
  });
});
