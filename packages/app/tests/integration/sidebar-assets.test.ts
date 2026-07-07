import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { awaitFileWatcherIndexed, createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-sidebar-assets-')));
  mkdirSync(join(contentDir, 'docs', 'media'), { recursive: true });
  writeFileSync(
    join(contentDir, 'docs', 'guide.md'),
    [
      '# Guide',
      '',
      '![diagram](./media/diagram.png)',
      '',
      '[linked image](./media/diagram.png)',
      '<img src="/docs/media/root.png" alt="Root referenced asset" />',
      '<a href="./media/spec.pdf">Spec</a>',
      '[table](./media/data.csv)',
      '![[media/wiki-embed.jpg]]',
      '[[media/wiki-file.pdf]]',
      '[remote image](https://example.com/remote.png)',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(join(contentDir, 'docs', 'media', 'diagram.png'), 'png bytes');
  writeFileSync(join(contentDir, 'docs', 'media', 'root.png'), 'root png bytes');
  writeFileSync(join(contentDir, 'docs', 'media', 'wiki-embed.jpg'), 'jpg bytes');
  writeFileSync(join(contentDir, 'docs', 'media', 'spec.pdf'), 'pdf bytes');
  writeFileSync(join(contentDir, 'docs', 'media', 'data.csv'), 'csv bytes');
  writeFileSync(join(contentDir, 'docs', 'media', 'wiki-file.pdf'), 'wiki pdf bytes');
  writeFileSync(join(contentDir, 'docs', 'media', 'unreferenced.png'), 'unused bytes');

  server = await createTestServer({ contentDir, keepContentDir: false });
  await awaitFileWatcherIndexed(server, 'docs/guide');
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('/api/documents sidebar asset rows', () => {
  test('returns referenced local assets as non-document rows', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    expect(res.ok).toBe(true);
    // Round-trip the response through `DocumentListSuccessSchema` so any
    // schema-vs-server divergence (e.g. mediaKind union, new asset variants)
    // surfaces as a typed parse failure here, not as a runtime error in
    // FileTree.tsx. Inline-cast assertions silently accept whatever shape the
    // server emits — and miss exactly this class of regression.
    const body = DocumentListSuccessSchema.parse(await res.json());

    const doc = body.documents.find((entry) => entry.docName === 'docs/guide');
    expect(doc?.kind).toBe('document');

    const asset = body.documents.find((entry) => entry.path === 'docs/media/diagram.png');
    expect(asset).toMatchObject({
      kind: 'asset',
      docName: 'docs/media/diagram.png',
      assetExt: '.png',
      mediaKind: 'image',
      referencedBy: ['docs/guide'],
    });

    const rootAsset = body.documents.find((entry) => entry.path === 'docs/media/root.png');
    expect(rootAsset).toMatchObject({
      kind: 'asset',
      docName: 'docs/media/root.png',
      assetExt: '.png',
      mediaKind: 'image',
      referencedBy: ['docs/guide'],
    });

    const wikiEmbedAsset = body.documents.find(
      (entry) => entry.path === 'docs/media/wiki-embed.jpg',
    );
    expect(wikiEmbedAsset).toMatchObject({
      kind: 'asset',
      docName: 'docs/media/wiki-embed.jpg',
      assetExt: '.jpg',
      mediaKind: 'image',
      referencedBy: ['docs/guide'],
    });

    const htmlHrefAsset = body.documents.find((entry) => entry.path === 'docs/media/spec.pdf');
    expect(htmlHrefAsset).toMatchObject({
      kind: 'asset',
      docName: 'docs/media/spec.pdf',
      assetExt: '.pdf',
      mediaKind: 'pdf',
      referencedBy: ['docs/guide'],
    });

    const markdownLinkAsset = body.documents.find((entry) => entry.path === 'docs/media/data.csv');
    expect(markdownLinkAsset).toMatchObject({
      kind: 'asset',
      docName: 'docs/media/data.csv',
      assetExt: '.csv',
      mediaKind: null,
      referencedBy: ['docs/guide'],
    });

    const wikiLinkAsset = body.documents.find((entry) => entry.path === 'docs/media/wiki-file.pdf');
    expect(wikiLinkAsset).toMatchObject({
      kind: 'asset',
      docName: 'docs/media/wiki-file.pdf',
      assetExt: '.pdf',
      mediaKind: 'pdf',
      referencedBy: ['docs/guide'],
    });

    // Unreferenced non-markdown files surface by disk presence (not markdown
    // reference): a file no markdown body links to still appears, as a
    // name-only `kind:'file'` row — never as a `kind:'asset'` row, since it
    // carries no `referencedBy`. (Asset rows are reserved for files an indexed
    // markdown body actually references.)
    const unreferenced = body.documents.find(
      (entry) => entry.path === 'docs/media/unreferenced.png',
    );
    expect(unreferenced).toMatchObject({
      kind: 'file',
      docName: 'docs/media/unreferenced.png',
      assetExt: 'png',
    });

    // A remote URL is not a file on disk, so it never enters the index and
    // never appears as a row regardless of all-files coverage.
    expect(body.documents.some((entry) => entry.path === 'https://example.com/remote.png')).toBe(
      false,
    );
  });
});
