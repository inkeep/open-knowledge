import { describe, expect, test } from 'vitest';
import { hasValidPromptInput } from './has-valid-prompt-input';

describe('hasValidPromptInput', () => {
  test('empty instruction, no mentions, no selection -> false', () => {
    expect(hasValidPromptInput('', [], false)).toBe(false);
  });

  test('whitespace-only instruction is not intent', () => {
    expect(hasValidPromptInput('   \n\t  ', [], false)).toBe(false);
  });

  test('a non-empty trimmed instruction is intent', () => {
    expect(hasValidPromptInput('build a wiki', [], false)).toBe(true);
  });

  test('leading/trailing whitespace around real text still counts', () => {
    expect(hasValidPromptInput('  build a wiki  ', [], false)).toBe(true);
  });

  test('a mention alone is intent (empty instruction)', () => {
    expect(hasValidPromptInput('', ['notes/structure.md'], false)).toBe(true);
  });

  test('a selection alone is intent (empty instruction, no mentions)', () => {
    expect(hasValidPromptInput('', [], true)).toBe(true);
  });

  test('any single signal present yields true', () => {
    expect(hasValidPromptInput('draft', ['a.md'], true)).toBe(true);
  });
});
