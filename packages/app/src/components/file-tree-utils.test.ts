import { describe, expect, test } from 'bun:test';
import { type DocumentListEntry, DocumentListEntrySchema } from '@inkeep/open-knowledge-core';
import {
  attributeTreeHiddenAxes,
  classifyEmptyTree,
  computeAncestors,
  defaultInitialDir,
  filterVisibleEntries,
  hasOkPathSegment,
  toFileEntries,
} from './file-tree-utils';

describe('hasOkPathSegment', () => {
  test('matches a .ok segment at root and nested depth', () => {
    expect(hasOkPathSegment('.ok')).toBe(true);
    expect(hasOkPathSegment('.ok/config.yml')).toBe(true);
    expect(hasOkPathSegment('notes/.ok/templates/starter')).toBe(true);
  });

  test('matches case variants, mirroring the server reserved-path guard', () => {
    expect(hasOkPathSegment('.OK')).toBe(true);
    expect(hasOkPathSegment('notes/.Ok/templates')).toBe(true);
  });

  test('does not match lookalike segments or substrings', () => {
    expect(hasOkPathSegment('notes/.okay/file')).toBe(false);
    expect(hasOkPathSegment('book/chapter')).toBe(false);
    expect(hasOkPathSegment('ok/file')).toBe(false);
  });
});

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
    expect(filterVisibleEntries(entries, { showHiddenFiles: true })).toEqual(entries);
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
        { showHiddenFiles: false },
      ),
    ).toEqual([{ kind: 'document', docName: 'README' }]);
  });

  test('showHiddenFiles=true recovers top-level dot-prefixed entries', () => {
    const entries = [
      { kind: 'document' as const, docName: 'README' },
      { kind: 'folder' as const, path: '.claude' },
      { kind: 'document' as const, docName: '.config' },
    ];
    expect(filterVisibleEntries(entries, { showHiddenFiles: true })).toEqual(entries);
  });

  test('showHiddenFiles=true recovers entries nested under a dot-prefixed ancestor', () => {
    const entries = [
      { kind: 'document' as const, docName: '.claude/agents/foo' },
      { kind: 'document' as const, docName: 'brain/.archived/note' },
      { kind: 'document' as const, docName: 'brain/visible' },
      { kind: 'folder' as const, path: 'brain/.archived' },
    ];
    expect(filterVisibleEntries(entries, { showHiddenFiles: true })).toEqual(entries);
  });

  test('showHiddenFiles=true recovers asset entries with dot-prefixed ancestor', () => {
    const entries = [
      { kind: 'asset' as const, path: 'images/logo.png' },
      { kind: 'asset' as const, path: '.attachments/secret.png' },
      { kind: 'asset' as const, path: 'brain/.private/diagram.svg' },
    ];
    expect(filterVisibleEntries(entries, { showHiddenFiles: true })).toEqual(entries);
  });

  test('showHiddenFiles=true still rejects empty-ref entries', () => {
    expect(
      filterVisibleEntries(
        [
          { kind: 'document' as const, docName: '' },
          { kind: 'folder' as const, path: '' },
          { kind: 'document' as const, docName: 'README' },
        ],
        { showHiddenFiles: true },
      ),
    ).toEqual([{ kind: 'document', docName: 'README' }]);
  });

  test('showHiddenFiles toggle is idempotent — applying twice equals applying once', () => {
    const entries = [
      { kind: 'document' as const, docName: 'README' },
      { kind: 'folder' as const, path: '.claude' },
      { kind: 'document' as const, docName: 'brain/.archived/note' },
    ];
    const onceTrue = filterVisibleEntries(entries, { showHiddenFiles: true });
    expect(filterVisibleEntries(onceTrue, { showHiddenFiles: true })).toEqual(onceTrue);
    const onceFalse = filterVisibleEntries(entries, { showHiddenFiles: false });
    expect(filterVisibleEntries(onceFalse, { showHiddenFiles: false })).toEqual(onceFalse);
  });

  test('showHiddenFiles=true → false transition produces today behavior (no leak)', () => {
    const entries = [
      { kind: 'document' as const, docName: 'README' },
      { kind: 'folder' as const, path: '.claude' },
    ];
    const expanded = filterVisibleEntries(entries, { showHiddenFiles: true });
    expect(expanded).toEqual(entries);
    const reduced = filterVisibleEntries(expanded, { showHiddenFiles: false });
    expect(reduced).toEqual([{ kind: 'document', docName: 'README' }]);
  });
});

/**
 * Axis composition for the sidebar visibility model: one orthogonal axis per
 * toggle, composed by AND, all-off defaults reproduce the long-standing
 * hidden-only filter. Each test walks one object class through the
 * hidden-files × only-markdown grid so a regression in a single cell names
 * the exact class that broke.
 */
describe('filterVisibleEntries — axis composition', () => {
  type Axes = NonNullable<Parameters<typeof filterVisibleEntries>[1]>;
  const shows = (
    entry: { kind?: unknown; docName?: string; path?: string },
    axes?: Axes,
  ): boolean => filterVisibleEntries([entry], axes).length === 1;

  const visibleDoc = { kind: 'document' as const, docName: 'notes/todo' };
  const visibleAsset = { kind: 'asset' as const, path: 'src/main.rs' };
  const visibleWireFile = { kind: 'file' as const, path: 'LICENSE' };
  const dotDoc = { kind: 'document' as const, docName: '.scratch/note' };
  const dotAsset = { kind: 'asset' as const, path: '.scratch/data.csv' };
  const visibleFolder = { kind: 'folder' as const, path: 'guides' };
  const dotFolder = { kind: 'folder' as const, path: '.scratch' };

  test('visible markdown doc passes every hidden-files × only-markdown cell', () => {
    expect(shows(visibleDoc, {})).toBe(true);
    expect(shows(visibleDoc, { showHiddenFiles: true })).toBe(true);
    expect(shows(visibleDoc, { showOnlyMarkdownFiles: true })).toBe(true);
    expect(shows(visibleDoc, { showHiddenFiles: true, showOnlyMarkdownFiles: true })).toBe(true);
  });

  test('visible non-markdown leaf hides under only-markdown regardless of hidden-files', () => {
    for (const leaf of [visibleAsset, visibleWireFile]) {
      expect(shows(leaf, {})).toBe(true);
      expect(shows(leaf, { showHiddenFiles: true })).toBe(true);
      expect(shows(leaf, { showOnlyMarkdownFiles: true })).toBe(false);
      expect(shows(leaf, { showHiddenFiles: true, showOnlyMarkdownFiles: true })).toBe(false);
    }
  });

  test('dot-path markdown doc follows hidden-files; only-markdown keeps it', () => {
    expect(shows(dotDoc, {})).toBe(false);
    expect(shows(dotDoc, { showHiddenFiles: true })).toBe(true);
    expect(shows(dotDoc, { showOnlyMarkdownFiles: true })).toBe(false);
    expect(shows(dotDoc, { showHiddenFiles: true, showOnlyMarkdownFiles: true })).toBe(true);
  });

  test('dot-path non-markdown leaf shows only when hidden-files is on and only-markdown off', () => {
    expect(shows(dotAsset, {})).toBe(false);
    expect(shows(dotAsset, { showHiddenFiles: true })).toBe(true);
    expect(shows(dotAsset, { showOnlyMarkdownFiles: true })).toBe(false);
    expect(shows(dotAsset, { showHiddenFiles: true, showOnlyMarkdownFiles: true })).toBe(false);
  });

  test('folders pass the only-markdown axis unconditionally', () => {
    expect(shows(visibleFolder, {})).toBe(true);
    expect(shows(visibleFolder, { showHiddenFiles: true })).toBe(true);
    expect(shows(visibleFolder, { showOnlyMarkdownFiles: true })).toBe(true);
    expect(shows(visibleFolder, { showHiddenFiles: true, showOnlyMarkdownFiles: true })).toBe(true);
  });

  test('dot-folder follows hidden-files; its children are judged per their own axes', () => {
    expect(shows(dotFolder, {})).toBe(false);
    expect(shows(dotFolder, { showOnlyMarkdownFiles: true })).toBe(false);
    expect(shows(dotFolder, { showHiddenFiles: true })).toBe(true);
    const both = { showHiddenFiles: true, showOnlyMarkdownFiles: true };
    expect(shows(dotFolder, both)).toBe(true);
    expect(shows(dotDoc, both)).toBe(true);
    expect(shows(dotAsset, both)).toBe(false);
  });

  const okRootFolder = { kind: 'folder' as const, path: '.ok' };
  const okTemplateDoc = { kind: 'document' as const, docName: '.ok/templates/meeting-notes' };
  const okConfigAsset = { kind: 'asset' as const, path: '.ok/config.yml' };
  const nestedOkDoc = { kind: 'document' as const, docName: 'docs/.ok/templates/spec' };
  const dotAncestorOkDoc = { kind: 'document' as const, docName: '.scratch/.ok/wip' };

  test('hidden-files on never reveals .ok entries — show-ok alone governs them', () => {
    for (const entry of [okRootFolder, okTemplateDoc, okConfigAsset, nestedOkDoc]) {
      expect(shows(entry, { showHiddenFiles: true })).toBe(false);
    }
  });

  test('show-ok reveals root and per-folder .ok entries without hidden-files', () => {
    const okOn = { showOkFolders: true };
    expect(shows(okRootFolder, okOn)).toBe(true);
    expect(shows(okTemplateDoc, okOn)).toBe(true);
    expect(shows(okConfigAsset, okOn)).toBe(true);
    expect(shows(nestedOkDoc, okOn)).toBe(true);
    expect(shows(dotDoc, okOn)).toBe(false);
  });

  test('only-markdown composes inside a revealed .ok', () => {
    const okMd = { showOkFolders: true, showOnlyMarkdownFiles: true };
    expect(shows(okTemplateDoc, okMd)).toBe(true);
    expect(shows(okConfigAsset, okMd)).toBe(false);
    expect(shows(okRootFolder, okMd)).toBe(true);
  });

  test('a dot-segment ancestor above the .ok segment still follows hidden-files', () => {
    expect(shows(dotAncestorOkDoc, { showOkFolders: true })).toBe(false);
    expect(shows(dotAncestorOkDoc, { showOkFolders: true, showHiddenFiles: true })).toBe(true);
  });

  test('.ok entries never appear under default axes', () => {
    expect(filterVisibleEntries([okRootFolder, okTemplateDoc, nestedOkDoc])).toEqual([]);
  });

  test('empty refs stay rejected with every axis on', () => {
    expect(
      filterVisibleEntries([{ kind: 'document' as const, docName: '' }], {
        showHiddenFiles: true,
        showOnlyMarkdownFiles: true,
        showOkFolders: true,
      }),
    ).toEqual([]);
  });

  test('default axes reproduce the pre-axis filter output exactly', () => {
    const entries = [
      visibleDoc,
      visibleAsset,
      visibleWireFile,
      visibleFolder,
      dotDoc,
      dotFolder,
      { kind: 'asset' as const, path: 'opencode.json' },
      okTemplateDoc,
      { kind: 'document' as const, docName: '' },
    ];
    expect(filterVisibleEntries(entries)).toEqual([
      visibleDoc,
      visibleAsset,
      visibleWireFile,
      visibleFolder,
    ]);
  });
});

/**
 * attributeTreeHiddenAxes — per-axis attribution for the editor's
 * not-in-sidebar indicator. The contract mirrors filterVisibleEntries clause
 * by clause: an axis is attributed exactly when its filter clause is what
 * drops the entry, and refs outside the tree's domain (managed-artifact
 * names, `.ok` paths) attribute nothing — blaming a toggle that cannot
 * reveal them would be a lie.
 */
describe('attributeTreeHiddenAxes', () => {
  const none = { hiddenFiles: false, onlyMarkdownFiles: false };

  test('dot-path markdown doc attributes hidden-files at defaults', () => {
    expect(attributeTreeHiddenAxes({ kind: 'document', docName: '.scratch/note' })).toEqual({
      hiddenFiles: true,
      onlyMarkdownFiles: false,
    });
  });

  test('dot-path markdown doc attributes nothing once hidden-files is on', () => {
    expect(
      attributeTreeHiddenAxes(
        { kind: 'document', docName: '.scratch/note' },
        { showHiddenFiles: true },
      ),
    ).toEqual(none);
  });

  test('non-markdown file attributes only-markdown when the toggle is on', () => {
    expect(
      attributeTreeHiddenAxes({ kind: 'asset', path: 'data.csv' }, { showOnlyMarkdownFiles: true }),
    ).toEqual({ hiddenFiles: false, onlyMarkdownFiles: true });
  });

  test('non-markdown file attributes nothing at defaults', () => {
    expect(attributeTreeHiddenAxes({ kind: 'asset', path: 'data.csv' })).toEqual(none);
  });

  test('dot-path non-markdown file attributes both axes; flipping one leaves the other', () => {
    const entry = { kind: 'asset' as const, path: '.scratch/data.csv' };
    expect(attributeTreeHiddenAxes(entry, { showOnlyMarkdownFiles: true })).toEqual({
      hiddenFiles: true,
      onlyMarkdownFiles: true,
    });
    expect(
      attributeTreeHiddenAxes(entry, { showHiddenFiles: true, showOnlyMarkdownFiles: true }),
    ).toEqual({ hiddenFiles: false, onlyMarkdownFiles: true });
    expect(attributeTreeHiddenAxes(entry, { showHiddenFiles: true })).toEqual(none);
  });

  test('visible markdown doc attributes nothing in every axis cell', () => {
    const entry = { kind: 'document' as const, docName: 'notes/todo' };
    for (const showHiddenFiles of [false, true]) {
      for (const showOnlyMarkdownFiles of [false, true]) {
        expect(attributeTreeHiddenAxes(entry, { showHiddenFiles, showOnlyMarkdownFiles })).toEqual(
          none,
        );
      }
    }
  });

  test('.ok paths attribute nothing — the O axis alone governs them', () => {
    for (const ref of ['.ok/skills/writer/SKILL', '.ok/templates/meeting', 'docs/.ok/config.yml']) {
      expect(attributeTreeHiddenAxes({ kind: 'document', docName: ref })).toEqual(none);
      expect(
        attributeTreeHiddenAxes(
          { kind: 'asset', path: ref },
          { showHiddenFiles: false, showOnlyMarkdownFiles: true },
        ),
      ).toEqual(none);
    }
  });

  test('managed-artifact doc names attribute nothing, even with dot segments inside', () => {
    // The template form embeds its owning folder, which can itself be a dot
    // path — without the managed-name guard that would misattribute
    // hidden-files to a doc that never has a tree row.
    for (const ref of ['__skill__/global/writer', '__template__/.private/meeting-notes']) {
      expect(attributeTreeHiddenAxes({ kind: 'document', docName: ref })).toEqual(none);
      expect(
        attributeTreeHiddenAxes(
          { kind: 'document', docName: ref },
          { showOnlyMarkdownFiles: true },
        ),
      ).toEqual(none);
    }
  });

  test('empty refs attribute nothing', () => {
    expect(attributeTreeHiddenAxes({ kind: 'document', docName: '' })).toEqual(none);
  });

  test('agrees with filterVisibleEntries: axes attributed ⇔ the filter drops the entry', () => {
    const entries = [
      { kind: 'document' as const, docName: 'notes/todo' },
      { kind: 'document' as const, docName: '.scratch/note' },
      { kind: 'asset' as const, path: 'data.csv' },
      { kind: 'asset' as const, path: '.scratch/data.csv' },
      { kind: 'file' as const, path: 'LICENSE' },
      { kind: 'folder' as const, path: 'guides' },
      { kind: 'folder' as const, path: '.scratch' },
      { kind: 'asset' as const, path: 'opencode.json' },
    ];
    for (const entry of entries) {
      for (const showHiddenFiles of [false, true]) {
        for (const showOnlyMarkdownFiles of [false, true]) {
          const axes = { showHiddenFiles, showOnlyMarkdownFiles };
          const attributed = attributeTreeHiddenAxes(entry, axes);
          const dropped = filterVisibleEntries([entry], axes).length === 0;
          expect(attributed.hiddenFiles || attributed.onlyMarkdownFiles).toBe(dropped);
        }
      }
    }
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

/**
 * classifyEmptyTree — the filtered-vs-truly-empty split behind the tree's
 * empty slot. Callers invoke it only once the rendered (filtered) tree is
 * empty; the classifier decides which empty state that is from the two
 * unfiltered-nonempty signals (pre-filter root listing count, indexed page
 * set) plus the active axes.
 */
describe('classifyEmptyTree', () => {
  test('only-markdown hiding a non-empty root listing classifies filtered-to-zero', () => {
    expect(
      classifyEmptyTree({
        visibility: { showOnlyMarkdownFiles: true },
        unfilteredRootEntryCount: 3,
        knownPageCount: 0,
      }),
    ).toBe('filtered-to-zero');
  });

  test('the indexed page set alone marks the project non-empty', () => {
    expect(
      classifyEmptyTree({
        visibility: { showOnlyMarkdownFiles: true },
        unfilteredRootEntryCount: 0,
        knownPageCount: 2,
      }),
    ).toBe('filtered-to-zero');
  });

  test('no entries from either signal is true-empty regardless of toggles', () => {
    expect(
      classifyEmptyTree({
        visibility: { showHiddenFiles: true, showOnlyMarkdownFiles: true },
        unfilteredRootEntryCount: 0,
        knownPageCount: 0,
      }),
    ).toBe('true-empty');
  });

  test('defaults keep the pre-feature empty state: a dot-only project is true-empty', () => {
    // With every axis at its default, an empty render means every listing
    // entry is default-hidden (dot paths) — the long-standing "No files yet"
    // state. Resetting toggles to defaults could not change it, so the reset
    // affordance must not be offered.
    expect(classifyEmptyTree({ unfilteredRootEntryCount: 4, knownPageCount: 4 })).toBe(
      'true-empty',
    );
  });

  test('reveal-only axes never classify filtered-to-zero', () => {
    for (const visibility of [{ showHiddenFiles: true }, { showOkFolders: true }]) {
      expect(
        classifyEmptyTree({ visibility, unfilteredRootEntryCount: 2, knownPageCount: 0 }),
      ).toBe('true-empty');
    }
  });

  test('hidden-files on does not neutralize the only-markdown classification', () => {
    expect(
      classifyEmptyTree({
        visibility: { showHiddenFiles: true, showOnlyMarkdownFiles: true },
        unfilteredRootEntryCount: 1,
        knownPageCount: 0,
      }),
    ).toBe('filtered-to-zero');
  });
});
