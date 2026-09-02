import { describe, expect, test } from 'vitest';
import { classifyWikiLinkTarget } from './link-targets.ts';
import { toWikiLinkSlug } from './slug.ts';
import {
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  isResolvedWikiLinkTarget,
  resolveWikiLinkAssetTarget,
  resolveWikiLinkTarget,
  resolveWikiLinkTargetDocName,
  type WikiLinkLookupIndex,
} from './wiki-link-resolve.ts';

const PAGES = [
  'README',
  'test-doc',
  'nonexistent-page',
  'BA_for_Depression_Research',
  'docs/getting-started',
  'packages/server/README',
  'andrew-data/project-x/analysis',
  'z/foo',
  'a/foo',
  'm/foo',
  'subfolder/Project X',
  'reports/index',
  'archive/reports',
  'docs/api/api',
  'notes/acp.daemon',
  'v1.2 release',
  'meeting.pdf',
  'Zebra',
  'apple',
  'Notes/Summary',
  'archive/summary',
];

const ASSETS = ['docs/public/Wide.png', 'images/photo.JPG', 'meeting.pdf', 'shared.png'];
const FILES = ['data/example.csv', 'src/components/FileTree.tsx', 'shared.png'];

type CorpusRow = [
  target: string,
  setDoc: string | null,
  indexDoc: string | null,
  asset: string | null,
  assetNoFiles: string | null,
  setResolved: boolean,
  indexResolved: boolean,
];

const CORPUS: readonly CorpusRow[] = [
  ['', null, null, null, null, false, false],
  ['   ', null, null, null, null, false, false],
  ['README', 'README', 'README', null, null, true, true],
  ['readme', 'README', 'README', null, null, true, true],
  ['ReAdMe', 'README', 'README', null, null, true, true],
  ['test-doc', 'test-doc', 'test-doc', null, null, true, true],
  ['Nonexistent Page', 'nonexistent-page', 'nonexistent-page', null, null, true, true],
  ['Missing Page', null, null, null, null, false, false],
  [
    'ba-for-depression-research',
    'BA_for_Depression_Research',
    'BA_for_Depression_Research',
    null,
    null,
    true,
    true,
  ],
  [
    'BA_for_Depression_Research',
    'BA_for_Depression_Research',
    'BA_for_Depression_Research',
    null,
    null,
    true,
    true,
  ],
  ['docs/getting-started', 'docs/getting-started', 'docs/getting-started', null, null, true, true],
  [
    'packages/server/readme',
    'packages/server/README',
    'packages/server/README',
    null,
    null,
    true,
    true,
  ],
  [
    'analysis',
    'andrew-data/project-x/analysis',
    'andrew-data/project-x/analysis',
    null,
    null,
    true,
    true,
  ],
  ['foo', 'a/foo', 'a/foo', null, null, true, true],
  ['project x', 'subfolder/Project X', 'subfolder/Project X', null, null, true, true],
  ['Project X', 'subfolder/Project X', 'subfolder/Project X', null, null, true, true],
  ['sub/foo', null, null, null, null, false, false],
  ['reports', 'reports/index', 'reports/index', null, null, true, true],
  ['docs/api', 'docs/api/api', 'docs/api/api', null, null, true, true],
  ['acp.daemon', 'notes/acp.daemon', 'notes/acp.daemon', null, null, true, true],
  ['ACP.Daemon', 'notes/acp.daemon', 'notes/acp.daemon', null, null, true, true],
  ['notes/acp.daemon', 'notes/acp.daemon', 'notes/acp.daemon', null, null, true, true],
  ['v1.2 release', 'v1.2 release', 'v1.2 release', null, null, true, true],
  ['v1-2-release', 'v1.2 release', 'v1.2 release', null, null, true, true],
  ['meeting.pdf', 'meeting.pdf', 'meeting.pdf', 'meeting.pdf', 'meeting.pdf', true, true],
  ['/meeting.pdf', 'meeting.pdf', 'meeting.pdf', 'meeting.pdf', 'meeting.pdf', true, true],
  ['Wide.png', null, null, 'docs/public/Wide.png', 'docs/public/Wide.png', true, true],
  ['docs/public/wide.png', null, null, 'docs/public/Wide.png', 'docs/public/Wide.png', true, true],
  ['/docs/public/Wide.png', null, null, 'docs/public/Wide.png', 'docs/public/Wide.png', true, true],
  ['other/Wide.png', null, null, null, null, false, false],
  ['Missing.png', null, null, null, null, false, false],
  ['photo.jpg', null, null, 'images/photo.JPG', 'images/photo.JPG', true, true],
  ['data/example.csv', null, null, 'data/example.csv', null, true, true],
  ['/data/example.csv', null, null, 'data/example.csv', null, true, true],
  ['FileTree.tsx', null, null, 'src/components/FileTree.tsx', null, true, true],
  ['filetree.tsx', null, null, 'src/components/FileTree.tsx', null, true, true],
  ['missing.csv', null, null, null, null, false, false],
  ['shared.png', null, null, 'shared.png', 'shared.png', true, true],
  ['Zebra', 'Zebra', 'Zebra', null, null, true, true],
  ['apple', 'apple', 'apple', null, null, true, true],
  ['summary', 'Notes/Summary', 'Notes/Summary', null, null, true, true],
  ['Summary', 'Notes/Summary', 'Notes/Summary', null, null, true, true],
  [
    'docs/public/Wide.png#frag',
    null,
    null,
    'docs/public/Wide.png',
    'docs/public/Wide.png',
    true,
    true,
  ],
  ['Wide.png?v=2', null, null, 'docs/public/Wide.png', 'docs/public/Wide.png', true, true],
];

function makeFixtures() {
  const pages = new Set(PAGES);
  const assetPaths = new Set(ASSETS);
  const filePaths = new Set(FILES);
  const index: WikiLinkLookupIndex = {
    pages,
    assetPaths,
    filePaths,
    pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
    pagesByBasename: buildPagesByBasenameIndex(pages, toWikiLinkSlug),
  };
  return { pages, assetPaths, filePaths, index };
}

describe('wiki-link resolution equivalence corpus', () => {
  test('every target resolves to the docName it resolved to before the chain moved', () => {
    const { pages, assetPaths, filePaths, index } = makeFixtures();

    const actual = CORPUS.map(([target]): CorpusRow => {
      return [
        target,
        resolveWikiLinkTargetDocName(target, pages) ?? null,
        resolveWikiLinkTargetDocName(target, index) ?? null,
        resolveWikiLinkAssetTarget(target, assetPaths, filePaths),
        resolveWikiLinkAssetTarget(target, assetPaths),
        isResolvedWikiLinkTarget(target, pages, assetPaths, filePaths),
        isResolvedWikiLinkTarget(target, index),
      ];
    });

    expect(actual).toEqual(CORPUS);
  });

  test('the bare-set scan and the precomputed index name the same document', () => {
    const { pages, index } = makeFixtures();
    for (const [target] of CORPUS) {
      expect(resolveWikiLinkTargetDocName(target, index)).toBe(
        resolveWikiLinkTargetDocName(target, pages),
      );
    }
  });
});

describe('derived index construction', () => {
  test('slug index keys the full docName and keeps the first entry on collision', () => {
    const index = buildPagesBySlugIndex(new Set(['README', 'ReadMe']), toWikiLinkSlug);
    expect(index.get('readme')).toBe('README');
    expect(index.size).toBe(1);
  });

  test('basename index keys the leaf segment so a bare name finds a subfolder doc', () => {
    const index = buildPagesByBasenameIndex(
      new Set(['andrew-data/project-x/analysis', 'notes/acp.daemon']),
      toWikiLinkSlug,
    );
    expect(index.get('analysis')).toBe('andrew-data/project-x/analysis');
    expect(index.get('acp-daemon')).toBe('notes/acp.daemon');
  });
});

describe('ambiguous-basename tie-break', () => {
  const COLLIDING = ['archive/summary', 'Notes/Summary'];

  test('two documents sharing a basename resolve to one winner, whatever the insertion order', () => {
    for (const order of [COLLIDING, [...COLLIDING].reverse()]) {
      const index = buildPagesByBasenameIndex(new Set(order), toWikiLinkSlug);
      expect(index.get('summary')).toBe('Notes/Summary');
    }
  });

  test('the winner is the code-unit minimum, so no runtime locale can change it', () => {
    const pages = new Set([
      'archive/summary',
      'Notes/Summary',
      'z/foo',
      'a/foo',
      'M/foo',
      'README',
      'packages/server/README',
    ]);
    const index = buildPagesByBasenameIndex(pages, toWikiLinkSlug);

    for (const [key, winner] of index) {
      const bucket = [...pages].filter((page) => {
        const slash = page.lastIndexOf('/');
        return toWikiLinkSlug(slash === -1 ? page : page.slice(slash + 1)) === key;
      });
      const codeUnitMinimum = bucket.reduce((lowest, page) => (page < lowest ? page : lowest));
      expect(winner).toBe(codeUnitMinimum);
    }
  });

  test('the bare-set scan and the index agree on the winner for a mixed-case collision', () => {
    const pages = new Set(COLLIDING);
    const index: WikiLinkLookupIndex = {
      pages,
      pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
      pagesByBasename: buildPagesByBasenameIndex(pages, toWikiLinkSlug),
    };
    expect(resolveWikiLinkTargetDocName('summary', pages)).toBe('Notes/Summary');
    expect(resolveWikiLinkTargetDocName('summary', index)).toBe('Notes/Summary');
  });

  test('an ambiguous asset basename resolves to one winner too', () => {
    const assets = new Set(['archive/Report.pdf', 'Notes/report.pdf']);
    expect(resolveWikiLinkAssetTarget('report.pdf', assets)).toBe('Notes/report.pdf');
  });
});

describe('resolution chain boundaries', () => {
  test('a document whose filename contains a dot resolves by bare name', () => {
    const { pages, index } = makeFixtures();
    expect(resolveWikiLinkTargetDocName('acp.daemon', pages)).toBe('notes/acp.daemon');
    expect(resolveWikiLinkTargetDocName('acp.daemon', index)).toBe('notes/acp.daemon');
  });

  test('a path-shaped target does not fall back to a same-basename document', () => {
    const pages = new Set(['a/foo']);
    expect(resolveWikiLinkTargetDocName('sub/foo', pages)).toBeUndefined();
  });

  test('an asset that shares a name with a document resolves as the asset', () => {
    const pages = new Set(['meeting.pdf']);
    const assets = new Set(['meeting.pdf']);
    expect(resolveWikiLinkAssetTarget('meeting.pdf', assets)).toBe('meeting.pdf');
    expect(isResolvedWikiLinkTarget('meeting.pdf', pages, assets)).toBe(true);
  });
});

describe('composed wiki-link resolution', () => {
  const PROJECT = (() => {
    const pages = new Set(['notes/acp.daemon', 'v1.2 release', 'guides/install']);
    return {
      pages,
      assetPaths: new Set(['docs/public/Wide.png']),
      filePaths: new Set(['data/example.csv']),
      pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
      pagesByBasename: buildPagesByBasenameIndex(pages, toWikiLinkSlug),
    } satisfies WikiLinkLookupIndex;
  })();

  test('the bare classifier reads a dotted document name as an asset', () => {
    expect(classifyWikiLinkTarget('acp.daemon', null)).toEqual({
      kind: 'asset',
      url: 'acp.daemon',
      ext: 'daemon',
      literal: true,
    });
  });

  test('a dotted target naming an existing document resolves as a document', () => {
    expect(resolveWikiLinkTarget('acp.daemon', null, PROJECT)).toEqual({
      kind: 'doc',
      docName: 'acp.daemon',
      anchor: null,
    });
  });

  test('promotion carries the anchor through', () => {
    expect(resolveWikiLinkTarget('acp.daemon', ' setup ', PROJECT)).toEqual({
      kind: 'doc',
      docName: 'acp.daemon',
      anchor: 'setup',
    });
  });

  test('a dotted target naming a document with a space and a version resolves too', () => {
    expect(resolveWikiLinkTarget('v1.2 release', null, PROJECT)).toEqual({
      kind: 'doc',
      docName: 'v1.2 release',
      anchor: null,
    });
  });

  test('a target naming a real asset stays an asset', () => {
    expect(resolveWikiLinkTarget('Wide.png', null, PROJECT)).toEqual({
      kind: 'asset',
      url: 'Wide.png',
      ext: 'png',
      literal: true,
    });
  });

  test('a target naming a tracked non-markdown file stays an asset', () => {
    expect(resolveWikiLinkTarget('data/example.csv', null, PROJECT)).toEqual({
      kind: 'asset',
      url: 'data/example.csv',
      ext: 'csv',
      literal: true,
    });
  });

  test('a target naming neither stays an asset, exactly as before', () => {
    expect(resolveWikiLinkTarget('missing.pdf', null, PROJECT)).toEqual({
      kind: 'asset',
      url: 'missing.pdf',
      ext: 'pdf',
      literal: true,
    });
  });

  test('an asset wins over a document of the same name', () => {
    const pages = new Set(['meeting.pdf']);
    const lookup: WikiLinkLookupIndex = {
      pages,
      assetPaths: new Set(['meeting.pdf']),
      pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
      pagesByBasename: buildPagesByBasenameIndex(pages, toWikiLinkSlug),
    };
    expect(resolveWikiLinkTarget('meeting.pdf', null, lookup)).toEqual({
      kind: 'asset',
      url: 'meeting.pdf',
      ext: 'pdf',
      literal: true,
    });
  });

  test('a tracked non-markdown file wins over a same-basename document', () => {
    const pages = new Set(['archive/data.csv']);
    const lookup: WikiLinkLookupIndex = {
      pages,
      filePaths: new Set(['notes/data.csv']),
      pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
      pagesByBasename: buildPagesByBasenameIndex(pages, toWikiLinkSlug),
    };
    expect(resolveWikiLinkTarget('data.csv', null, lookup)).toEqual({
      kind: 'asset',
      url: 'data.csv',
      ext: 'csv',
      literal: true,
    });
  });

  test('a document-classified target passes through untouched', () => {
    expect(resolveWikiLinkTarget('guides/install', 'intro', PROJECT)).toEqual({
      kind: 'doc',
      docName: 'guides/install',
      anchor: 'intro',
    });
    expect(resolveWikiLinkTarget('does-not-exist', null, PROJECT)).toEqual({
      kind: 'doc',
      docName: 'does-not-exist',
      anchor: null,
    });
  });

  test('external and empty targets pass through untouched', () => {
    expect(resolveWikiLinkTarget('https://example.com/a.pdf', 'x', PROJECT)).toEqual({
      kind: 'external',
      url: 'https://example.com/a.pdf#x',
    });
    expect(resolveWikiLinkTarget('', null, PROJECT)).toBeNull();
    expect(resolveWikiLinkTarget('   ', null, PROJECT)).toBeNull();
  });

  test('every target the classifier already resolves is returned unchanged', () => {
    for (const target of [
      'guides/install',
      'does-not-exist',
      'Wide.png',
      'data/example.csv',
      'missing.pdf',
      'https://example.com/x',
      '',
    ]) {
      expect(resolveWikiLinkTarget(target, null, PROJECT)).toEqual(
        classifyWikiLinkTarget(target, null),
      );
    }
  });

  test('resolution works from a bare Set with no precomputed index', () => {
    expect(resolveWikiLinkTarget('acp.daemon', null, new Set(['notes/acp.daemon']))).toEqual({
      kind: 'doc',
      docName: 'acp.daemon',
      anchor: null,
    });
  });
});
