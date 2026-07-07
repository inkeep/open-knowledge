import { describe, expect, test } from 'bun:test';
import {
  buildUnresolvedWikiLinkAttrs,
  canUseTargetAsPathSegment,
  isResolvedWikiLinkTarget,
  resolveWikiLinkAssetTarget,
  resolveWikiLinkTargetDocName,
  toWikiLinkSlug,
  wikiLinkSuggestedFilename,
} from './wiki-link-helpers';

describe('toWikiLinkSlug', () => {
  test('normalizes human-readable page names to doc slugs', () => {
    expect(toWikiLinkSlug('Nonexistent Page')).toBe('nonexistent-page');
    expect(toWikiLinkSlug('  Mixed_CASE  Page  ')).toBe('mixed-case-page');
  });

  test('keeps Unicode-safe slugs stable across scripts', () => {
    expect(toWikiLinkSlug('Café Menu')).toBe('cafe-menu');
    expect(toWikiLinkSlug('東京 2026')).toBe('東京-2026');
  });
});

describe('buildUnresolvedWikiLinkAttrs', () => {
  test('stores slug target and preserves human label as alias when needed', () => {
    expect(buildUnresolvedWikiLinkAttrs('Nonexistent Page')).toEqual({
      target: 'nonexistent-page',
      alias: 'Nonexistent Page',
      anchor: null,
    });
  });

  test('uses the shared Unicode-safe slugger for unresolved links', () => {
    expect(buildUnresolvedWikiLinkAttrs('Café Menu')).toEqual({
      target: 'cafe-menu',
      alias: 'Café Menu',
      anchor: null,
    });
  });

  test('returns null for empty input', () => {
    expect(buildUnresolvedWikiLinkAttrs('   ')).toBeNull();
  });
});

describe('isResolvedWikiLinkTarget', () => {
  test('matches exact doc names and slug-equivalent human labels', () => {
    const pages = new Set(['test-doc', 'nonexistent-page']);
    expect(isResolvedWikiLinkTarget('test-doc', pages)).toBe(true);
    expect(isResolvedWikiLinkTarget('Nonexistent Page', pages)).toBe(true);
    expect(isResolvedWikiLinkTarget('Missing Page', pages)).toBe(false);
  });

  test('matches referenced asset paths and basenames', () => {
    const pages = new Set(['test-doc']);
    const assets = new Set(['docs/public/Wide.png']);
    expect(isResolvedWikiLinkTarget('/docs/public/Wide.png', pages, assets)).toBe(true);
    expect(isResolvedWikiLinkTarget('docs/public/wide.png', pages, assets)).toBe(true);
    expect(isResolvedWikiLinkTarget('Wide.png', pages, assets)).toBe(true);
    expect(isResolvedWikiLinkTarget('Missing.png', pages, assets)).toBe(false);
  });
});

describe('resolveWikiLinkAssetTarget', () => {
  test('resolves server-absolute, content-relative, and basename asset targets', () => {
    const assets = new Set(['docs/public/Wide.png']);
    expect(resolveWikiLinkAssetTarget('/docs/public/Wide.png', assets)).toBe(
      'docs/public/Wide.png',
    );
    expect(resolveWikiLinkAssetTarget('docs/public/wide.png', assets)).toBe('docs/public/Wide.png');
    expect(resolveWikiLinkAssetTarget('Wide.png', assets)).toBe('docs/public/Wide.png');
  });

  test('does not basename-match path-shaped misses', () => {
    const assets = new Set(['docs/public/Wide.png']);
    expect(resolveWikiLinkAssetTarget('other/Wide.png', assets)).toBeNull();
  });
});

// a wikilink to an EXISTING non-markdown file that is NOT a
// renderable asset (e.g. `[[data/example.csv]]`) must resolve, not render
// dead. Pin the file-paths partition the resolver consults alongside
// assetPaths.
describe('resolveWikiLinkAssetTarget — file-paths partition', () => {
  test('resolves a tracked non-markdown file by exact path', () => {
    const assets = new Set<string>();
    const files = new Set(['data/example.csv']);
    expect(resolveWikiLinkAssetTarget('data/example.csv', assets, files)).toBe('data/example.csv');
  });

  test('resolves a tracked non-markdown file by leading-slash content path', () => {
    const assets = new Set<string>();
    const files = new Set(['data/example.csv']);
    expect(resolveWikiLinkAssetTarget('/data/example.csv', assets, files)).toBe('data/example.csv');
  });

  test('resolves a tracked non-markdown file by case-insensitive basename', () => {
    const assets = new Set<string>();
    const files = new Set(['packages/app/src/components/FileTree.tsx']);
    expect(resolveWikiLinkAssetTarget('FileTree.tsx', assets, files)).toBe(
      'packages/app/src/components/FileTree.tsx',
    );
    expect(resolveWikiLinkAssetTarget('filetree.tsx', assets, files)).toBe(
      'packages/app/src/components/FileTree.tsx',
    );
  });

  test('returns null when the target is not in either partition', () => {
    const assets = new Set(['images/diagram.png']);
    const files = new Set(['data/example.csv']);
    expect(resolveWikiLinkAssetTarget('missing.csv', assets, files)).toBeNull();
  });

  test('asset partition still wins when both partitions hold the target path', () => {
    // Production never emits the same path as both 'asset' AND 'file' (server
    // dedupes), but the resolver should still prefer the asset hit if drift
    // happens — assets carry richer downstream metadata (mediaKind,
    // referencedBy) the file row can't.
    const assets = new Set(['shared.png']);
    const files = new Set(['shared.png']);
    expect(resolveWikiLinkAssetTarget('shared.png', assets, files)).toBe('shared.png');
  });
});

describe('isResolvedWikiLinkTarget — non-markdown file existence (US-009)', () => {
  test('a tracked non-markdown file resolves as existing', () => {
    const pages = new Set(['notes/guide']);
    const assets = new Set<string>();
    const files = new Set(['data/example.csv']);
    expect(isResolvedWikiLinkTarget('data/example.csv', pages, assets, files)).toBe(true);
  });

  test('a NOT-tracked non-markdown file renders as missing', () => {
    const pages = new Set(['notes/guide']);
    const assets = new Set<string>();
    const files = new Set(['data/example.csv']);
    expect(isResolvedWikiLinkTarget('data/missing.csv', pages, assets, files)).toBe(false);
  });

  test('non-markdown file resolution composes with the snapshot input shape', () => {
    const snapshot = {
      pages: new Set<string>(),
      folderPaths: new Set<string>(),
      pagesBySlug: new Map<string, string>(),
      pagesByBasename: new Map<string, string>(),
      assetPaths: new Set<string>(),
      filePaths: new Set(['data/example.csv']),
    };
    expect(isResolvedWikiLinkTarget('data/example.csv', snapshot)).toBe(true);
    expect(isResolvedWikiLinkTarget('data/missing.csv', snapshot)).toBe(false);
  });
});

// Regression guard: `buildUnresolvedWikiLinkAttrs` stores
// the lowercased slug as target (e.g. `README.md` drop → target='readme'),
// but the page-list cache populated from /api/documents is keyed by
// case-preserved docName (`README`). Exact `pages.has(target)` never matches,
// and `getWikiLinkResolutionCandidates` adds no candidate when input already
// equals its own slug. Result: every non-lowercase-alphanum filename drop OR
// hand-typed wiki-link (via fallback/create paths in the suggestion menu)
// shows "Page not found" in the PropPanel even though the doc exists.
//
// Fix contract: resolver must recognize case-preserved cache entries. These
// tests pin the case-insensitive fallback behavior so it survives future
// refactors of `buildUnresolvedWikiLinkAttrs` / the slug function / the
// suggestion-menu paths.
describe('isResolvedWikiLinkTarget — case-insensitive resolution against case-preserved pages cache', () => {
  test('lowercased slug resolves against case-preserved cache entry', () => {
    // Simulates: user drops `README.md` → `buildUnresolvedWikiLinkAttrs`
    // stores target='readme'. Cache has 'README' from /api/documents.
    const pages = new Set(['README']);
    expect(isResolvedWikiLinkTarget('readme', pages)).toBe(true);
  });

  test('exact case match still resolves (regression guard)', () => {
    const pages = new Set(['README']);
    expect(isResolvedWikiLinkTarget('README', pages)).toBe(true);
  });

  test('underscore/case filename (BA_for_Depression_Research) resolves', () => {
    // Common real-world shape: snake_case or mixed-case doc names.
    const pages = new Set(['BA_for_Depression_Research']);
    expect(isResolvedWikiLinkTarget('ba-for-depression-research', pages)).toBe(true);
    expect(isResolvedWikiLinkTarget('BA_for_Depression_Research', pages)).toBe(true);
  });

  test('hyphenated slug resolves against hyphenated case-preserved entry', () => {
    const pages = new Set(['My-File']);
    expect(isResolvedWikiLinkTarget('my-file', pages)).toBe(true);
    expect(isResolvedWikiLinkTarget('My-File', pages)).toBe(true);
  });

  test('no spurious match when target is truly absent', () => {
    const pages = new Set(['README', 'AGENTS']);
    expect(isResolvedWikiLinkTarget('nonexistent', pages)).toBe(false);
    expect(isResolvedWikiLinkTarget('somethingelse', pages)).toBe(false);
  });

  test('subdirectory-preserving docName (packages/server/README) resolves case-insensitively', () => {
    // Page cache stores full subdirectory paths like `packages/server/README`.
    // A hand-typed `[[packages/server/README]]` should resolve. The drop
    // flow wouldn't produce this target (file.name is basename-only), but
    // the resolver still needs to work for hand-typed cross-subdir links.
    const pages = new Set(['packages/server/README']);
    expect(isResolvedWikiLinkTarget('packages/server/README', pages)).toBe(true);
    expect(isResolvedWikiLinkTarget('packages/server/readme', pages)).toBe(true);
  });

  test('empty / whitespace target never resolves', () => {
    const pages = new Set(['README']);
    expect(isResolvedWikiLinkTarget('', pages)).toBe(false);
    expect(isResolvedWikiLinkTarget('   ', pages)).toBe(false);
  });
});

describe('canUseTargetAsPathSegment', () => {
  test('accepts plain text and spaces', () => {
    expect(canUseTargetAsPathSegment('Y')).toBe(true);
    expect(canUseTargetAsPathSegment('Page Name')).toBe(true);
  });

  test('rejects path separators, reserved chars, dot/dotdot, trailing dot/space', () => {
    expect(canUseTargetAsPathSegment('Page/Name')).toBe(false);
    expect(canUseTargetAsPathSegment('a\\b')).toBe(false);
    expect(canUseTargetAsPathSegment('Trailing Dot.')).toBe(false);
    expect(canUseTargetAsPathSegment('  ')).toBe(false);
    expect(canUseTargetAsPathSegment('.')).toBe(false);
    expect(canUseTargetAsPathSegment('..')).toBe(false);
    expect(canUseTargetAsPathSegment('a:b')).toBe(false);
  });
});

describe('wikiLinkSuggestedFilename', () => {
  test('preserves a valid unresolved target as the literal filename', () => {
    expect(wikiLinkSuggestedFilename('Y')).toBe('Y.md');
    expect(wikiLinkSuggestedFilename('Page Name')).toBe('Page Name.md');
  });

  test('falls back to slug form for invalid path segments', () => {
    expect(wikiLinkSuggestedFilename('Page/Name')).toBe('page-name.md');
    expect(wikiLinkSuggestedFilename('Trailing Dot.')).toBe('trailing-dot.md');
  });
});

describe('resolveWikiLinkTargetDocName', () => {
  test('returns the docName on direct page-set membership', () => {
    const pages = new Set(['README', 'docs/getting-started']);
    expect(resolveWikiLinkTargetDocName('README', pages)).toBe('README');
    expect(resolveWikiLinkTargetDocName('docs/getting-started', pages)).toBe(
      'docs/getting-started',
    );
  });

  test('returns the case-preserved docName when target is a slug-form alias', () => {
    // Mirrors the dropped-file flow: `README.md` dropped → `buildUnresolvedWikiLinkAttrs`
    // stores target='readme'; cache holds case-preserved 'README'. Without a
    // slug-based fallback, the icon lookup misses and the chip renders
    // iconless even though the page exists.
    const pages = new Set(['README']);
    expect(resolveWikiLinkTargetDocName('readme', pages)).toBe('README');
  });

  test('returns undefined for absent targets', () => {
    const pages = new Set(['README']);
    expect(resolveWikiLinkTargetDocName('does-not-exist', pages)).toBeUndefined();
    expect(resolveWikiLinkTargetDocName('', pages)).toBeUndefined();
    expect(resolveWikiLinkTargetDocName('   ', pages)).toBeUndefined();
  });

  test('handles human-readable targets via slug match', () => {
    const pages = new Set(['nonexistent-page']);
    expect(resolveWikiLinkTargetDocName('Nonexistent Page', pages)).toBe('nonexistent-page');
  });
});

describe('basename resolution — bare-name target finds a file in a subfolder', () => {
  test('resolveWikiLinkTargetDocName matches a same-basename file in a subfolder', () => {
    const pages = new Set(['andrew-data/project-x/analysis']);
    expect(resolveWikiLinkTargetDocName('analysis', pages)).toBe('andrew-data/project-x/analysis');
  });

  test('isResolvedWikiLinkTarget reports resolved for a bare-name → subfolder match', () => {
    const pages = new Set(['andrew-data/project-x/analysis']);
    expect(isResolvedWikiLinkTarget('analysis', pages)).toBe(true);
  });

  test('alphabetical-first tie-break across colliding basenames in different folders', () => {
    const pages = new Set(['z/foo', 'a/foo', 'm/foo']);
    expect(resolveWikiLinkTargetDocName('foo', pages)).toBe('a/foo');
  });

  test('slug-normalized basename matches a Title Case subfolder file', () => {
    const pages = new Set(['subfolder/Project X']);
    expect(resolveWikiLinkTargetDocName('project x', pages)).toBe('subfolder/Project X');
    expect(isResolvedWikiLinkTarget('Project X', pages)).toBe(true);
  });

  test('basename branch ignores path-shaped targets so [[sub/foo]] does not rewrite to other/foo', () => {
    const pages = new Set(['other/foo']);
    expect(resolveWikiLinkTargetDocName('sub/foo', pages)).toBeUndefined();
    expect(isResolvedWikiLinkTarget('sub/foo', pages)).toBe(false);
  });

  test('exact docName match still wins over a same-basename subfolder file', () => {
    const pages = new Set(['foo', 'sub/foo']);
    expect(resolveWikiLinkTargetDocName('foo', pages)).toBe('foo');
  });

  // Production hot path goes through the snapshot fast path
  // (`PageListCacheSnapshot.pagesByBasename`), not the bare-Set scan.
  // Pin parity between the two paths so a future regression in either
  // branch surfaces here.
  test('snapshot input resolves via the prebuilt pagesByBasename index', () => {
    const snapshot = {
      pages: new Set(['andrew-data/project-x/analysis']),
      folderPaths: new Set<string>(),
      pagesBySlug: new Map<string, string>([
        ['andrew-data-project-x-analysis', 'andrew-data/project-x/analysis'],
      ]),
      pagesByBasename: new Map<string, string>([['analysis', 'andrew-data/project-x/analysis']]),
    };
    expect(resolveWikiLinkTargetDocName('analysis', snapshot)).toBe(
      'andrew-data/project-x/analysis',
    );
    expect(isResolvedWikiLinkTarget('analysis', snapshot)).toBe(true);
  });

  test('snapshot input with absent pagesByBasename falls back to slug + exact match only', () => {
    const snapshot = {
      pages: new Set(['andrew-data/project-x/analysis']),
      folderPaths: new Set<string>(),
      pagesBySlug: new Map<string, string>([
        ['andrew-data-project-x-analysis', 'andrew-data/project-x/analysis'],
      ]),
      // pagesByBasename intentionally omitted — backward compat with snapshots
      // that predate the index.
    };
    expect(resolveWikiLinkTargetDocName('analysis', snapshot)).toBeUndefined();
    expect(isResolvedWikiLinkTarget('analysis', snapshot)).toBe(false);
  });

  test('canonical folder-index wins over basename in chip resolution (parity with navigation)', () => {
    // [[reports]] with both `reports/index` and `other/reports` existing —
    // navigation lands on `reports/index` (folder-index), so the chip's
    // icon must come from the same docName. Without folder-index check
    // in the chip resolver, the icon would mismatch the click target.
    const pages = new Set(['reports/index', 'other/reports']);
    expect(resolveWikiLinkTargetDocName('reports', pages)).toBe('reports/index');
    expect(isResolvedWikiLinkTarget('reports', pages)).toBe(true);
  });

  test('legacy folder note wins over basename in chip resolution', () => {
    const pages = new Set(['reports/reports', 'other/reports']);
    expect(resolveWikiLinkTargetDocName('reports', pages)).toBe('reports/reports');
    expect(isResolvedWikiLinkTarget('reports', pages)).toBe(true);
  });

  test('canonical folder-index resolves a path-shaped target via the new branch', () => {
    const pages = new Set(['docs/api/index']);
    expect(resolveWikiLinkTargetDocName('docs/api', pages)).toBe('docs/api/index');
    expect(isResolvedWikiLinkTarget('docs/api', pages)).toBe(true);
  });

  test('legacy folder note resolves a path-shaped target (exercises leaf extraction for nested paths)', () => {
    const pages = new Set(['docs/api/api']);
    expect(resolveWikiLinkTargetDocName('docs/api', pages)).toBe('docs/api/api');
    expect(isResolvedWikiLinkTarget('docs/api', pages)).toBe(true);
  });

  test('snapshot tie-break uses the prebuilt index value, not a Set scan', () => {
    // The snapshot's pagesByBasename is built once and reused. The lookup
    // returns whatever the index holds — alphabetical-first by construction
    // in PageListContext, but the helper does not re-derive. Pin that.
    const snapshot = {
      pages: new Set(['z/foo', 'a/foo']),
      folderPaths: new Set<string>(),
      pagesBySlug: new Map<string, string>(),
      pagesByBasename: new Map<string, string>([['foo', 'a/foo']]),
    };
    expect(resolveWikiLinkTargetDocName('foo', snapshot)).toBe('a/foo');
  });
});
