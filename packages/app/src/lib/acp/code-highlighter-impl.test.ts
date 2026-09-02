import { beforeEach, describe, expect, test, vi } from 'vitest';

const createHighlighterCore = vi.fn();
vi.mock('shiki/core', () => ({ createHighlighterCore }));
vi.mock('shiki/engine/javascript', () => ({ createJavaScriptRegexEngine: () => ({}) }));

const { tokenize } = await import('./code-highlighter-impl');

const TOKENS = { tokens: [], fg: '#000', bg: '#fff' };

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
    await expect(tokenize('const a = 1;', 'tsx')).resolves.toEqual(TOKENS);
    expect(createHighlighterCore).toHaveBeenCalledTimes(2);
  });

  test('reuses the singleton across calls once created', async () => {
    createHighlighterCore.mockClear();
    await expect(tokenize('{}', 'json')).resolves.toEqual(TOKENS);
    expect(createHighlighterCore).not.toHaveBeenCalled();
    expect(highlighter.codeToTokens).toHaveBeenCalledWith('{}', {
      lang: 'json',
      theme: 'ok-syntax',
    });
  });

  test('an unloaded language falls back to plain text', async () => {
    await tokenize('body {}', 'not-loaded');
    expect(highlighter.codeToTokens).toHaveBeenCalledWith('body {}', {
      lang: 'text',
      theme: 'ok-syntax',
    });
  });
});
