import { describe, expect, test } from 'bun:test';
import {
  buildKnownWikilinkTargetSet,
  buildPageNameSet,
  extractWikilinkTarget,
} from './wiki-link-source';

describe('buildPageNameSet', () => {
  test('empty input → empty set', () => {
    expect(buildPageNameSet([]).size).toBe(0);
  });

  test('indexes docName', () => {
    const s = buildPageNameSet([{ docName: 'README', title: '' }]);
    expect(s.has('readme')).toBe(true);
    expect(s.size).toBe(1);
  });

  test('indexes both docName AND title when present', () => {
    const s = buildPageNameSet([{ docName: 'CLAUDE', title: 'CLAUDE Guide' }]);
    expect(s.has('claude')).toBe(true);
    expect(s.has('claude guide')).toBe(true);
    expect(s.size).toBe(2);
  });

  test('indexes referenced assets by path and basename', () => {
    const s = buildPageNameSet([
      { kind: 'asset', docName: '/docs/public/Wide.png', title: 'Wide.png' },
    ]);
    expect(s.has('/docs/public/wide.png')).toBe(true);
    expect(s.has('docs/public/wide.png')).toBe(true);
    expect(s.has('wide.png')).toBe(true);
  });

  test('lowercases everything', () => {
    const s = buildPageNameSet([{ docName: 'ReadMe', title: 'The README' }]);
    expect(s.has('readme')).toBe(true);
    expect(s.has('the readme')).toBe(true);
    expect(s.has('ReadMe')).toBe(false);
    expect(s.has('The README')).toBe(false);
  });

  test('missing/empty title is skipped (only docName indexed)', () => {
    const s = buildPageNameSet([{ docName: 'NoTitle', title: '' }]);
    expect(s.has('notitle')).toBe(true);
    expect(s.size).toBe(1);
  });

  test('dedupes when docName === title (case-insensitive)', () => {
    const s = buildPageNameSet([{ docName: 'Foo', title: 'foo' }]);
    expect(s.has('foo')).toBe(true);
    expect(s.size).toBe(1);
  });

  test('multiple pages aggregate into one set', () => {
    const s = buildPageNameSet([
      { docName: 'a', title: 'Alpha' },
      { docName: 'b', title: 'Beta' },
      { docName: 'c', title: '' },
    ]);
    expect(s.size).toBe(5);
    expect(s.has('a')).toBe(true);
    expect(s.has('alpha')).toBe(true);
    expect(s.has('b')).toBe(true);
    expect(s.has('beta')).toBe(true);
    expect(s.has('c')).toBe(true);
  });
});

describe('extractWikilinkTarget', () => {
  test('plain page name', () => {
    expect(extractWikilinkTarget('SomePage')).toBe('somepage');
  });

  test('strips #anchor', () => {
    expect(extractWikilinkTarget('SomePage#heading-slug')).toBe('somepage');
  });

  test('strips |alias', () => {
    expect(extractWikilinkTarget('SomePage|display text')).toBe('somepage');
  });

  test('strips both anchor and alias (anchor first)', () => {
    expect(extractWikilinkTarget('SomePage#heading|display')).toBe('somepage');
  });

  test('strips both (alias first — whichever delimiter comes first wins)', () => {
    expect(extractWikilinkTarget('SomePage|display#anchor')).toBe('somepage');
  });

  test('lowercases', () => {
    expect(extractWikilinkTarget('UPPERcase')).toBe('uppercase');
    expect(extractWikilinkTarget('CamelCase')).toBe('camelcase');
  });

  test('trims leading/trailing whitespace', () => {
    expect(extractWikilinkTarget('  spaced  ')).toBe('spaced');
    expect(extractWikilinkTarget('  spaced#anchor')).toBe('spaced');
  });

  test('empty inner → empty string', () => {
    expect(extractWikilinkTarget('')).toBe('');
  });

  test('whitespace-only inner → empty string', () => {
    expect(extractWikilinkTarget('   ')).toBe('');
  });

  test('only-anchor inner → empty string (no target)', () => {
    expect(extractWikilinkTarget('#anchor-only')).toBe('');
  });

  test('only-alias inner → empty string', () => {
    expect(extractWikilinkTarget('|alias-only')).toBe('');
  });

  test('preserves internal whitespace in the target', () => {
    expect(extractWikilinkTarget('Some Page')).toBe('some page');
    expect(extractWikilinkTarget('Some Page#heading')).toBe('some page');
  });
});

describe('end-to-end target matching', () => {
  test('valid wikilink resolves — target lookups succeed', () => {
    const pageSet = buildPageNameSet([{ docName: 'existing-page', title: 'Existing' }]);
    expect(pageSet.has(extractWikilinkTarget('existing-page'))).toBe(true);
    expect(pageSet.has(extractWikilinkTarget('EXISTING-PAGE'))).toBe(true);
    expect(pageSet.has(extractWikilinkTarget('existing-page#anchor'))).toBe(true);
    expect(pageSet.has(extractWikilinkTarget('existing-page|alias'))).toBe(true);
    expect(pageSet.has(extractWikilinkTarget('Existing'))).toBe(true); // title-match
  });

  test('broken wikilink → target not in set', () => {
    const pageSet = buildPageNameSet([{ docName: 'real', title: 'Real' }]);
    expect(pageSet.has(extractWikilinkTarget('ghost'))).toBe(false);
    expect(pageSet.has(extractWikilinkTarget('ghost#anchor'))).toBe(false);
  });

  test('folder targets are treated as known when a child note exists', () => {
    const targetSet = buildKnownWikilinkTargetSet([
      { docName: 'reports/index', title: 'Reports' },
      { docName: 'reports/q1/summary', title: 'Quarter One Summary' },
    ]);

    expect(targetSet.has(extractWikilinkTarget('reports'))).toBe(true);
    expect(targetSet.has(extractWikilinkTarget('reports/q1'))).toBe(true);
  });

  test('empty target (bare #anchor in wikilink) matches nothing', () => {
    const target = extractWikilinkTarget('#anchor-only');
    expect(target).toBe('');
    expect(Boolean(target)).toBe(false);
  });
});
