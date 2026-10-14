import { afterEach, describe, expect, test, vi } from 'vitest';
import { quoteStopCommandPath, stopCommandLine } from './stop-command.ts';

describe('quoteStopCommandPath', () => {
  describe('posix', () => {
    test.each([
      ['plain', '/Users/me/notes', "'/Users/me/notes'"],
      ['space', '/Users/me/My Notes', "'/Users/me/My Notes'"],
      ['ampersand', '/Users/me/Work & Personal', "'/Users/me/Work & Personal'"],
      ['apostrophe', "/Users/bob/Bob's Notes", "'/Users/bob/Bob'\\''s Notes'"],
      ['dollar', '/Users/me/$HOME-ish', "'/Users/me/$HOME-ish'"],
      ['backtick', '/Users/me/`whoami`', "'/Users/me/`whoami`'"],
    ])('%s', (_label, input, expected) => {
      expect(quoteStopCommandPath(input, 'darwin')).toBe(expected);
    });

    test('linux quotes identically to darwin', () => {
      const p = "/srv/Bob's & Co/notes";
      expect(quoteStopCommandPath(p, 'linux')).toBe(quoteStopCommandPath(p, 'darwin'));
    });
  });

  describe('win32', () => {
    test.each([
      ['plain', 'C:\\Users\\me\\notes'],
      ['space', 'C:\\Users\\First Last\\notes'],
      ['ampersand', 'C:\\Users\\me\\Work & Personal'],
      ['apostrophe', "C:\\Users\\O'Brien\\notes"],
    ])('%s wraps in double quotes with nothing escaped', (_label, input) => {
      expect(quoteStopCommandPath(input, 'win32')).toBe(`"${input}"`);
    });

    test.each([
      ['drive root', 'C:\\', '"C:\\\\"'],
      ['trailing backslash', 'C:\\Users\\me\\notes\\', '"C:\\Users\\me\\notes\\\\"'],
      ['two trailing', 'C:\\a\\\\', '"C:\\a\\\\\\\\"'],
      ['interior only', 'C:\\a\\b', '"C:\\a\\b"'],
    ])('%s doubles only a trailing backslash run', (_label, input, expected) => {
      expect(quoteStopCommandPath(input, 'win32')).toBe(expected);
    });
  });
});

describe('stopCommandLine', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('keeps the Stable command byte-identical', () => {
    vi.stubEnv('OK_CHANNEL', 'stable');
    expect(stopCommandLine("/Users/bob/Bob's Notes", 'darwin')).toBe(
      "ok stop '/Users/bob/Bob'\\''s Notes'",
    );
    expect(stopCommandLine('C:\\notes\\', 'win32', { force: true })).toBe(
      'ok stop --force "C:\\notes\\\\"',
    );
  });

  test('names the Beta command on Beta', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    expect(stopCommandLine('/Users/me/notes', 'darwin')).toBe("ok-beta stop '/Users/me/notes'");
    expect(stopCommandLine('/Users/me/notes', 'linux', { force: true })).toBe(
      "ok-beta stop --force '/Users/me/notes'",
    );
  });
});
