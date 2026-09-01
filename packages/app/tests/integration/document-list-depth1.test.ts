import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { awaitFileWatcherIndexed, createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-depth1-')));
  writeFileSync(join(contentDir, 'README.md'), '# Readme\n');
  mkdirSync(join(contentDir, 'with-kids', 'grandchild'), { recursive: true });
  writeFileSync(join(contentDir, 'with-kids', 'child.md'), '# Child\n');
  writeFileSync(join(contentDir, 'with-kids', 'grandchild', 'deep.md'), '# Deep\n');
  mkdirSync(join(contentDir, 'empty-dir'), { recursive: true });
  server = await createTestServer({ contentDir, keepContentDir: false });
  await awaitFileWatcherIndexed(server, 'README');
}, 30_000);

afterAll(async () => {
  await server.cleanup();
});

const depth1 = (dir?: string): string => {
  const base = `http://127.0.0.1:${server.port}/api/documents?showAll=true&depth=1`;
  return dir ? `${base}&dir=${encodeURIComponent(dir)}` : base;
};

describe('GET /api/documents depth-1 lazy children', () => {
  test('root depth-1 returns only immediate children, not descendants', async () => {
    const res = await fetch(depth1());
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());
    const paths = body.documents.map((e) => (e.kind === 'folder' ? e.path : (e.docName ?? e.path)));

    expect(paths).toContain('README');
    expect(paths).toContain('with-kids');
    expect(paths).toContain('empty-dir');

    expect(paths).not.toContain('with-kids/child');
    expect(paths).not.toContain('with-kids/grandchild');
    expect(paths).not.toContain('with-kids/grandchild/deep');
  });

  test('folder children carry hasChildren reflecting whether the subtree is non-empty', async () => {
    const res = await fetch(depth1());
    const body = DocumentListSuccessSchema.parse(await res.json());

    const withKids = body.documents.find((e) => e.kind === 'folder' && e.path === 'with-kids');
    const emptyDir = body.documents.find((e) => e.kind === 'folder' && e.path === 'empty-dir');

    expect(withKids?.hasChildren).toBe(true);
    expect(emptyDir?.hasChildren).toBe(false);
  });

  test('depth-1 scoped to a subdir returns that dir’s immediate children only', async () => {
    const res = await fetch(depth1('with-kids'));
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());
    const paths = body.documents.map((e) => (e.kind === 'folder' ? e.path : (e.docName ?? e.path)));

    expect(paths).toContain('with-kids/child');
    expect(paths).toContain('with-kids/grandchild');

    expect(paths).not.toContain('with-kids/grandchild/deep');

    const grandchild = body.documents.find(
      (e) => e.kind === 'folder' && e.path === 'with-kids/grandchild',
    );
    expect(grandchild?.hasChildren).toBe(true);
  });

  test('without depth=1, the recursive walk still returns descendants', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    const body = DocumentListSuccessSchema.parse(await res.json());
    const paths = body.documents.map((e) => (e.kind === 'folder' ? e.path : (e.docName ?? e.path)));
    expect(paths).toContain('with-kids/grandchild/deep');
    const folders = body.documents.filter((e) => e.kind === 'folder');
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      expect(folder.hasChildren).toBeUndefined();
    }
  });
});
