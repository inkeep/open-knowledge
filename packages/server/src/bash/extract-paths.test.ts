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
    expect(paths).toEqual(['a.md', 'b.mdx']);
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

  test('several directories: each `dir:` header prefixes the entries under it', () => {
    const stdout = 'docs:\napi.md\nauth.md\n\nspecs:\none.md\n';
    const paths = extractReferencedPaths(stdout, [stage('ls', 'docs', 'specs')]);
    expect(paths).toEqual(['docs', 'docs/api.md', 'docs/auth.md', 'specs', 'specs/one.md']);
  });

  test('a file and a directory: the file is bare, the directory section is prefixed', () => {
    const stdout = 'README.md\n\nspecs:\none.md\n';
    const paths = extractReferencedPaths(stdout, [stage('ls', 'README.md', 'specs')]);
    expect(paths).toEqual(['README.md', 'specs', 'specs/one.md']);
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

describe('extractReferencedPaths — grep filename-only flags', () => {
  test('grep -l reports the files it named, not every file it searched', () => {
    const paths = extractReferencedPaths('specs/one.md\n', [
      stage('grep', '-l', 'alpha', 'specs/one.md', 'specs/two.md'),
    ]);
    expect(paths).toEqual(['specs/one.md']);
  });

  test('grep -L reports the files without a match', () => {
    const paths = extractReferencedPaths('specs/two.md\n', [
      stage('grep', '-L', 'alpha', 'specs/one.md', 'specs/two.md'),
    ]);
    expect(paths).toEqual(['specs/two.md']);
  });

  test('grep -l with no match reports nothing', () => {
    const paths = extractReferencedPaths('', [
      stage('grep', '-l', 'alpha', 'specs/one.md', 'specs/two.md'),
    ]);
    expect(paths).toEqual([]);
  });

  test('single-file grep reports the file it read', () => {
    const paths = extractReferencedPaths('alpha beta\n', [stage('grep', 'alpha', 'README.md')]);
    expect(paths).toEqual(['README.md']);
  });
});

describe('extractReferencedPaths — long listing', () => {
  test('ls -l reads the name field and skips the total line', () => {
    const stdout = [
      'total 8',
      '-rw-r--r--  1 user user  3132 Sep  1 12:47 README.md',
      'drwxr-xr-x  2 user user    64 Sep  1 12:47 specs',
      '-rw-r--r--  1 user user   100 Sep  1 12:47 my  notes.md',
      '',
    ].join('\n');
    expect(extractReferencedPaths(stdout, [stage('ls', '-l')])).toEqual([
      'README.md',
      'specs',
      'my  notes.md',
    ]);
  });
});

describe('extractReferencedPaths — operand commands', () => {
  test.each(['sort', 'uniq', 'cut', 'wc'])('%s reports its operand, not its output', (cmd) => {
    const paths = extractReferencedPaths('prose with other.md inside\n', [stage(cmd, 'notes.md')]);
    expect(paths).toEqual(['notes.md']);
  });

  test('a non-wiki operand does not hijack the producer', () => {
    const paths = extractReferencedPaths('alpha beta\n', [
      stage('cat', 'README.md'),
      stage('sort', 'plain.txt'),
    ]);
    expect(paths).toEqual(['README.md']);
  });
});

describe('extractReferencedPaths — grep reads flags through the argv model', () => {
  test('a pattern supplied with -e is not read as a flag', () => {
    const paths = extractReferencedPaths('the -l flag lists files\n', [
      stage('grep', '-e', '-l', 'notes.md'),
    ]);
    expect(paths).toEqual(['notes.md']);
  });

  test('a pattern after -- is not read as a flag', () => {
    const paths = extractReferencedPaths('the -l flag lists files\n', [
      stage('grep', '--', '-l', 'notes.md'),
    ]);
    expect(paths).toEqual(['notes.md']);
  });

  test('single-file grep is not split on a colon inside a matched line', () => {
    const paths = extractReferencedPaths('specs/two.md: see also\n', [
      stage('grep', 'see also', 'README.md'),
    ]);
    expect(paths).toEqual(['README.md']);
  });

  test('an ambiguous multi-operand grep with no match reports nothing', () => {
    expect(extractReferencedPaths('', [stage('grep', 'nomatch', 'a.md', 'b.md')])).toEqual([]);
  });
});

describe('extractReferencedPaths — pins for the sibling one-liners', () => {
  test('ls -a drops the dot entries from the raw listing', () => {
    const stdout = '.\n..\n.git\nREADME.md\nspecs\n';
    expect(extractReferencedPaths(stdout, [stage('ls', '-a')])).toEqual(['README.md', 'specs']);
  });

  test('a non-wiki operand does not elect head as producer', () => {
    const paths = extractReferencedPaths('content\n', [
      stage('cat', 'auth.md'),
      stage('head', 'plain.txt'),
    ]);
    expect(paths).toEqual(['auth.md']);
  });

  test('the fallback regex matches an uppercase extension', () => {
    expect(extractReferencedPaths('see NOTES.MD for background\n', [stage('wc', '-l')])).toEqual([
      'NOTES.MD',
    ]);
  });
});

describe('extractReferencedPaths — grep counts only the files it searches', () => {
  test('a -f pattern file is not a searched file', () => {
    const paths = extractReferencedPaths('specs/two.md: see also\n', [
      stage('grep', '-f', 'needles.md', 'notes.md'),
    ]);
    expect(paths).toEqual(['notes.md']);
  });

  test('grep -h suppresses filename prefixing even with multiple operands', () => {
    const paths = extractReferencedPaths('specs/two.md: see also\n', [
      stage('grep', '-h', 'see also', 'README.md', 'specs/two.md'),
    ]);
    expect(paths).toEqual(['README.md', 'specs/two.md']);
  });

  test('a digit-bearing bundle still counts as recursive', () => {
    const stdout = 'specs/one.md:12:alpha\nspecs/one.md-13-see other.md\n';
    expect(extractReferencedPaths(stdout, [stage('grep', '-rA3', 'alpha', '.')])).toEqual([
      'specs/one.md',
    ]);
  });

  test('a digit-bearing bundle still suppresses filename prefixing', () => {
    const paths = extractReferencedPaths('specs/two.md: see also\n', [
      stage('grep', '-hA3', 'see also', 'README.md', 'specs/two.md'),
    ]);
    expect(paths).toEqual(['README.md', 'specs/two.md']);
  });

  test('a grep with only an output-shaping flag defers to the upstream producer', () => {
    const paths = extractReferencedPaths('specs/two.md: see also\n', [
      stage('cat', 'README.md'),
      stage('grep', '-l', 'also'),
    ]);
    expect(paths).toEqual(['README.md']);
  });

  test('a recursive grep with no search operand reads stdin and defers upstream', () => {
    const paths = extractReferencedPaths('specs/two.md: see also\n', [
      stage('cat', 'README.md'),
      stage('grep', '-r', 'also'),
    ]);
    expect(paths).toEqual(['README.md']);
  });

  test('a bare dash operand is stdin, not a searched file', () => {
    const paths = extractReferencedPaths('specs/two.md: see also\n', [
      stage('cat', 'README.md'),
      stage('grep', '-r', 'also', '-'),
    ]);
    expect(paths).toEqual(['README.md']);
  });

  test('a dash beside a real operand is not counted as a second searched file', () => {
    const paths = extractReferencedPaths('(standard input):see specs/two.md\n', [
      stage('grep', 'see', 'README.md', '-'),
    ]);
    expect(paths).toEqual(['README.md']);
  });

  test('a grep with no search operand defers to the upstream producer', () => {
    const paths = extractReferencedPaths('specs/two.md: see also\n', [
      stage('cat', 'README.md'),
      stage('grep', 'also'),
    ]);
    expect(paths).toEqual(['README.md']);
  });
});
