import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBashInstance,
  erofsTarget,
  execBash,
  StdoutOverflowError,
  shellEscape,
} from './index.ts';

describe('erofsTarget', () => {
  it('names the file from the engine refusal', () => {
    expect(
      erofsTarget("write: EROFS: read-only file system, open '/home/user/project/a.md'"),
    ).toEqual({
      blocked: true,
      target: 'a.md',
    });
  });

  it('reports a refusal the engine did not attach a file to', () => {
    expect(erofsTarget("sort: EROFS: read-only file system, write '<path>'")).toEqual({
      blocked: true,
      target: null,
    });
  });

  it('is not fooled by a read failure whose path contains EROFS', () => {
    expect(erofsTarget("cat: ENOENT: no such file or directory, open 'missing-EROFS.md'")).toEqual({
      blocked: false,
    });
  });
});

describe('shellEscape', () => {
  it('leaves safe characters alone', () => {
    expect(shellEscape('articles/auth/sso.md')).toBe('articles/auth/sso.md');
  });

  it('wraps unsafe characters in single quotes', () => {
    expect(shellEscape('hello world')).toBe("'hello world'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it('handles empty string', () => {
    expect(shellEscape('')).toBe("''");
  });
});

describe('just-bash + OverlayFs (per-call cwd)', () => {
  let root: string;

  beforeAll(() => {
    root = join(tmpdir(), `bash-test-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'file.txt'), 'hello\nworld\n');
    writeFileSync(join(root, 'sub', 'nested.md'), 'nested content\n');
    writeFileSync(join(root, 'zero-width.txt'), 'foo\n');
    writeFileSync(join(root, 'adjacent-zero-width.txt'), 'afoo\nar\n');
    writeFileSync(
      join(root, 'patterns.txt'),
      'Request\nrequest\nbar\na.b\nx*y\na|b\nother\nfoobar\nbarfoo\n',
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('OverlayFs sandbox boundary', () => {
    it('rejects path traversal via `..`', async () => {
      const bash = createBashInstance(root);
      const result = await execBash(bash, 'cat ../outside.txt');
      expect(result.stdout).not.toContain('SECRET');
      expect(result.exitCode).not.toBe(0);
    });

    it('does not leak the host /etc/passwd (absolute paths resolve inside sandbox)', async () => {
      const bash = createBashInstance(root);
      const result = await execBash(bash, 'cat /etc/passwd');
      expect(result.stdout).not.toContain('root:');
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('cwd semantics', () => {
    it('relative paths resolve against the provided cwd', async () => {
      const bash = createBashInstance(root);
      const result = await execBash(bash, 'cat file.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello\nworld\n');
    });

    it('ls lists the cwd contents', async () => {
      const bash = createBashInstance(root);
      const result = await execBash(bash, 'ls');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('file.txt');
      expect(result.stdout).toContain('sub');
    });

    it('reads a file inside a subdirectory', async () => {
      const bash = createBashInstance(root);
      const result = await execBash(bash, 'cat sub/nested.md');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('nested content\n');
    });

    it('lists a subdirectory', async () => {
      const bash = createBashInstance(root);
      const result = await execBash(bash, 'ls sub');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('nested.md');
    });

    it('supports pipes between stages', async () => {
      const bash = createBashInstance(root);
      writeFileSync(join(root, 'many.txt'), 'one\ntwo\nthree\nfour\nfive\n');
      const result = await execBash(bash, "grep -n '' many.txt | head -2");
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split('\n').filter(Boolean);
      expect(lines.length).toBe(2);
    });

    it('throws when cwd is not an absolute path', () => {
      expect(() => createBashInstance('relative/path')).toThrow(/cwd must be absolute/);
    });
  });

  describe('grep pattern alternatives', () => {
    it.each([
      ['-c -e Request -e dominance', '1\n', 0],
      ['-c -e dominance -e Request', '1\n', 0],
      ['-n -e Request -e bar', '1:Request\n3:bar\n8:foobar\n9:barfoo\n', 0],
      ["-F -e 'a.b' -e 'x*y' -e 'a|b'", 'a.b\nx*y\na|b\n', 0],
      ['-x -e Request -e bar', 'Request\nbar\n', 0],
      ["-e '^Request$' -e '^bar$'", 'Request\nbar\n', 0],
      ["-P -o -e 'Re\\Kquest' -e 'ba\\Kr'", 'quest\nr\nr\nr\n', 0],
      ["-P -e '(?<word>Request)' -e '(?<word>bar)'", 'Request\nbar\nfoobar\nbarfoo\n', 0],
      ['-o -e foo -e bar', 'bar\nfoo\nbar\nbar\nfoo\n', 0],
      ['-o -e foo -e foobar', 'foobar\nfoo\n', 0],
      ['-o -e foobar -e foo', 'foobar\nfoo\n', 0],
      ['-w -e Request -e bar', 'Request\nbar\n', 0],
      ["-c -e '^' -e missing", '9\n', 0],
      ["-q -e '' -e missing", '', 0],
      ['-E -x -e Request -e bar', 'Request\nbar\n', 0],
      ['-F -x -e Request -e bar', 'Request\nbar\n', 0],
      ['-i -x -e Request -e bar', 'Request\nrequest\nbar\n', 0],
      ['-v -x -e Request -e bar', 'request\na.b\nx*y\na|b\nother\nfoobar\nbarfoo\n', 0],
      ['-q -e Request -e dominance', '', 0],
      ['-q -e missing -e dominance', '', 1],
      ['-c -e missing -e dominance', '0\n', 1],
      ['-e missing -e dominance', '', 1],
      ["-e Request -e ''", 'Request\nrequest\nbar\na.b\nx*y\na|b\nother\nfoobar\nbarfoo\n', 0],
    ])('OR-combines patterns for grep %s', async (flags, stdout, exitCode) => {
      const result = await execBash(createBashInstance(root), `grep ${flags} patterns.txt`);
      expect(result).toEqual({ stdout, stderr: '', exitCode });
    });

    it.each([
      ["-x 'Request\nbar'", 'Request\nbar\n'],
      ["-x -e 'Request\nbar'", 'Request\nbar\n'],
      ["-x -e 'Request\nbar' -e dominance", 'Request\nbar\n'],
      ["-e 'missing\n'", 'Request\nrequest\nbar\na.b\nx*y\na|b\nother\nfoobar\nbarfoo\n'],
    ])('splits newline-separated pattern operands for grep %s', async (patterns, stdout) => {
      const result = await execBash(createBashInstance(root), `grep ${patterns} patterns.txt`);
      expect(result).toEqual({ stdout, stderr: '', exitCode: 0 });
    });

    it.each(["-e '\\(' -e '\\)'", "-e '^\\(a\\)\\1$'", "-e '^\\(a\\)\\1$' -e '^\\(b\\)\\1$'"])(
      'rejects invalid or unsupported individual patterns: %s',
      async (flags) => {
        const result = await execBash(createBashInstance(root), `grep ${flags} patterns.txt`);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('grep: invalid regular expression:');
      },
    );

    it.each([
      ["-o -e '' -e foo", 'foo\n\n'],
      ["-o -e foo -e 'q*'", 'foo\n\n'],
      ["-o -e 'x*' -e foo", 'foo\n\n'],
      ["-Eo -e 'a?' -e foo", 'foo\n\n'],
      ["-co -e foo -e 'q*'", '2\n'],
      ["-o -e '' -e ''", '\n\n\n\n'],
      ["-o -e '$' -e '$'", '\n'],
      ["-o -e '^' -e '^'", '\n'],
    ])('finishes a zero-width global scan for grep %s', async (flags, stdout) => {
      const result = await execBash(createBashInstance(root), `grep ${flags} zero-width.txt`);
      expect(result).toEqual({ stdout, stderr: '', exitCode: 0 });
    });

    it.each(["-e foo -e '\\('", "-e '\\(' -e foo"])(
      'names only the invalid pattern for grep %s',
      async (flags) => {
        const result = await execBash(createBashInstance(root), `grep ${flags} patterns.txt`);
        expect(result).toEqual({
          stdout: '',
          stderr: 'grep: invalid regular expression: \\(\n',
          exitCode: 2,
        });
      },
    );

    it.each([
      ["-o -e 'x*' -e foo -e r", '\nfoo\n\n\nr\n\n'],
      ["-o -e foo -e r -e 'x*'", '\nfoo\n\n\nr\n\n'],
      ["-co -e 'x*' -e foo -e r", '6\n'],
      ["-o -e '^' -e foo -e r", '\nfoo\n\nr\n'],
      ["-i -o -e 'x*' -e FOO -e R", '\nfoo\n\n\nr\n\n'],
      ["-P -o -e 'x*' -e 'f\\Koo' -e r", '\noo\n\n\nr\n\n'],
    ])('keeps a match that follows an empty match for grep %s', async (flags, stdout) => {
      const result = await execBash(
        createBashInstance(root),
        `grep ${flags} adjacent-zero-width.txt`,
      );
      expect(result).toEqual({ stdout, stderr: '', exitCode: 0 });
    });

    it('matches every pattern from piped input', async () => {
      const result = await execBash(
        createBashInstance(root),
        'cat patterns.txt | grep -x -e Request -e bar',
      );
      expect(result).toEqual({ stdout: 'Request\nbar\n', stderr: '', exitCode: 0 });
    });

    it('keeps file operands before explicit patterns', async () => {
      const result = await execBash(
        createBashInstance(root),
        'grep patterns.txt -x -e Request -e bar',
      );
      expect(result).toEqual({ stdout: 'Request\nbar\n', stderr: '', exitCode: 0 });
    });
  });

  describe('StdoutOverflowError', () => {
    it('is exported and carries limit/actual/partial', () => {
      const err = new StdoutOverflowError(10, 20, { stdout: 'abc', stderr: '', exitCode: 0 });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('StdoutOverflowError');
      expect(err.limitBytes).toBe(10);
      expect(err.actualBytes).toBe(20);
      expect(err.partial.stdout).toBe('abc');
    });
  });
});
