/**
 * GET /api/documents?showAll=true&dir=<rel>&depth=1 — lazy per-directory
 * contract. The depth-1 mode yields ONLY the immediate children of
 * the scoped directory (no recursion) and stamps each child folder with
 * `hasChildren` so the sidebar can render an expand affordance without walking
 * the subtree. This is the server half of collapsing the FileTree retained set
 * from the whole tree to the on-screen working set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { awaitFileWatcherIndexed, createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-depth1-')));
  // Root level: one doc + two folders.
  writeFileSync(join(contentDir, 'README.md'), '# Readme\n');
  // `with-kids/` has a child doc AND a grandchild dir — used to assert depth-1
  // returns the child but NOT the grandchild, and that hasChildren is true.
  mkdirSync(join(contentDir, 'with-kids', 'grandchild'), { recursive: true });
  writeFileSync(join(contentDir, 'with-kids', 'child.md'), '# Child\n');
  writeFileSync(join(contentDir, 'with-kids', 'grandchild', 'deep.md'), '# Deep\n');
  // `empty-dir/` has no admitted children — hasChildren must be false.
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

    // Immediate children present.
    expect(paths).toContain('README');
    expect(paths).toContain('with-kids');
    expect(paths).toContain('empty-dir');

    // Descendants of with-kids/ MUST NOT appear at root depth-1.
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

    // Immediate children of with-kids/.
    expect(paths).toContain('with-kids/child');
    expect(paths).toContain('with-kids/grandchild');

    // The grandchild dir's own child must NOT appear (depth-1, no recursion).
    expect(paths).not.toContain('with-kids/grandchild/deep');

    // The grandchild folder, being a leaf at this depth, carries hasChildren.
    const grandchild = body.documents.find(
      (e) => e.kind === 'folder' && e.path === 'with-kids/grandchild',
    );
    expect(grandchild?.hasChildren).toBe(true);
  });

  test('without depth=1, the recursive walk still returns descendants', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    const body = DocumentListSuccessSchema.parse(await res.json());
    const paths = body.documents.map((e) => (e.kind === 'folder' ? e.path : (e.docName ?? e.path)));
    // Full walk surfaces the deep descendant the depth-1 calls excluded.
    expect(paths).toContain('with-kids/grandchild/deep');
    // Sweep, not spot-check: NO folder on the recursive walk carries
    // hasChildren. A spot-check on one folder would miss an inverted
    // atLeafDepth guard that stamps hasChildren on every folder.
    const folders = body.documents.filter((e) => e.kind === 'folder');
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      expect(folder.hasChildren).toBeUndefined();
    }
  });
});
