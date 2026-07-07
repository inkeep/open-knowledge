import { describe, expect, test } from 'bun:test';
import { type DocumentListEntry, DocumentListEntrySchema } from '@inkeep/open-knowledge-core';
import {
  computeAncestors,
  defaultInitialDir,
  filterVisibleEntries,
  toFileEntries,
} from './file-tree-utils';

describe('computeAncestors', () => {
  test('returns empty array for null', () => {
    expect(computeAncestors(null)).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(computeAncestors('')).toEqual([]);
  });

  test('returns empty array for top-level docName', () => {
    expect(computeAncestors('README')).toEqual([]);
  });

  test('returns single ancestor for one-level nesting', () => {
    expect(computeAncestors('docs/guide')).toEqual(['docs']);
  });

  test('returns ancestors from shallowest to deepest for multi-level path', () => {
    expect(computeAncestors('a/b/c')).toEqual(['a', 'a/b']);
  });

  test('handles deeply nested paths', () => {
    expect(computeAncestors('a/b/c/d/e')).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/d']);
  });
});

describe('defaultInitialDir', () => {
  test('returns empty string for null', () => {
    expect(defaultInitialDir(null)).toBe('');
  });

  test('returns empty string for root-level file', () => {
    expect(defaultInitialDir('README')).toBe('');
  });

  test('returns parent directory for nested file', () => {
    expect(defaultInitialDir('docs/guide')).toBe('docs');
  });

  test('returns deepest parent for deeply nested file', () => {
    expect(defaultInitialDir('a/b/c/d')).toBe('a/b/c');
  });

  test('returns empty string for empty string', () => {
    expect(defaultInitialDir('')).toBe('');
  });
});

/**
 * filterVisibleEntries — sidebar render-set parallel to EmptyEditorState.countEntries()'s
 * hidden rule. Both surfaces delegate to core's `isHiddenDocName`: a per-segment
 * dot-prefix check at any depth (so a top-level-only check would miss
 * `brain/.archived/note.md`) plus the non-dotted `HIDDEN_CONFIG_BASENAMES`
 * allowlist (e.g. `opencode.json`). Without this filter, `.claude/`, `.codex/`,
 * `.cursor/`, and the seeded `opencode.json` agent config leak into the
 * sidebar's @pierre/trees model (FileTree.tsx ingestion at setDocuments).
 */
describe('filterVisibleEntries', () => {
  test('keeps top-level visible document and folder entries', () => {
    const entries = [
      { kind: 'document' as const, docName: 'README' },
      { kind: 'folder' as const, path: 'brain' },
    ];
    expect(filterVisibleEntries(entries)).toEqual(entries);
  });

  test('hides top-level dot-prefixed document and folder entries', () => {
    expect(
      filterVisibleEntries([
        { kind: 'document' as const, docName: 'README' },
        { kind: 'folder' as const, path: '.claude' },
        { kind: 'folder' as const, path: '.cursor' },
        { kind: 'document' as const, docName: '.config' },
      ]),
    ).toEqual([{ kind: 'document', docName: 'README' }]);
  });

  test('hides entries nested under a dot-prefixed ancestor at any depth', () => {
    expect(
      filterVisibleEntries([
        { kind: 'document' as const, docName: '.claude/agents/foo' },
        { kind: 'document' as const, docName: 'brain/.archived/note' },
        { kind: 'document' as const, docName: 'brain/visible' },
        { kind: 'folder' as const, path: 'brain/.archived' },
      ]),
    ).toEqual([{ kind: 'document', docName: 'brain/visible' }]);
  });

  test('hides asset entries when an ancestor segment is dot-prefixed', () => {
    expect(
      filterVisibleEntries([
        { kind: 'asset' as const, path: 'images/logo.png' },
        { kind: 'asset' as const, path: '.attachments/secret.png' },
        { kind: 'asset' as const, path: 'brain/.private/diagram.svg' },
      ]),
    ).toEqual([{ kind: 'asset', path: 'images/logo.png' }]);
  });

  test('hides the non-dotted opencode.json agent config at root and nested', () => {
    expect(
      filterVisibleEntries([
        { kind: 'document' as const, docName: 'README' },
        { kind: 'asset' as const, path: 'opencode.json' },
        { kind: 'asset' as const, path: 'tools/opencode.json' },
      ]),
    ).toEqual([{ kind: 'document', docName: 'README' }]);
  });

  test('showHiddenFiles=true reveals opencode.json', () => {
    const entries = [
      { kind: 'document' as const, docName: 'README' },
      { kind: 'asset' as const, path: 'opencode.json' },
    ];
    expect(filterVisibleEntries(entries, true)).toEqual(entries);
  });

  test('returns empty array when every entry is hidden', () => {
    expect(
      filterVisibleEntries([
        { kind: 'folder' as const, path: '.claude' },
        { kind: 'document' as const, docName: '.claude/agents/foo' },
        { kind: 'folder' as const, path: '.codex' },
        { kind: 'asset' as const, path: 'opencode.json' },
      ]),
    ).toEqual([]);
  });

  test('default (showHiddenFiles unset) preserves today behavior — dot-segments dropped', () => {
    expect(
      filterVisibleEntries([
        { kind: 'document' as const, docName: 'README' },
        { kind: 'folder' as const, path: '.claude' },
      ]),
    ).toEqual([{ kind: 'document', docName: 'README' }]);
  });

  test('showHiddenFiles=false (explicit) preserves today behavior', () => {
    expect(
      filterVisibleEntries(
        [
          { kind: 'document' as const, docName: 'README' },
          { kind: 'folder' as const, path: '.claude' },
        ],
        false,
      ),
    ).toEqual([{ kind: 'document', docName: 'README' }]);
  });

  test('showHiddenFiles=true recovers top-level dot-prefixed entries', () => {
    const entries = [
      { kind: 'document' as const, docName: 'README' },
      { kind: 'folder' as const, path: '.claude' },
      { kind: 'document' as const, docName: '.config' },
    ];
    expect(filterVisibleEntries(entries, true)).toEqual(entries);
  });

  test('showHiddenFiles=true recovers entries nested under a dot-prefixed ancestor', () => {
    const entries = [
      { kind: 'document' as const, docName: '.claude/agents/foo' },
      { kind: 'document' as const, docName: 'brain/.archived/note' },
      { kind: 'document' as const, docName: 'brain/visible' },
      { kind: 'folder' as const, path: 'brain/.archived' },
    ];
    expect(filterVisibleEntries(entries, true)).toEqual(entries);
  });

  test('showHiddenFiles=true recovers asset entries with dot-prefixed ancestor', () => {
    const entries = [
      { kind: 'asset' as const, path: 'images/logo.png' },
      { kind: 'asset' as const, path: '.attachments/secret.png' },
      { kind: 'asset' as const, path: 'brain/.private/diagram.svg' },
    ];
    expect(filterVisibleEntries(entries, true)).toEqual(entries);
  });

  test('showHiddenFiles=true still rejects empty-ref entries', () => {
    expect(
      filterVisibleEntries(
        [
          { kind: 'document' as const, docName: '' },
          { kind: 'folder' as const, path: '' },
          { kind: 'document' as const, docName: 'README' },
        ],
        true,
      ),
    ).toEqual([{ kind: 'document', docName: 'README' }]);
  });

  test('showHiddenFiles toggle is idempotent — applying twice equals applying once', () => {
    const entries = [
      { kind: 'document' as const, docName: 'README' },
      { kind: 'folder' as const, path: '.claude' },
      { kind: 'document' as const, docName: 'brain/.archived/note' },
    ];
    const onceTrue = filterVisibleEntries(entries, true);
    expect(filterVisibleEntries(onceTrue, true)).toEqual(onceTrue);
    const onceFalse = filterVisibleEntries(entries, false);
    expect(filterVisibleEntries(onceFalse, false)).toEqual(onceFalse);
  });

  test('showHiddenFiles=true → false transition produces today behavior (no leak)', () => {
    const entries = [
      { kind: 'document' as const, docName: 'README' },
      { kind: 'folder' as const, path: '.claude' },
    ];
    const expanded = filterVisibleEntries(entries, true);
    expect(expanded).toEqual(entries);
    const reduced = filterVisibleEntries(expanded, false);
    expect(reduced).toEqual([{ kind: 'document', docName: 'README' }]);
  });
});

/**
 * toFileEntries — the wire→sidebar boundary. Fixtures go through the real
 * schema parse so the test exercises exactly the handoff the FileTree fetch
 * paths perform; every optional FileEntry field is asserted explicitly because
 * omitting one in the mapper (e.g. dropping `isSymlink`) still compiles.
 */
describe('toFileEntries', () => {
  const modified = '2026-06-12T00:00:00.000Z';

  test('maps schema-parsed wire entries to per-kind FileEntry shapes', () => {
    const wire = [
      {
        kind: 'document',
        docName: 'brain/note',
        docExt: '.mdx',
        size: 7,
        modified,
        isSymlink: true,
        canonicalDocName: 'brain/canonical',
        targetPath: 'brain/canonical.mdx',
      },
      {
        kind: 'asset',
        path: 'images/logo.png',
        assetExt: '.png',
        referencedBy: ['brain/note'],
        size: 9,
        modified,
      },
      { kind: 'folder', path: 'team', size: 0, modified, hasChildren: true },
    ].map((entry) => DocumentListEntrySchema.parse(entry));

    expect(toFileEntries(wire)).toEqual([
      {
        kind: 'document',
        docName: 'brain/note',
        docExt: '.mdx',
        size: 7,
        modified,
        isSymlink: true,
        canonicalDocName: 'brain/canonical',
        targetPath: 'brain/canonical.mdx',
      },
      {
        kind: 'asset',
        path: 'images/logo.png',
        assetExt: '.png',
        mediaKind: null,
        size: 9,
        modified,
        referencedBy: ['brain/note'],
      },
      {
        kind: 'folder',
        path: 'team',
        size: 0,
        modified,
        hasChildren: true,
        isSymlink: false,
        targetPath: null,
      },
    ]);
  });

  test('carries isSymlink + targetPath through for a symlinked folder', () => {
    const wire = [
      DocumentListEntrySchema.parse({
        kind: 'folder',
        path: 'alias-A',
        size: 0,
        modified,
        hasChildren: true,
        isSymlink: true,
        canonicalDocName: 'canonical-folder',
        targetPath: 'canonical-folder',
      }),
    ];
    expect(toFileEntries(wire)).toEqual([
      {
        kind: 'folder',
        path: 'alias-A',
        size: 0,
        modified,
        hasChildren: true,
        isSymlink: true,
        targetPath: 'canonical-folder',
      },
    ]);
  });

  test('carries a populated asset mediaKind through unchanged', () => {
    const wire = [
      DocumentListEntrySchema.parse({
        kind: 'asset',
        path: 'images/demo.mp4',
        assetExt: '.mp4',
        mediaKind: 'video',
        referencedBy: [],
        size: 3,
        modified,
      }),
    ];
    expect(toFileEntries(wire)).toEqual([
      {
        kind: 'asset',
        path: 'images/demo.mp4',
        assetExt: '.mp4',
        mediaKind: 'video',
        size: 3,
        modified,
        referencedBy: [],
      },
    ]);
  });

  test('skips entries the static type admits but the wire refine forbids', () => {
    // Constructible because the inferred type leaves variant fields optional
    // (refine guarantees are runtime-only) — the mapper must drop these
    // rather than fabricate entries with missing identity refs.
    const malformed: DocumentListEntry[] = [
      {
        kind: 'document',
        docExt: '.md',
        size: 1,
        modified,
        isSymlink: false,
        canonicalDocName: null,
        targetPath: null,
      },
      {
        kind: 'asset',
        path: 'images/orphan.png',
        docExt: '.md',
        size: 1,
        modified,
        isSymlink: false,
        canonicalDocName: null,
        targetPath: null,
      },
      {
        kind: 'folder',
        docExt: '.md',
        size: 0,
        modified,
        isSymlink: false,
        canonicalDocName: null,
        targetPath: null,
      },
    ];
    expect(toFileEntries(malformed)).toEqual([]);
  });
});
