import { beforeEach, describe, expect, test, vi } from 'vitest';

const tokenize = vi.fn();
vi.mock('./code-highlighter-impl', () => ({ tokenize }));

const { codeHighlighter } = await import('./code-highlighter');

const RESULT = { tokens: [], fg: '#000', bg: '#fff' };

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  tokenize.mockReset();
  tokenize.mockResolvedValue(RESULT);
});

describe('codeHighlighter facade', () => {
  test('canonicalizes fence aliases onto the loaded grammars', async () => {
    const callback = vi.fn();
    codeHighlighter.highlight(
      { code: 'const a = 1;', language: 'ts', themes: ['ok-syntax', 'ok-syntax'] },
      callback,
    );
    await flush();
    expect(tokenize).toHaveBeenCalledWith('const a = 1;', 'tsx');
    expect(callback).toHaveBeenCalledWith(RESULT);
  });

  test('an unknown language tokenizes as plain text', async () => {
    codeHighlighter.highlight(
      { code: 'hello', language: 'brainfuck', themes: ['ok-syntax', 'ok-syntax'] },
      vi.fn(),
    );
    await flush();
    expect(tokenize).toHaveBeenCalledWith('hello', 'text');
  });

  test('first call returns null then delivers via callback; second call hits the cache', async () => {
    const callback = vi.fn();
    const options = {
      code: 'print("hi")',
      language: 'python',
      themes: ['ok-syntax', 'ok-syntax'],
    } as Parameters<typeof codeHighlighter.highlight>[0];
    expect(codeHighlighter.highlight(options, callback)).toBeNull();
    await flush();
    expect(callback).toHaveBeenCalledWith(RESULT);
    tokenize.mockClear();
    expect(codeHighlighter.highlight(options, vi.fn())).toEqual(RESULT);
    expect(tokenize).not.toHaveBeenCalled();
  });

  test('a tokenize failure is not cached — the next call retries and succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tokenize.mockRejectedValueOnce(new Error('transient'));
    const failed = vi.fn();
    const options = {
      code: 'SELECT 1;',
      language: 'sql',
      themes: ['ok-syntax', 'ok-syntax'],
    } as Parameters<typeof codeHighlighter.highlight>[0];
    expect(codeHighlighter.highlight(options, failed)).toBeNull();
    await flush();
    expect(failed).not.toHaveBeenCalled();

    const retried = vi.fn();
    expect(codeHighlighter.highlight(options, retried)).toBeNull();
    await flush();
    expect(retried).toHaveBeenCalledWith(RESULT);
    warn.mockRestore();
  });

  test('two same-key calls before resolution each get exactly one delivery', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const options = {
      code: 'SELECT 2;',
      language: 'sql',
      themes: ['ok-syntax', 'ok-syntax'],
    } as Parameters<typeof codeHighlighter.highlight>[0];
    expect(codeHighlighter.highlight(options, first)).toBeNull();
    expect(codeHighlighter.highlight(options, second)).toBeNull();
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(RESULT);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(RESULT);
  });

  test('cache eviction drops the oldest entries, not the whole cache', async () => {
    const themes = ['ok-syntax', 'ok-syntax'] as Parameters<
      typeof codeHighlighter.highlight
    >[0]['themes'];
    const opts = (i: number) =>
      ({ code: `entry-${i}`, language: 'json', themes }) as Parameters<
        typeof codeHighlighter.highlight
      >[0];
    for (let i = 0; i < 401; i++) {
      codeHighlighter.highlight(opts(i), vi.fn());
      await flush();
    }
    tokenize.mockClear();
    expect(codeHighlighter.highlight(opts(400), vi.fn())).toEqual(RESULT);
    expect(tokenize).not.toHaveBeenCalled();
    expect(codeHighlighter.highlight(opts(0), vi.fn())).toBeNull();
  });
});
