import { beforeEach, describe, expect, test, vi } from 'vitest';

const TOKENS = { tokens: [], fg: '#000', bg: '#fff' };

const highlighter = {
  getLoadedLanguages: () => ['tsx', 'json'],
  codeToTokens: vi.fn(() => TOKENS),
};

const createHighlighterCore = vi.fn(async () => highlighter);
vi.mock('shiki/core', () => ({ createHighlighterCore }));
vi.mock('shiki/engine/javascript', () => ({ createJavaScriptRegexEngine: () => ({}) }));

beforeEach(() => {
  vi.resetModules();
  createHighlighterCore.mockReset();
  highlighter.codeToTokens.mockClear();
});

describe('tokenize', () => {
  test('a rejected highlighter init is retried on the next call, not cached forever', async () => {
    const { tokenize } = await import('./code-highlighter-impl');
    createHighlighterCore
      .mockRejectedValueOnce(new Error('transient init failure'))
      .mockResolvedValue(highlighter);

    await expect(tokenize('const a = 1;', 'tsx')).rejects.toThrow('transient init failure');
    await expect(tokenize('const a = 1;', 'tsx')).resolves.toEqual(TOKENS);
    expect(createHighlighterCore).toHaveBeenCalledTimes(2);
  });

  test('reuses the singleton across calls once created', async () => {
    const { tokenize } = await import('./code-highlighter-impl');
    await tokenize('const a = 1;', 'tsx');
    createHighlighterCore.mockClear();
    await expect(tokenize('{}', 'json')).resolves.toEqual(TOKENS);
    expect(createHighlighterCore).not.toHaveBeenCalled();
    expect(highlighter.codeToTokens).toHaveBeenCalledWith('{}', {
      lang: 'json',
      theme: 'ok-syntax',
    });
  });

  test('an unloaded language falls back to plain text', async () => {
    const { tokenize } = await import('./code-highlighter-impl');
    await tokenize('body {}', 'not-loaded');
    expect(highlighter.codeToTokens).toHaveBeenCalledWith('body {}', {
      lang: 'text',
      theme: 'ok-syntax',
    });
  });
});
