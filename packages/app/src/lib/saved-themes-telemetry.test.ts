import { describe, expect, test } from 'vitest';
import { savedThemePairState } from './saved-themes-telemetry';

describe('savedThemePairState', () => {
  test.each([
    [{ light: 'saved-day', dark: 'saved-night' }, 'different'],
    [{ light: 'saved-personal', dark: 'saved-personal' }, 'same'],
    [{ light: 'saved-day', dark: 'default' }, 'incomplete'],
    [{ light: 'dracula', dark: 'gruvbox' }, 'incomplete'],
  ] as const)('classifies %j as %s without exposing either id', (selection, expected) => {
    expect(savedThemePairState(selection)).toBe(expected);
  });
});
