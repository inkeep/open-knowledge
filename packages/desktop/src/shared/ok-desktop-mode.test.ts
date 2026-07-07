import { describe, expect, test } from 'bun:test';
import { resolveOkDesktopMode } from './ok-desktop-mode.ts';

describe('resolveOkDesktopMode', () => {
  test('maps the terminal flag to the terminal window mode', () => {
    expect(resolveOkDesktopMode('terminal')).toBe('terminal');
  });

  test('maps the navigator flag to the navigator window mode', () => {
    expect(resolveOkDesktopMode('navigator')).toBe('navigator');
  });

  test('maps the editor flag to the editor window mode', () => {
    expect(resolveOkDesktopMode('editor')).toBe('editor');
  });

  test('falls back to editor when the flag is absent', () => {
    expect(resolveOkDesktopMode(undefined)).toBe('editor');
  });

  test('falls back to editor for an unrecognized flag value', () => {
    expect(resolveOkDesktopMode('totally-unknown')).toBe('editor');
  });
});
