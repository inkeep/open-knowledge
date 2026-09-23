import * as fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { formatShellCommand, revealHiddenCharacters } from './shell-command-format';

const texts = (command: string): string[] => formatShellCommand(command).map((line) => line.text);

describe('formatShellCommand', () => {
  test('puts each statement of the reported command on its own line', () => {
    const command =
      'ps -p 51625 -o pid,command 2>/dev/null | tail -n +1; echo "----curl----"; curl -s -o /dev/null -w "%{http_code}\\n" --max-time 5 http://localhost:5173/ 2>&1 || echo "curl failed"';
    const lines = texts(command);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toContain('ps -p 51625');
    expect(lines.some((line) => line.startsWith('echo "----curl----"'))).toBe(true);
  });

  test('never splits on an operator inside quotes', () => {
    expect(texts('echo "a; b && c || d | e"')).toEqual(['echo "a; b && c || d | e"']);
    expect(texts("echo 'a; b && c'")).toEqual(["echo 'a; b && c'"]);
  });

  test('never splits inside a command substitution', () => {
    expect(texts('echo "$(ls; pwd)"')).toEqual(['echo "$(ls; pwd)"']);
    expect(texts('x=$(a && b); echo done')).toEqual(['x=$(a && b);', 'echo done']);
  });

  test('a backtick substitution closes, so the statements after it still split', () => {
    expect(texts('echo `date`; ls && pwd')).toEqual(['echo `date`;', 'ls &&', 'pwd']);
    expect(texts('echo `a; b`; c')).toEqual(['echo `a; b`;', 'c']);
  });

  test('never splits inside a parameter expansion', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template placeholder
    expect(texts('x=${y:-a;b}; z')).toEqual(['x=${y:-a;b};', 'z']);
  });

  test('a backslash inside single quotes is literal, so the quote still closes', () => {
    expect(texts("echo 'C:\\'; ls")).toEqual(["echo 'C:\\';", 'ls']);
  });

  test('only spaces and tabs are trimmed, never characters bash reads as part of a word', () => {
    expect(texts('a;\u00a0b; c\ufeff')).toEqual(['a;', '\u00a0b;', 'c\ufeff']);
  });

  test('laying a command out never drops or invents a character', () => {
    const shellish = fc.string({
      unit: fc.constantFrom(
        'a',
        'b',
        ' ',
        '\t',
        '\n',
        ';',
        '&',
        '|',
        '#',
        '"',
        "'",
        '\\',
        '`',
        '$',
        '(',
        ')',
        '{',
        '}',
        '<',
        '>',
        '\u00a0',
        '\u200b',
        '\ufeff',
      ),
      maxLength: 60,
    });
    const ink = (text: string): string => text.replace(/[ \t\n]/g, '');
    fc.assert(
      fc.property(shellish, (command) => {
        const lines = formatShellCommand(command).map((line) => line.text);
        expect(ink(lines.join('\n'))).toBe(ink(command));
      }),
    );
  });

  test('an escaped operator stays part of its statement', () => {
    expect(texts('echo a\\; b')).toEqual(['echo a\\; b']);
  });

  test('keeps the operator on the line it terminates', () => {
    expect(texts('one && two')).toEqual(['one &&', 'two']);
    expect(texts('one || two')).toEqual(['one ||', 'two']);
    expect(texts('one; two')).toEqual(['one;', 'two']);
  });

  test('preserves newlines the command already carried', () => {
    expect(texts('first\nsecond')).toEqual(['first', 'second']);
  });

  test('a command that already spans lines is shown as written, indentation and all', () => {
    const heredoc = "python3 - <<'EOF'\nfor x in y:\n    print(x); done()\nEOF";
    expect(texts(heredoc)).toEqual([
      "python3 - <<'EOF'",
      'for x in y:',
      '    print(x); done()',
      'EOF',
    ]);
    expect(texts(heredoc).join('\n')).toBe(heredoc);
    expect(texts('cd repo && make\nmake test')).toEqual(['cd repo && make', 'make test']);
  });

  test('a one-line command with a trailing newline is still laid out statement by statement', () => {
    expect(texts('one && two\n')).toEqual(['one &&', 'two']);
  });

  test('a comment is never split into statements', () => {
    expect(texts("ls # it's fine; rm -rf ~")).toEqual(["ls # it's fine; rm -rf ~"]);
    expect(texts('make; # build it && ship')).toEqual(['make;', '# build it && ship']);
    expect(texts('echo a#b; ls')).toEqual(['echo a#b;', 'ls']);
  });

  test('leaves a short pipeline alone and wraps a long one as a continuation', () => {
    expect(texts('ls | wc -l')).toEqual(['ls | wc -l']);

    const long = `${'echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'} | wc -l`;
    const lines = formatShellCommand(long);
    expect(lines.length).toBe(2);
    expect(lines[1]?.continuation).toBe(true);
  });

  test('reassembling the lines gives back the exact command', () => {
    for (const command of [
      'ps -p 1 -o pid,command 2>/dev/null | tail -n +1; echo "----"; curl -s http://x/ || echo no',
      'echo "a; b" && ls',
      'x=$(a && b); echo done',
    ]) {
      expect(texts(command).join(' ')).toBe(command);
    }
    expect(texts('first\n  second').join('\n')).toBe('first\n  second');
  });

  test('an empty or whitespace command yields no lines', () => {
    expect(formatShellCommand('')).toEqual([]);
    expect(formatShellCommand('   \n  ')).toEqual([]);
  });
});

describe('revealHiddenCharacters', () => {
  test('marks every character that would draw as nothing or reorder the line', () => {
    expect(revealHiddenCharacters('echo safe\u202e; rm -rf ~')).toBe('echo safe⟨U+202E⟩; rm -rf ~');
    expect(revealHiddenCharacters('rm\u200b -rf')).toBe('rm⟨U+200B⟩ -rf');
    expect(revealHiddenCharacters('ls\r')).toBe('ls⟨U+000D⟩');
    expect(revealHiddenCharacters('a\u2028b')).toBe('a⟨U+2028⟩b');
    expect(revealHiddenCharacters('tag\u{e0041}')).toBe('tag⟨U+E0041⟩');
  });

  test('leaves ordinary text, tabs and newlines alone', () => {
    const plain = "grep -n 'x'\tfile\nnext — café 日本";
    expect(revealHiddenCharacters(plain)).toBe(plain);
  });
});
