import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashInstance, execBash, StdoutOverflowError, shellEscape } from './index.ts';

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

describe('just-bash + ReadWriteFs (per-call cwd)', () => {
  let root: string;

  beforeAll(() => {
    root = join(tmpdir(), `bash-test-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'file.txt'), 'hello\nworld\n');
    writeFileSync(join(root, 'sub', 'nested.md'), 'nested content\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('ReadWriteFs sandbox boundary', () => {
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

    // Subdirectory reads/lists: the exact operations that broke on Windows
    // before just-bash 2.14.3. Its sandbox-containment gate (isPathWithinRoot)
    // hardcoded the POSIX `/` separator, so backslash-separated real paths below
    // the root were rejected and `cat sub/x` / `ls sub` returned "No such file or
    // directory" (upstream fix: vercel-labs/just-bash#187). Passes on POSIX either
    // way; documents the sub-path contract and guards a Windows regression.
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
