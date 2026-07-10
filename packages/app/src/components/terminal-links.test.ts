import { describe, expect, test } from 'bun:test';
import type { PageListCacheSnapshot } from '../editor/page-list-cache';
import {
  classifyTarget,
  createRecentOpenGuard,
  detectPathCandidates,
  hasPathExtension,
  isKnownInSnapshot,
  resolveTerminalPath,
  terminalBufferRange,
  toProjectRelative,
} from './terminal-links';

function snapshot(partial: Partial<PageListCacheSnapshot> = {}): PageListCacheSnapshot {
  return {
    pages: new Set(),
    folderPaths: new Set(),
    pagesBySlug: new Map(),
    ...partial,
  };
}

describe('detectPathCandidates', () => {
  test('finds a relative path with a separator', () => {
    const [c] = detectPathCandidates('see src/foo.ts for details');
    expect(c?.path).toBe('src/foo.ts');
    expect('see '.length).toBe(4);
    expect(c?.startIndex).toBe(4);
    expect(c?.endIndex).toBe(14);
    expect(c?.trailingSlash).toBe(false);
  });

  test('finds dot-relative and parent-relative paths', () => {
    expect(detectPathCandidates('./a/b.md')[0]?.path).toBe('./a/b.md');
    expect(detectPathCandidates('../x/y.md')[0]?.path).toBe('../x/y.md');
  });

  test('finds an absolute path', () => {
    expect(detectPathCandidates('at /Users/me/notes.md now')[0]?.path).toBe('/Users/me/notes.md');
  });

  test('finds a bare filename only when it has an extension', () => {
    expect(detectPathCandidates('open report.md please')[0]?.path).toBe('report.md');
    expect(detectPathCandidates('the readme was updated')).toHaveLength(0);
  });

  test('strips a :line:col suffix, keeping it out of the underlined range', () => {
    const [c] = detectPathCandidates('../x.py:12:5');
    expect(c?.path).toBe('../x.py');
    expect(c?.endIndex).toBe('../x.py'.length);
  });

  test('strips a :line[:col] suffix even when trailing punctuation follows', () => {
    // A common compiler / ripgrep shape: `error at src/a.ts:12,` — punctuation is
    // trimmed BEFORE the suffix match so the path still resolves.
    expect(detectPathCandidates('error at src/a.ts:12,')[0]?.path).toBe('src/a.ts');
    expect(detectPathCandidates('see src/a.ts:12:5.')[0]?.path).toBe('src/a.ts');
  });

  test('a trailing-slash folder underline excludes the slash (endIndex over core)', () => {
    const [c] = detectPathCandidates('cd packages/app/');
    expect(c?.path).toBe('packages/app');
    expect(c?.trailingSlash).toBe(true);
    // 'cd ' = 3; the underlined range is exactly 'packages/app' (no trailing `/`).
    expect(c?.startIndex).toBe(3);
    expect(c?.endIndex).toBe(3 + 'packages/app'.length);
  });

  test('marks a trailing slash as a folder reference', () => {
    const [c] = detectPathCandidates('cd packages/app/');
    expect(c?.path).toBe('packages/app');
    expect(c?.trailingSlash).toBe(true);
  });

  test('ignores http(s) URLs (WebLinksAddon owns those)', () => {
    expect(detectPathCandidates('visit https://example.com/path')).toHaveLength(0);
    expect(detectPathCandidates('file://host/x.md')).toHaveLength(0);
  });

  test('ignores bare words, numbers, and clock times', () => {
    expect(detectPathCandidates('the quick brown fox')).toHaveLength(0);
    expect(detectPathCandidates('elapsed 12:34')).toHaveLength(0);
    expect(detectPathCandidates('exit code 127')).toHaveLength(0);
  });

  test('trims trailing sentence punctuation', () => {
    expect(detectPathCandidates('edited src/a.ts.')[0]?.path).toBe('src/a.ts');
    expect(detectPathCandidates('files: src/a.ts, src/b.ts')[0]?.path).toBe('src/a.ts');
  });

  test('strips enclosing brackets (they are token boundaries)', () => {
    expect(detectPathCandidates('[src/a.ts]')[0]?.path).toBe('src/a.ts');
  });

  test('rejects ~-home paths (no homedir available renderer-side)', () => {
    expect(detectPathCandidates('~/notes.md')).toHaveLength(0);
  });

  test('caps the number of candidates per line', () => {
    const line = Array.from({ length: 20 }, (_, i) => `dir/file${i}.md`).join(' ');
    expect(detectPathCandidates(line, 5)).toHaveLength(5);
  });

  test('ignores empty and pathologically long lines', () => {
    expect(detectPathCandidates('')).toHaveLength(0);
    expect(detectPathCandidates(`${'a/'.repeat(2000)}z.md`)).toHaveLength(0);
  });
});

describe('toProjectRelative', () => {
  const root = '/Users/me/project';

  test('passes through a clean relative path', () => {
    expect(toProjectRelative('src/foo.ts', root)).toBe('src/foo.ts');
  });

  test('strips a leading ./', () => {
    expect(toProjectRelative('./src/foo.ts', root)).toBe('src/foo.ts');
  });

  test('makes an in-project absolute path project-relative', () => {
    expect(toProjectRelative('/Users/me/project/docs/a.md', root)).toBe('docs/a.md');
  });

  test('rejects an absolute path outside the project', () => {
    expect(toProjectRelative('/etc/passwd', root)).toBeNull();
    expect(toProjectRelative('/Users/me/other/a.md', root)).toBeNull();
  });

  test('rejects the project root itself', () => {
    expect(toProjectRelative(root, root)).toBeNull();
  });

  test('rejects any parent-escape', () => {
    expect(toProjectRelative('../secrets.md', root)).toBeNull();
    expect(toProjectRelative('a/../../b.md', root)).toBeNull();
  });

  test('tolerates a trailing slash on the project root', () => {
    expect(toProjectRelative('src/a.ts', '/Users/me/project/')).toBe('src/a.ts');
  });

  test('collapses redundant separators and current-dir segments', () => {
    expect(toProjectRelative('a//./b.md', root)).toBe('a/b.md');
  });
});

describe('resolveTerminalPath', () => {
  const root = '/Users/me/project';

  test('an in-project relative path resolves in-project', () => {
    expect(resolveTerminalPath('src/a.ts', root)).toEqual({
      kind: 'in-project',
      relPath: 'src/a.ts',
    });
  });

  test('an in-project absolute path resolves in-project (made relative)', () => {
    expect(resolveTerminalPath('/Users/me/project/docs/a.md', root)).toEqual({
      kind: 'in-project',
      relPath: 'docs/a.md',
    });
  });

  test('an out-of-project absolute path resolves external', () => {
    expect(resolveTerminalPath('/tmp/out/x.pdf', root)).toEqual({
      kind: 'external',
      absPath: '/tmp/out/x.pdf',
    });
    expect(resolveTerminalPath('/etc/hosts', root)).toEqual({
      kind: 'external',
      absPath: '/etc/hosts',
    });
  });

  test('the project root itself is not routable', () => {
    expect(resolveTerminalPath(root, root)).toBeNull();
  });

  test('a relative parent-escape stays non-clickable (ambiguous once the shell cd-s)', () => {
    expect(resolveTerminalPath('../secrets.md', root)).toBeNull();
  });
});

describe('classifyTarget', () => {
  test('markdown extensions classify as docs', () => {
    expect(classifyTarget('notes/a.md', false, null)).toBe('doc');
    expect(classifyTarget('notes/a.mdx', false, null)).toBe('doc');
  });

  test('a docName known to the cache classifies as a doc', () => {
    const snap = snapshot({ pages: new Set(['guides/setup']) });
    expect(classifyTarget('guides/setup', false, snap)).toBe('doc');
  });

  test('trailing slash or a known folder classifies as a folder', () => {
    expect(classifyTarget('packages/app', true, null)).toBe('folder');
    const snap = snapshot({ folderPaths: new Set(['packages/app']) });
    expect(classifyTarget('packages/app', false, snap)).toBe('folder');
  });

  test('everything else is an asset', () => {
    expect(classifyTarget('data/example.csv', false, null)).toBe('asset');
    expect(classifyTarget('img/logo.png', false, null)).toBe('asset');
  });
});

describe('isKnownInSnapshot', () => {
  test('resolves docs, assets, files, and folders from the cache without a probe', () => {
    const snap = snapshot({
      pages: new Set(['guides/setup']),
      folderPaths: new Set(['packages']),
      assetPaths: new Set(['img/logo.png']),
      filePaths: new Set(['data/x.csv']),
    });
    expect(isKnownInSnapshot('guides/setup.md', false, snap)).toBe(true);
    expect(isKnownInSnapshot('img/logo.png', false, snap)).toBe(true);
    expect(isKnownInSnapshot('data/x.csv', false, snap)).toBe(true);
    expect(isKnownInSnapshot('packages', true, snap)).toBe(true);
    expect(isKnownInSnapshot('unknown/thing.txt', false, snap)).toBe(false);
  });

  test('returns false when there is no snapshot', () => {
    expect(isKnownInSnapshot('a.md', false, null)).toBe(false);
  });
});

describe('createRecentOpenGuard', () => {
  test('suppresses the same URL fired twice within the window (the OSC 8 + WebLinks double)', () => {
    const guard = createRecentOpenGuard(300);
    expect(guard('https://x.com', 1000)).toBe(false); // first open proceeds
    expect(guard('https://x.com', 1000)).toBe(true); // same click, same ms → suppressed
    expect(guard('https://x.com', 1200)).toBe(true); // still within 300ms window
  });

  test('allows the same URL again after the window elapses', () => {
    const guard = createRecentOpenGuard(300);
    expect(guard('https://x.com', 1000)).toBe(false);
    expect(guard('https://x.com', 1400)).toBe(false); // 400ms later → a fresh open
  });

  test('never suppresses a different URL', () => {
    const guard = createRecentOpenGuard(300);
    expect(guard('https://a.com', 1000)).toBe(false);
    expect(guard('https://b.com', 1000)).toBe(false); // different target, same instant
  });
});

describe('hasPathExtension', () => {
  test('true for extensioned leaves, false for extensionless', () => {
    expect(hasPathExtension('report.md')).toBe(true);
    expect(hasPathExtension('a/b/c.tsx')).toBe(true);
    expect(hasPathExtension('packages/app')).toBe(false);
    expect(hasPathExtension('src')).toBe(false);
    expect(hasPathExtension('node_modules')).toBe(false);
  });
});

describe('terminalBufferRange', () => {
  test('a span within one row maps to a single-row 1-based range', () => {
    // "see " (4 chars) then a 10-char path → [4,14); cols wide enough not to wrap.
    expect(terminalBufferRange(4, 14, 3, 80)).toEqual({
      start: { x: 5, y: 3 },
      end: { x: 14, y: 3 },
    });
  });

  test('a span crossing the wrap boundary spans rows (start.y != end.y)', () => {
    // cols=20, path at [4,27): last char is index 26 → row +1, col 7.
    expect(terminalBufferRange(4, 27, 1, 20)).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 7, y: 2 },
    });
  });

  test('a span landing exactly on a wrap boundary starts the next row', () => {
    // index 20 with cols=20 → col 1 of the next row.
    expect(terminalBufferRange(20, 24, 5, 20)).toEqual({
      start: { x: 1, y: 6 },
      end: { x: 4, y: 6 },
    });
  });

  test('a non-positive width never wraps (guards divide-by-zero)', () => {
    expect(terminalBufferRange(2, 8, 1, 0)).toEqual({
      start: { x: 3, y: 1 },
      end: { x: 8, y: 1 },
    });
  });
});
