import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { pathspecArgs, stripPathspecMagic, toPathspec } from './git-pathspec.ts';

const HOSTILE_NAMES = [':colon.md', ':!bang.md', 'star*.md'] as const;
const PLAIN_NAMES = ['plain.md', 'starfish.md'] as const;

let repo: string;

function git(args: readonly string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'ok-git-pathspec-'));
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  for (const name of [...HOSTILE_NAMES, ...PLAIN_NAMES]) {
    writeFileSync(join(repo, name), `${name}\n`, 'utf-8');
  }
  mkdirSync(join(repo, 'sub'), { recursive: true });
  writeFileSync(join(repo, 'sub', 'nested.md'), 'nested\n', 'utf-8');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('toPathspec', () => {
  test('prefixes the literal magic word', () => {
    expect(toPathspec('x')).toBe(':(literal)x');
    expect(toPathspec(':colon.md')).toBe(':(literal):colon.md');
  });

  test('refuses an empty path rather than widening to every tracked path', () => {
    expect(() => toPathspec('')).toThrow(/empty path/);
  });
});

describe('stripPathspecMagic', () => {
  test('round-trips a converted operand back to the path it came from', () => {
    expect(stripPathspecMagic(toPathspec(':colon.md'))).toBe(':colon.md');
  });

  test('removes the magic word git echoes back in its own message text', () => {
    expect(
      stripPathspecMagic("fatal: pathspec ':(literal)notes/plan.md' did not match any files"),
    ).toBe("fatal: pathspec 'notes/plan.md' did not match any files");
  });
});

describe('pathspecArgs', () => {
  test('owns the -- separator and converts every operand', () => {
    expect(pathspecArgs(['a', 'b'])).toEqual(['--', ':(literal)a', ':(literal)b']);
  });

  test('refuses an empty list rather than emitting an unrestricted bare separator', () => {
    expect(() => pathspecArgs([])).toThrow(/empty path list/);
  });
});

describe('real git selection', () => {
  test('a leading-colon name is staged as data, not read as magic', () => {
    git(['reset']);
    git(['add', ...pathspecArgs([':colon.md'])]);
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe(':colon.md');
  });

  test('a leading-":!" name stages itself instead of subtracting everything', () => {
    git(['reset']);
    git(['add', ...pathspecArgs([':!bang.md'])]);
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe(':!bang.md');
  });

  test('a wildcard name selects only itself', () => {
    expect(git(['ls-files', '--others', ...pathspecArgs(['star*.md'])]).trim()).toBe('star*.md');
  });

  test('an unconverted wildcard name over-matches its sibling', () => {
    expect(git(['ls-files', '--others', '--', 'star*.md']).trim().split('\n')).toEqual([
      'star*.md',
      'starfish.md',
    ]);
  });

  test('the "." scope sentinel selects the same set converted or bare', () => {
    const bare = git(['ls-files', '--others', '--', '.']);
    const converted = git(['ls-files', '--others', ...pathspecArgs(['.'])]);
    expect(converted).toBe(bare);
  });

  test('a directory operand still scopes by prefix', () => {
    expect(git(['ls-files', '--others', ...pathspecArgs(['sub'])]).trim()).toBe('sub/nested.md');
  });

  test('git echoes plain paths regardless of the operand form', () => {
    git(['reset']);
    git(['add', ...pathspecArgs([':colon.md'])]);
    expect(git(['ls-files', '--cached', ...pathspecArgs([':colon.md'])]).trim()).toBe(':colon.md');
    git(['reset']);
  });
});
