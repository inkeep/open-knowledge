import { beforeEach, describe, expect, test, vi } from 'vitest';

// Mock shiki's core so init failure is scriptable; the grammar/theme module
// imports stay real (inert data under a mocked factory).
const createHighlighterCore = vi.fn();
vi.mock('shiki/core', () => ({ createHighlighterCore }));
vi.mock('shiki/engine/javascript', () => ({ createJavaScriptRegexEngine: () => ({}) }));

const { tokenize } = await import('./code-highlighter-impl');

const TOKENS = { tokens: [], fg: '#000', bg: '#fff' };

// One shared fake: the impl caches its highlighter as module state, so every
// test after the first successful init observes this same instance.
const highlighter = {
  getLoadedLanguages: () => ['tsx', 'json'],
  codeToTokens: vi.fn(() => TOKENS),
};

beforeEach(() => {
  highlighter.codeToTokens.mockClear();
});

describe('tokenize', () => {
  test('a rejected highlighter init is retried on the next call, not cached forever', async () => {
    createHighlighterCore
      .mockRejectedValueOnce(new Error('transient init failure'))
      .mockResolvedValue(highlighter);

    await expect(tokenize('const a = 1;', 'tsx')).rejects.toThrow('transient init failure');
    // The singleton must have reset — this call re-creates and succeeds.
    await expect(tokenize('const a = 1;', 'tsx')).resolves.toEqual(TOKENS);
    expect(createHighlighterCore).toHaveBeenCalledTimes(2);
  });

  test('reuses the singleton across calls once created', async () => {
    createHighlighterCore.mockClear();
    await expect(tokenize('{}', 'json')).resolves.toEqual(TOKENS);
    expect(createHighlighterCore).not.toHaveBeenCalled();
    expect(highlighter.codeToTokens).toHaveBeenCalledWith('{}', {
      lang: 'json',
      themes: { light: 'github-light', dark: 'github-dark' },
    });
  });

  test('an unloaded language falls back to plain text', async () => {
    await tokenize('body {}', 'not-loaded');
    expect(highlighter.codeToTokens).toHaveBeenCalledWith('body {}', {
      lang: 'text',
      themes: { light: 'github-light', dark: 'github-dark' },
    });
  });
});
