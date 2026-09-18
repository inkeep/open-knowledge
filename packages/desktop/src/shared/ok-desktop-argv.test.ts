import { describe, expect, test } from 'vitest';
import { resolveOkDesktopMode, resolveOkThemePreference } from './ok-desktop-argv.ts';

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

  test('maps the note flag to the popped-out note window mode', () => {
    expect(resolveOkDesktopMode('note')).toBe('note');
  });

  test('falls back to editor when the flag is absent', () => {
    expect(resolveOkDesktopMode(undefined)).toBe('editor');
  });

  test('falls back to editor for an unrecognized flag value', () => {
    expect(resolveOkDesktopMode('totally-unknown')).toBe('editor');
  });
});

describe('resolveOkThemePreference', () => {
  test.each(['light', 'dark', 'system'] as const)('accepts %s', (value) => {
    expect(resolveOkThemePreference(value)).toBe(value);
  });

  test('preserves absence and defaults invalid present values to system', () => {
    expect(resolveOkThemePreference(undefined)).toBeUndefined();
    expect(resolveOkThemePreference('ultraviolet')).toBe('system');
  });
});
