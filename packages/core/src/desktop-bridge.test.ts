import { describe, expect, it } from 'vitest';
import {
  isTerminalShellNoticeReason,
  isTerminalSupportFileNoticeReason,
  TERMINAL_SHELL_NOTICE_REASONS,
  TERMINAL_SUPPORT_FILE_NOTICE_REASONS,
} from './desktop-bridge.ts';

const WIRE_REASONS = [
  'config-unreadable',
  'invalid-value',
  'not-absolute',
  'not-found',
  'unsupported-family',
];
const SUPPORT_FILE_REASONS = ['containment-refused', 'write-failed'];

describe('TERMINAL_SHELL_NOTICE_REASONS', () => {
  it('exposes exactly the wire vocabulary', () => {
    expect([...TERMINAL_SHELL_NOTICE_REASONS].sort()).toEqual([...WIRE_REASONS].sort());
  });
});

describe('isTerminalShellNoticeReason', () => {
  it('accepts every reason in the wire vocabulary', () => {
    for (const reason of WIRE_REASONS) {
      expect(isTerminalShellNoticeReason(reason)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isTerminalShellNoticeReason('unreadable')).toBe(false);
    expect(isTerminalShellNoticeReason('')).toBe(false);
    expect(isTerminalShellNoticeReason('Invalid-Value')).toBe(false);
    expect(isTerminalShellNoticeReason('__proto__')).toBe(false);
  });

  it('rejects non-string inputs (defends the IPC boundary against arbitrary payloads)', () => {
    expect(isTerminalShellNoticeReason(undefined)).toBe(false);
    expect(isTerminalShellNoticeReason(null)).toBe(false);
    expect(isTerminalShellNoticeReason(0)).toBe(false);
    expect(isTerminalShellNoticeReason(false)).toBe(false);
    expect(isTerminalShellNoticeReason({})).toBe(false);
    expect(isTerminalShellNoticeReason(['invalid-value'])).toBe(false);
  });
});

describe('terminal support-file notice reasons', () => {
  it('exposes and accepts exactly the wire vocabulary', () => {
    expect([...TERMINAL_SUPPORT_FILE_NOTICE_REASONS].sort()).toEqual(
      [...SUPPORT_FILE_REASONS].sort(),
    );
    for (const reason of SUPPORT_FILE_REASONS) {
      expect(isTerminalSupportFileNoticeReason(reason)).toBe(true);
    }
    expect(isTerminalSupportFileNoticeReason('escape')).toBe(false);
    expect(isTerminalSupportFileNoticeReason(null)).toBe(false);
  });
});
