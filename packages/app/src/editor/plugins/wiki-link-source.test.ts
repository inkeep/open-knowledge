import { beforeEach, describe, expect, test } from 'vitest';
import {
  resetLinkValidationPolicyForTest,
  setLinkValidationVisible,
} from '../link-validation-policy';
import {
  buildKnownWikilinkTargetSet,
  buildSourceWikiLinkLookup,
  wikiLinkSourceClass,
} from './wiki-link-source';

beforeEach(() => resetLinkValidationPolicyForTest());

describe('wikiLinkSourceClass', () => {
  test('validation.links off suppresses the broken wikilink decoration', () => {
    const targets = buildSourceWikiLinkLookup([{ docName: 'known', title: 'Known' }]);
    expect(wikiLinkSourceClass('missing', targets)).toBe('cm-wiki-link cm-wiki-link-broken');
    setLinkValidationVisible(false);
    expect(wikiLinkSourceClass('missing', targets)).toBe('cm-wiki-link');
  });

  test('reuses asset resolution for each lookup and invalidates it with the inventory', () => {
    class CountedAssets extends Set<string> {
      scans = 0;

      override *[Symbol.iterator](): SetIterator<string> {
        this.scans += 1;
        yield* super[Symbol.iterator]();
      }
    }

    const assets = new CountedAssets(['images/Cover.png']);
    const first = {
      pages: new Set<string>(),
      pagesBySlug: new Map<string, string>(),
      assetPaths: assets,
    };
    expect(wikiLinkSourceClass('cover.png', first)).toBe('cm-wiki-link');
    const firstScans = assets.scans;
    expect(firstScans).toBeGreaterThan(0);
    for (let index = 0; index < 200; index += 1)
      expect(wikiLinkSourceClass('cover.png', first)).toBe('cm-wiki-link');
    expect(assets.scans).toBe(firstScans);

    const second = { ...first, assetPaths: new CountedAssets() };
    expect(wikiLinkSourceClass('cover.png', second)).toBe('cm-wiki-link cm-wiki-link-broken');
  });

  test('checks distinct asset links against the inventory index without rescanning assets', () => {
    class CountedAssets extends Set<string> {
      scans = 0;

      override *[Symbol.iterator](): SetIterator<string> {
        this.scans += 1;
        yield* super[Symbol.iterator]();
      }
    }

    const pages = Array.from({ length: 10_000 }, (_, index) => ({
      kind: 'asset',
      docName: `/images/image-${index}.png`,
      title: '',
    }));
    const built = buildSourceWikiLinkLookup(pages);
    const assets = new CountedAssets(built.assetPaths);
    const lookup = { ...built, assetPaths: assets };
    for (let index = 0; index < 200; index += 1) {
      expect(wikiLinkSourceClass(`image-${index}.png`, lookup)).toBe('cm-wiki-link');
      expect(wikiLinkSourceClass(`images/image-${index}.png`, lookup)).toBe('cm-wiki-link');
    }
    expect(assets.scans).toBe(0);
    expect(wikiLinkSourceClass('images/missing.png', lookup)).toBe(
      'cm-wiki-link cm-wiki-link-broken',
    );
  });
});

describe('source decoration target extraction', () => {
  const pages = [
    { docName: 'SomePage', title: 'Some Page' },
    { docName: 'reports/index', title: 'Reports' },
    { docName: 'reports/q1/summary', title: 'Quarter One Summary' },
    { kind: 'folder', docName: 'specs/foo', title: 'foo' },
  ];
  const lookup = buildSourceWikiLinkLookup(pages);
  const known = buildKnownWikilinkTargetSet(pages);

  test.each([
    'SomePage',
    'SOMEPAGE',
    'SomePage#heading',
    'SomePage|Alias',
    'SomePage#heading|Alias',
    'SomePage|Alias#heading',
    '  SomePage  ',
    '',
    '   ',
    '#heading',
    '|Alias',
    'reports',
    'reports/q1',
    'specs/foo',
  ])('%s keeps its resolved or anchor-only decoration', (inner) => {
    expect(wikiLinkSourceClass(inner, lookup, known)).toBe('cm-wiki-link');
  });

  test.each(['Some Page', 'Some Page#heading', 'Quarter One Summary', 'foo'])(
    '%s names only a title, so it stays broken like its click destination',
    (inner) => {
      expect(wikiLinkSourceClass(inner, lookup, known)).toBe('cm-wiki-link cm-wiki-link-broken');
    },
  );

  test.each(['ghost', 'ghost#heading', 'ghost|Alias', 'ghost#heading|Alias'])(
    '%s stays broken after removing its heading and alias',
    (inner) => {
      expect(wikiLinkSourceClass(inner, lookup, known)).toBe('cm-wiki-link cm-wiki-link-broken');
    },
  );
});

describe('source decoration uses document resolution', () => {
  const lookup = buildSourceWikiLinkLookup([
    { docName: 'notes/beta', title: 'Beta' },
    { docName: 'notes/beta-md', title: 'Other' },
    { docName: 'reports/index', title: 'Reports' },
    { docName: 'fallback-md', title: 'Fallback' },
    { docName: 'dotted.md', title: 'Dotted' },
  ]);

  test.each([
    'notes/beta.md',
    'NOTES/BETA.MDX#heading|Alias',
    'beta.md|Alias',
    'reports.md',
    'fallback.md',
    'dotted.md.md',
  ])('%s is decorated as a resolved link', (target) => {
    expect(wikiLinkSourceClass(target, lookup)).toBe('cm-wiki-link');
  });

  test('one suffix removal leaves a genuinely missing link broken', () => {
    const singlePage = buildSourceWikiLinkLookup([{ docName: 'notes/beta', title: 'Beta' }]);
    expect(wikiLinkSourceClass('notes/beta.md.md', singlePage)).toBe(
      'cm-wiki-link cm-wiki-link-broken',
    );
    expect(wikiLinkSourceClass('missing.md#heading|Alias', lookup)).toBe(
      'cm-wiki-link cm-wiki-link-broken',
    );
  });

  test('known folder targets retain their decoration without becoming document identities', () => {
    expect(wikiLinkSourceClass('notes', lookup, new Set(['notes']))).toBe('cm-wiki-link');
  });
});
