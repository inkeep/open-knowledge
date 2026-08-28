import { describe, expect, test } from 'vitest';
import { getWindowsEnvValue, windowsPathKey } from './windows-env.ts';

describe('Windows environment helpers', () => {
  test('looks up names case-insensitively without returning undefined shadows', () => {
    expect(getWindowsEnvValue({ PATH: undefined, Path: 'C:\\Tools' }, 'path')).toBe('C:\\Tools');
  });

  test('preserves inherited PATH casing and falls back to PATH', () => {
    expect(windowsPathKey({ Path: 'C:\\Tools' })).toBe('Path');
    expect(windowsPathKey({})).toBe('PATH');
  });
});
