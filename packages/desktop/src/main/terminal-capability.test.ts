import { describe, expect, test } from 'vitest';
import {
  isTerminalAvailable,
  parseWindowsBuildNumber,
  TERMINAL_AVAILABLE_ARG,
  WINDOWS_CONPTY_MIN_BUILD,
  withTerminalCapabilityArg,
} from './terminal-capability.ts';

describe('Windows terminal capability floor', () => {
  test('parses the Windows build component from os.release()', () => {
    expect(parseWindowsBuildNumber('10.0.17763')).toBe(17763);
    expect(parseWindowsBuildNumber('10.0.26100')).toBe(26100);
    expect(parseWindowsBuildNumber('10.0')).toBeNull();
    expect(parseWindowsBuildNumber('10.0.preview')).toBeNull();
  });

  test('keeps every terminal affordance unavailable below Windows 10 1809', () => {
    expect(isTerminalAvailable('win32', WINDOWS_CONPTY_MIN_BUILD - 1)).toBe(false);
  });

  test('enables Windows at the 1809 floor and above', () => {
    expect(isTerminalAvailable('win32', WINDOWS_CONPTY_MIN_BUILD)).toBe(true);
    expect(isTerminalAvailable('win32', WINDOWS_CONPTY_MIN_BUILD + 1)).toBe(true);
  });

  test('keeps the existing macOS and Linux capability independent of the Windows build', () => {
    expect(isTerminalAvailable('darwin', null)).toBe(true);
    expect(isTerminalAvailable('linux', null)).toBe(true);
  });

  test('fails closed when a Windows build cannot be determined', () => {
    expect(isTerminalAvailable('win32', null)).toBe(false);
    expect(isTerminalAvailable('win32', Number.NaN)).toBe(false);
  });

  test('feeds only a positive capability verdict into renderer-window argv', () => {
    expect(withTerminalCapabilityArg(['--ok-mode=editor'], false)).toEqual(['--ok-mode=editor']);
    expect(withTerminalCapabilityArg(['--ok-mode=editor'], true)).toEqual([
      '--ok-mode=editor',
      TERMINAL_AVAILABLE_ARG,
    ]);
  });
});
