import { describe, expect, test } from 'vitest';
import { isTerminalPlatform } from './terminal-platform.ts';

describe('isTerminalPlatform', () => {
  test('enables PTY-backed terminal surfaces on every desktop platform', () => {
    expect(isTerminalPlatform('darwin')).toBe(true);
    expect(isTerminalPlatform('linux')).toBe(true);
    expect(isTerminalPlatform('win32')).toBe(true);
  });
});
