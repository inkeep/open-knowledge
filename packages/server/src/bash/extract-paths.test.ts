import { describe, expect, test } from 'vitest';
import { extractReferencedPaths } from './extract-paths.ts';
import type { Stage } from './parse-command.ts';

function stage(command: string, ...args: string[]): Stage {
  return { command, args: [command, ...args] };
}

describe('extractReferencedPaths — cat', () => {
  test('paths come from argv, stdout is content', () => {
    const stdout = '# Auth\n\nOAuth flow...\n';
    const paths = extractReferencedPaths(stdout, [stage('cat', 'articles/auth.md')]);
    expect(paths).toEqual(['articles/auth.md']);
  });

  test('multiple cat args', () => {
    const paths = extractReferencedPaths('', [stage('cat', 'a.md', 'b.mdx', 'c.txt')]);
    expect(paths).toEqual(['a.md', 'b.mdx']); // c.txt not a wiki extension
  });

  test('cat with flag args are skipped', () => {
    const paths = extractReferencedPaths('', [stage('cat', '-n', 'auth.md')]);
    expect(paths).toEqual(['auth.md']);
  });
});

describe('extractReferencedPaths — ls', () => {
  test('parent dir arg is emitted first, followed by prefixed children', () => {
    const stdout = 'auth.md\nonboarding.md\nREADME.md\n';
    const paths = extractReferencedPaths(stdout, [stage('ls', 'articles/')]);
    expect(paths).toEqual([
      'articles',
      'articles/auth.md',
      'articles/onboarding.md',
      'articles/README.md',
    ]);
  });

  test('no dir arg → no parent; paths are project-relative', () => {
    const paths = extractReferencedPaths('top.md\n', [stage('ls')]);
    expect(paths).toEqual(['top.md']);
  });

  test('`ls .` treated as no parent', () => {
    const paths = extractReferencedPaths('top.md\n', [stage('ls', '.')]);
    expect(paths).toEqual(['top.md']);
  });

  test('non-md files skipped', () => {
    const stdout = 'auth.md\nimage.png\nreadme.txt\nbook.mdx\n';
    const paths = extractReferencedPaths(stdout, [stage('ls')]);
    expect(paths).toEqual(['auth.md', 'book.mdx']);
  });
});

describe('extractReferencedPaths — grep', () => {
  test('path:line:text → path is first colon segment', () => {
    const stdout = 'articles/auth.md:3:OAuth 2.0 flow for\narticles/oauth.md:17:See auth.md for\n';
    const paths = extractReferencedPaths(stdout, [stage('grep', '-rn', 'oauth', 'articles/')]);
    expect(paths).toEqual(['articles/auth.md', 'articles/oauth.md']);
  });

  test('dedupes same path from multiple matches', () => {
    const stdout = 'file.md:1:one\nfile.md:2:two\nfile.md:3:three\n';
    const paths = extractReferencedPaths(stdout, [stage('grep', '-rn', 'x', '.')]);
    expect(paths).toEqual(['file.md']);
  });
});

describe('extractReferencedPaths — head/tail as conditional producer', () => {
  test('`head file.md` extracts the file arg like cat', () => {
    const paths = extractReferencedPaths('first ten lines...\n', [stage('head', '-5', 'auth.md')]);
    expect(paths).toEqual(['auth.md']);
  });

  test('`tail file.md` extracts the file arg like cat', () => {
    const paths = extractReferencedPaths('last ten lines...\n', [stage('tail', '-5', 'auth.md')]);
    expect(paths).toEqual(['auth.md']);
  });

  test('`cat X | head -5` keeps cat as producer (head has no file arg)', () => {
    const paths = extractReferencedPaths('5 lines of X...\n', [
      stage('cat', 'articles/auth.md'),
      stage('head', '-5'),
    ]);
    expect(paths).toEqual(['articles/auth.md']);
  });
});

describe('extractReferencedPaths — find', () => {
  test('each stdout line is a path', () => {
    const stdout = 'articles/auth.md\narticles/oauth.md\n';
    const paths = extractReferencedPaths(stdout, [stage('find', '.', '-name', '*.md')]);
    expect(paths).toEqual(['articles/auth.md', 'articles/oauth.md']);
  });

  test('./ prefix stripped', () => {
    const stdout = './articles/auth.md\n';
    const paths = extractReferencedPaths(stdout, [stage('find', '.')]);
    expect(paths).toEqual(['articles/auth.md']);
  });
});

describe('extractReferencedPaths — pipe propagation', () => {
  test('grep | head preserves grep extraction', () => {
    const stdout = 'articles/auth.md:1:oauth\n';
    const paths = extractReferencedPaths(stdout, [
      stage('grep', '-rn', 'oauth', 'articles/'),
      stage('head', '-5'),
    ]);
    expect(paths).toEqual(['articles/auth.md']);
  });

  test('cat | wc still enriches cat args', () => {
    const paths = extractReferencedPaths('   42\n', [
      stage('cat', 'articles/auth.md'),
      stage('wc', '-l'),
    ]);
    expect(paths).toEqual(['articles/auth.md']);
  });

  test('ls | sort preserves ls extraction (parent first, then children)', () => {
    const stdout = 'auth.md\nindex.md\n';
    const paths = extractReferencedPaths(stdout, [stage('ls', 'articles/'), stage('sort')]);
    expect(paths).toEqual(['articles', 'articles/auth.md', 'articles/index.md']);
  });
});

describe('extractReferencedPaths — fallback regex', () => {
  test('no producer → regex over stdout', () => {
    const stdout = 'see articles/auth.md for details, or book.mdx\n';
    const paths = extractReferencedPaths(stdout, [stage('wc', '-l')]);
    expect(paths).toContain('articles/auth.md');
    expect(paths).toContain('book.mdx');
  });

  test('ignores non-md paths', () => {
    const stdout = 'file.txt file.png file.md\n';
    const paths = extractReferencedPaths(stdout, [stage('wc', '-l')]);
    expect(paths).toEqual(['file.md']);
  });
});
