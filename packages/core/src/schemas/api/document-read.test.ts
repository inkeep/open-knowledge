import { describe, expect, test } from 'bun:test';
import {
  BacklinkCountsSuccessSchema,
  BacklinkEntrySchema,
  BacklinksSuccessSchema,
  DocumentListEntrySchema,
  DocumentListSuccessSchema,
  DocumentReadSuccessSchema,
  ForwardLinkDocEntrySchema,
  ForwardLinkEntrySchema,
  ForwardLinkExternalEntrySchema,
  ForwardLinksSuccessSchema,
  LinkGraphDocNodeSchema,
  LinkGraphEdgeSchema,
  LinkGraphExternalNodeSchema,
  LinkGraphNodeSchema,
  LinkGraphSuccessSchema,
  ProblemTypeSchema,
} from './index.ts';

describe('ProblemTypeSchema cluster C URN tokens', () => {
  test('document-not-available is valid', () => {
    expect(ProblemTypeSchema.safeParse('urn:ok:error:doc-not-available').success).toBe(true);
  });
  test('backlink-index-not-configured is valid', () => {
    expect(ProblemTypeSchema.safeParse('urn:ok:error:backlink-index-not-configured').success).toBe(
      true,
    );
  });
});

// ─── read endpoint success schemas ────────────────────────────

describe('DocumentReadSuccessSchema', () => {
  test('parses a flat success body with lifecycle: null (no status set)', () => {
    expect(
      DocumentReadSuccessSchema.safeParse({
        docName: 'foo',
        content: '# hi\n\nbody',
        lifecycle: null,
      }).success,
    ).toBe(true);
  });
  test('parses a body with populated lifecycle (FR8 / D12 — conflict state)', () => {
    expect(
      DocumentReadSuccessSchema.safeParse({
        docName: 'foo',
        content: '<<<<<<<\nours\n=======\ntheirs\n>>>>>>>\n',
        lifecycle: { status: 'conflict', reason: 'conflict-markers' },
      }).success,
    ).toBe(true);
  });
  test('parses an empty content string', () => {
    expect(
      DocumentReadSuccessSchema.safeParse({ docName: 'foo', content: '', lifecycle: null }).success,
    ).toBe(true);
  });
  test('rejects missing content', () => {
    expect(DocumentReadSuccessSchema.safeParse({ docName: 'foo', lifecycle: null }).success).toBe(
      false,
    );
  });
  test('rejects empty docName', () => {
    expect(
      DocumentReadSuccessSchema.safeParse({ docName: '', content: 'x', lifecycle: null }).success,
    ).toBe(false);
  });
  test('rejects missing lifecycle field (D12 — always-include for SDK type stability)', () => {
    expect(DocumentReadSuccessSchema.safeParse({ docName: 'foo', content: 'x' }).success).toBe(
      false,
    );
  });
});

describe('DocumentListEntrySchema', () => {
  test('parses a non-symlink entry', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        docName: 'pages/foo',
        docExt: '.md',
        size: 142,
        modified: '2026-04-30T00:00:00Z',
        isSymlink: false,
        canonicalDocName: null,
        targetPath: null,
      }).success,
    ).toBe(true);
  });
  test('parses a symlink alias entry', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        docName: 'foo',
        docExt: '.md',
        size: 142,
        modified: '2026-04-30T00:00:00Z',
        isSymlink: true,
        canonicalDocName: 'target',
        targetPath: 'target.md',
      }).success,
    ).toBe(true);
  });
  test('rejects negative size', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        docName: 'foo',
        docExt: '.md',
        size: -1,
        modified: '2026-04-30T00:00:00Z',
        isSymlink: false,
        canonicalDocName: null,
        targetPath: null,
      }).success,
    ).toBe(false);
  });
  test('parses an asset entry with mediaKind: image', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'asset',
        docName: 'media/photo.png',
        docExt: '.png',
        size: 4096,
        modified: '2026-04-30T00:00:00Z',
        isSymlink: false,
        canonicalDocName: null,
        targetPath: null,
        path: 'media/photo.png',
        assetExt: '.png',
        mediaKind: 'image',
        referencedBy: ['guide'],
      }).success,
    ).toBe(true);
  });
  test('parses an asset entry with mediaKind: video', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'asset',
        docName: 'media/clip.mp4',
        docExt: '.mp4',
        size: 1048576,
        modified: '2026-04-30T00:00:00Z',
        isSymlink: false,
        canonicalDocName: null,
        targetPath: null,
        path: 'media/clip.mp4',
        assetExt: '.mp4',
        mediaKind: 'video',
        referencedBy: ['guide'],
      }).success,
    ).toBe(true);
  });
  test('parses an asset entry with mediaKind: null (non-renderable extension)', () => {
    // Regression guard: server emits `mediaKind: null` for asset entries whose
    // extension is in ASSET_EXTENSIONS but not in SIDEBAR_RENDERABLE_ASSET_EXTENSIONS
    // (e.g. `.csv`, `.docx`, `.zip` — types with no inline preview). Schema must
    // accept the `null` discriminant.
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'asset',
        docName: 'media/data.csv',
        docExt: '.csv',
        size: 2048,
        modified: '2026-04-30T00:00:00Z',
        isSymlink: false,
        canonicalDocName: null,
        targetPath: null,
        path: 'media/data.csv',
        assetExt: '.csv',
        mediaKind: null,
        referencedBy: ['guide'],
      }).success,
    ).toBe(true);
  });

  test('parses asset entries with mediaKind: pdf and audio (sidebar-renderable)', () => {
    // Pins the schema-side acceptance of the two media kinds added when
    // `<Pdf>` + `<audio>` rendering joined `AssetPreview` (`.pdf` and the
    // `AUDIO_EXTENSIONS` set classify here now instead of falling to null).
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'asset',
        docName: 'media/paper.pdf',
        docExt: '.pdf',
        size: 4096,
        modified: '2026-04-30T00:00:00Z',
        isSymlink: false,
        canonicalDocName: null,
        targetPath: null,
        path: 'media/paper.pdf',
        assetExt: '.pdf',
        mediaKind: 'pdf',
        referencedBy: ['guide'],
      }).success,
    ).toBe(true);
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'asset',
        docName: 'media/song.mp3',
        docExt: '.mp3',
        size: 8192,
        modified: '2026-04-30T00:00:00Z',
        isSymlink: false,
        canonicalDocName: null,
        targetPath: null,
        path: 'media/song.mp3',
        assetExt: '.mp3',
        mediaKind: 'audio',
        referencedBy: ['guide'],
      }).success,
    ).toBe(true);
  });
  test('parses a folder entry with path only', () => {
    // Folder variant wired the
    // folder-index → /api/documents emission path. Pin the refine
    // contract: folders carry `path`, no `docName`, no asset fields.
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'folder',
        path: 'notes/empty',
        size: 0,
        modified: '2026-04-30T00:00:00Z',
      }).success,
    ).toBe(true);
  });
  test('rejects a folder entry with docName present', () => {
    // Folder rows aren't documents — admitting `docName` on the folder
    // variant would let the sidebar key on a phantom doc and silently
    // route folder clicks through the document-open path.
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'folder',
        docName: 'notes/empty',
        path: 'notes/empty',
        size: 0,
        modified: '2026-04-30T00:00:00Z',
      }).success,
    ).toBe(false);
  });
  test('rejects a folder entry without path', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'folder',
        size: 0,
        modified: '2026-04-30T00:00:00Z',
      }).success,
    ).toBe(false);
  });
  test('rejects a folder entry with asset fields populated', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'folder',
        path: 'notes/empty',
        assetExt: '.png',
        referencedBy: ['guide'],
        size: 0,
        modified: '2026-04-30T00:00:00Z',
      }).success,
    ).toBe(false);
  });
  // the `kind:'file'` variant is the wire shape that lets
  // /api/documents list ALL ContentFilter-passing non-markdown files (not just
  // referenced renderable assets), so the omnibar + tree see the same set.
  test('parses a file entry with path (and optional assetExt)', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'file',
        path: 'packages/app/src/components/FileTree.tsx',
        size: 4096,
        modified: '2026-04-30T00:00:00Z',
        assetExt: 'tsx',
      }).success,
    ).toBe(true);
  });
  test('parses a file entry with no extension', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'file',
        path: 'LICENSE',
        size: 1024,
        modified: '2026-04-30T00:00:00Z',
      }).success,
    ).toBe(true);
  });
  test('parses a file entry with docName mirror of path', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'file',
        docName: 'data/example.csv',
        path: 'data/example.csv',
        size: 64,
        modified: '2026-04-30T00:00:00Z',
      }).success,
    ).toBe(true);
  });
  test('rejects a file entry without path', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'file',
        size: 0,
        modified: '2026-04-30T00:00:00Z',
      }).success,
    ).toBe(false);
  });
  test('rejects a file entry with mediaKind populated', () => {
    // `mediaKind` is reserved for the renderable-asset variant — letting a
    // 'file' entry carry it would conflate the asset/file split.
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'file',
        path: 'data/example.csv',
        size: 0,
        modified: '2026-04-30T00:00:00Z',
        mediaKind: 'text',
      }).success,
    ).toBe(false);
  });
  test('rejects a file entry with referencedBy populated', () => {
    expect(
      DocumentListEntrySchema.safeParse({
        kind: 'file',
        path: 'data/example.csv',
        size: 0,
        modified: '2026-04-30T00:00:00Z',
        referencedBy: ['guide'],
      }).success,
    ).toBe(false);
  });
});

describe('DocumentListSuccessSchema', () => {
  test('parses an empty list', () => {
    expect(DocumentListSuccessSchema.safeParse({ documents: [] }).success).toBe(true);
  });
  test('parses a populated list', () => {
    expect(
      DocumentListSuccessSchema.safeParse({
        documents: [
          {
            docName: 'foo',
            docExt: '.md',
            size: 0,
            modified: '2026-04-30T00:00:00Z',
            isSymlink: false,
            canonicalDocName: null,
            targetPath: null,
          },
        ],
      }).success,
    ).toBe(true);
  });
  test('parses a mixed list with document + asset (mediaKind: null) variants', () => {
    expect(
      DocumentListSuccessSchema.safeParse({
        documents: [
          {
            kind: 'document',
            docName: 'guide',
            docExt: '.md',
            size: 32,
            modified: '2026-04-30T00:00:00Z',
            isSymlink: false,
            canonicalDocName: null,
            targetPath: null,
          },
          {
            kind: 'asset',
            docName: 'media/spec.pdf',
            docExt: '.pdf',
            size: 2048,
            modified: '2026-04-30T00:00:00Z',
            isSymlink: false,
            canonicalDocName: null,
            targetPath: null,
            path: 'media/spec.pdf',
            assetExt: '.pdf',
            mediaKind: null,
            referencedBy: ['guide'],
          },
        ],
      }).success,
    ).toBe(true);
  });
  test('round-trips all three truncated shapes: true / false / absent (QA-009 / AC4)', () => {
    // The `?showAll=true` walk sets `truncated` only when it hit its entry
    // ceiling. The field is optional so the index-backed branch (never sets
    // it) and legacy clients stay valid — assert all three shapes parse AND
    // surface the expected value, not just that parsing succeeds.
    const truncatedTrue = DocumentListSuccessSchema.safeParse({ documents: [], truncated: true });
    expect(truncatedTrue.success).toBe(true);
    if (truncatedTrue.success) expect(truncatedTrue.data.truncated).toBe(true);

    const truncatedFalse = DocumentListSuccessSchema.safeParse({ documents: [], truncated: false });
    expect(truncatedFalse.success).toBe(true);
    if (truncatedFalse.success) expect(truncatedFalse.data.truncated).toBe(false);

    const absent = DocumentListSuccessSchema.safeParse({ documents: [] });
    expect(absent.success).toBe(true);
    if (absent.success) expect(absent.data.truncated).toBeUndefined();
  });
  test('rejects a non-boolean truncated value', () => {
    expect(DocumentListSuccessSchema.safeParse({ documents: [], truncated: 'yes' }).success).toBe(
      false,
    );
  });
});

describe('BacklinkEntrySchema', () => {
  test('parses with anchor + snippet present', () => {
    expect(
      BacklinkEntrySchema.safeParse({
        source: 'alpha',
        anchor: 'intro',
        title: 'Alpha',
        snippet: 'Refers to beta.',
      }).success,
    ).toBe(true);
  });
  test('parses with null anchor + snippet', () => {
    expect(
      BacklinkEntrySchema.safeParse({
        source: 'alpha',
        anchor: null,
        title: 'Alpha',
        snippet: null,
      }).success,
    ).toBe(true);
  });
  test('rejects empty source', () => {
    expect(
      BacklinkEntrySchema.safeParse({
        source: '',
        anchor: null,
        title: 'Alpha',
        snippet: null,
      }).success,
    ).toBe(false);
  });
});

describe('BacklinksSuccessSchema', () => {
  test('parses success body with empty backlinks', () => {
    expect(BacklinksSuccessSchema.safeParse({ docName: 'beta', backlinks: [] }).success).toBe(true);
  });
});

describe('BacklinkCountsSuccessSchema', () => {
  test('parses an empty count map', () => {
    expect(BacklinkCountsSuccessSchema.safeParse({ counts: {} }).success).toBe(true);
  });
  test('parses populated counts', () => {
    expect(
      BacklinkCountsSuccessSchema.safeParse({ counts: { alpha: 3, beta: 0, gamma: 12 } }).success,
    ).toBe(true);
  });
  test('rejects negative counts', () => {
    expect(BacklinkCountsSuccessSchema.safeParse({ counts: { alpha: -1 } }).success).toBe(false);
  });
});

describe('ForwardLinkEntrySchema', () => {
  test('parses doc kind', () => {
    expect(
      ForwardLinkDocEntrySchema.safeParse({
        kind: 'doc',
        docName: 'beta',
        anchor: null,
        title: 'Beta',
        snippet: null,
      }).success,
    ).toBe(true);
  });
  test('parses external kind', () => {
    expect(
      ForwardLinkExternalEntrySchema.safeParse({
        kind: 'external',
        url: 'https://example.com/x',
        title: 'X',
        snippet: null,
      }).success,
    ).toBe(true);
  });
  test('discriminated union routes by kind', () => {
    const docResult = ForwardLinkEntrySchema.safeParse({
      kind: 'doc',
      docName: 'beta',
      anchor: 'h1',
      title: 'Beta',
      snippet: 'snippet',
    });
    expect(docResult.success).toBe(true);
    if (docResult.success) {
      expect(docResult.data.kind).toBe('doc');
    }

    const extResult = ForwardLinkEntrySchema.safeParse({
      kind: 'external',
      url: 'https://example.com',
      title: 'Example',
      snippet: null,
    });
    expect(extResult.success).toBe(true);
    if (extResult.success) {
      expect(extResult.data.kind).toBe('external');
    }
  });
  test('rejects unknown kind', () => {
    expect(ForwardLinkEntrySchema.safeParse({ kind: 'mystery' }).success).toBe(false);
  });
});

describe('ForwardLinksSuccessSchema', () => {
  test('parses success body', () => {
    expect(
      ForwardLinksSuccessSchema.safeParse({
        docName: 'alpha',
        forwardLinks: [
          { kind: 'doc', docName: 'beta', anchor: null, title: 'Beta', snippet: null },
          {
            kind: 'external',
            url: 'https://example.com',
            title: 'Example',
            snippet: null,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('LinkGraphNodeSchema', () => {
  test('parses doc node with metadata', () => {
    expect(
      LinkGraphDocNodeSchema.safeParse({
        id: 'doc:foo',
        kind: 'doc',
        docName: 'foo',
        anchor: null,
        label: 'Foo',
        cluster: 'retrieval',
        category: 'concept',
        tags: ['search', 'vectors'],
      }).success,
    ).toBe(true);
  });
  test('parses doc node with all metadata null', () => {
    expect(
      LinkGraphDocNodeSchema.safeParse({
        id: 'doc:foo',
        kind: 'doc',
        docName: 'foo',
        anchor: null,
        label: 'Foo',
        cluster: null,
        category: null,
        tags: null,
      }).success,
    ).toBe(true);
  });
  test('parses external node', () => {
    expect(
      LinkGraphExternalNodeSchema.safeParse({
        id: 'ext:https://example.com',
        kind: 'external',
        url: 'https://example.com',
        label: 'Example',
      }).success,
    ).toBe(true);
  });
  test('discriminated union rejects unknown kind', () => {
    expect(LinkGraphNodeSchema.safeParse({ id: 'a', kind: 'mystery' }).success).toBe(false);
  });
});

describe('LinkGraphEdgeSchema', () => {
  test('parses an edge', () => {
    expect(LinkGraphEdgeSchema.safeParse({ source: 'doc:a', target: 'doc:b' }).success).toBe(true);
  });
  test('rejects empty source', () => {
    expect(LinkGraphEdgeSchema.safeParse({ source: '', target: 'doc:b' }).success).toBe(false);
  });
});

describe('LinkGraphSuccessSchema', () => {
  test('parses an empty graph', () => {
    expect(LinkGraphSuccessSchema.safeParse({ nodes: [], links: [] }).success).toBe(true);
  });
  test('parses a populated graph', () => {
    expect(
      LinkGraphSuccessSchema.safeParse({
        nodes: [
          {
            id: 'doc:a',
            kind: 'doc',
            docName: 'a',
            anchor: null,
            label: 'A',
            cluster: null,
            category: null,
            tags: null,
          },
          {
            id: 'ext:https://example.com',
            kind: 'external',
            url: 'https://example.com',
            label: 'Example',
          },
        ],
        links: [{ source: 'doc:a', target: 'ext:https://example.com' }],
      }).success,
    ).toBe(true);
  });
});
