import { describe, expect, test } from 'vitest';
import { quoteStopCommandPath } from './stop-command.ts';

describe('quoteStopCommandPath', () => {
  // The two shapes that make an unquoted paste fail, and fail differently: an
  // apostrophe strands the user at a continuation prompt, and an ampersand
  // truncates the path, runs against the wrong lock dir, and reports success.
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

    // The property the table encodes: whatever a POSIX shell does to this
    // string, the argument that reaches `ok stop` is the path we started with.
    test('linux quotes identically to darwin', () => {
      const p = "/srv/Bob's & Co/notes";
      expect(quoteStopCommandPath(p, 'linux')).toBe(quoteStopCommandPath(p, 'darwin'));
    });
  });

  describe('win32', () => {
    // Single quotes are not a grouping character in `cmd.exe`, so POSIX quoting
    // here would survive into the argument verbatim and resolve to a path that
    // does not exist — reported as "no running processes" at exit 0, on the
    // project the user is looking at, by the command the app just gave them.
    test.each([
      ['plain', 'C:\\Users\\me\\notes'],
      ['space', 'C:\\Users\\First Last\\notes'],
      ['ampersand', 'C:\\Users\\me\\Work & Personal'],
      ['apostrophe', "C:\\Users\\O'Brien\\notes"],
    ])('%s wraps in double quotes with nothing escaped', (_label, input) => {
      expect(quoteStopCommandPath(input, 'win32')).toBe(`"${input}"`);
    });

    // A drive root is a supported project location — `folder-admission.ts`
    // warns on `C:\` and admits it — and it is the reachable case where the
    // receiving parser, not the shell, mangles the argument: an odd run of
    // backslashes before the closing quote yields a literal `"` and leaves
    // quote mode on, so `"C:\"` arrives as `C:"`.
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
