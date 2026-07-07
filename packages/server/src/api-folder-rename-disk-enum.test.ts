/**
 * Folder rename must enumerate descendant docs from disk, not the in-memory
 * file index. The chokidar watcher populates that index asynchronously, so
 * right after a `write_document` create it lags on-disk truth. Folder rename
 * used to read the (empty) index, report `renamed: []`, skip inbound-link
 * rewriting, and STILL move the directory — orphaning every link into it.
 *
 * These tests force the bug state deterministically with `getFileIndex: () =>
 * new Map()` (a permanently-empty index) while the docs exist on disk, and
 * assert the rename now finds them, rewrites inbound links, and preserves a
 * `.mdx` descendant's extension (the `registerDocExtension` path — without it
 * the `.mdx` snapshot read resolves to a non-existent `.md` path and the spine
 * throws `ManagedRenameMissingDocumentError`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createApiExtension } from './api-extension.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';

interface CapturedResponse {
  status: number;
  body: string;
}

function makeReq(url: string, body: unknown): IncomingMessage {
  const readable = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function seed(contentDir: string, relPath: string, content: string): void {
  const full = join(contentDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

async function renameFolder(
  contentDir: string,
  from: string,
  to: string,
): Promise<{ status: number; structured: Record<string, unknown> }> {
  const backlinkIndex = new BacklinkIndex({ projectDir: contentDir, contentDir });
  await backlinkIndex.rebuildFromDisk();

  const ext = createApiExtension({
    hocuspocus: {
      documents: new Map(),
      closeConnections() {},
      unloadDocument: async () => {},
      debouncer: { isDebounced: () => false, executeNow: async () => undefined },
    } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {
      closeSession: async () => {},
      closeAllForDoc: async () => {},
    } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    // The crux: a permanently-empty file index reproduces the watcher lag.
    getFileIndex: () => new Map(),
    backlinkIndex,
  });

  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({
    request: makeReq('/api/rename-path', { kind: 'folder', fromPath: from, toPath: to }),
    response: res,
  });
  return { status: captured.status, structured: captured.body ? JSON.parse(captured.body) : {} };
}

let contentDir: string;

beforeEach(() => {
  contentDir = mkdtempSync(join(tmpdir(), 'ok-folder-rename-disk-'));
  _resetDocExtensionsForTests();
});

afterEach(() => {
  rmSync(contentDir, { recursive: true, force: true });
});

describe('folder rename enumerates descendant docs from disk', () => {
  test('moves docs, reports renamed[], and rewrites inbound links despite an empty file index', async () => {
    seed(contentDir, 'fr-nested/note.md', '# Note\n\nDirect child.\n');
    seed(contentDir, 'fr-nested/deep/leaf.md', '# Leaf\n\nNested child.\n');
    seed(contentDir, 'src.md', 'See [[fr-nested/deep/leaf]] and [[fr-nested/note]].\n');

    const { status, structured } = await renameFolder(contentDir, 'fr-nested', 'fr-final');

    expect(status).toBe(200);

    const renamed = structured.renamed as Array<{ fromDocName: string; toDocName: string }>;
    const renamedFrom = renamed.map((r) => r.fromDocName).sort();
    expect(renamedFrom).toEqual(['fr-nested/deep/leaf', 'fr-nested/note']);

    // Directory physically moved.
    expect(existsSync(join(contentDir, 'fr-final/note.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'fr-final/deep/leaf.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'fr-nested'))).toBe(false);

    // Inbound links rewritten (no longer orphaned).
    const rewrittenDocs = structured.rewrittenDocs as Array<{ docName: string }>;
    expect(rewrittenDocs.map((d) => d.docName)).toContain('src');
    const srcBody = readFileSync(join(contentDir, 'src.md'), 'utf-8');
    expect(srcBody).toContain('[[fr-final/deep/leaf]]');
    expect(srcBody).toContain('[[fr-final/note]]');
    expect(srcBody).not.toContain('fr-nested');
  });

  test('preserves a .mdx descendant extension (registerDocExtension path)', async () => {
    seed(contentDir, 'docs/page.mdx', '# Page\n\nAn mdx doc.\n');
    seed(contentDir, 'docs/readme.md', '# Readme\n');
    seed(contentDir, 'index.md', 'Link to [[docs/page]].\n');

    const { status, structured } = await renameFolder(contentDir, 'docs', 'guides');

    expect(status).toBe(200);
    const renamed = structured.renamed as Array<{ fromDocName: string; toDocName: string }>;
    expect(renamed.map((r) => r.fromDocName).sort()).toEqual(['docs/page', 'docs/readme']);

    // The .mdx file moved as .mdx — no split-brain `.md` sibling.
    expect(existsSync(join(contentDir, 'guides/page.mdx'))).toBe(true);
    expect(existsSync(join(contentDir, 'guides/page.md'))).toBe(false);

    const indexBody = readFileSync(join(contentDir, 'index.md'), 'utf-8');
    expect(indexBody).toContain('[[guides/page]]');
  });
});

/**
 * (folder-rename corruption chain) reported "relative (`../`) links in
 * nested docs were not rewritten — top-level links updated, but the one inside…
 * still referenced as food". That symptom predates disk-enumeration
 * fix; these tests pin the relative-link half of the contract for a folder
 * rename so it can't silently regress:
 *
 *  - every inbound link shape pointing INTO the folder (wiki, root-relative,
 *    dot-relative, and `../`/`../../` from nested sources) is rewritten to the
 *    new folder name, leaving zero stale references; and
 *  - relative links authored INSIDE the folder (sibling `../`, descendant
 *    `./sub/`, and outbound `../`) still resolve to a real file after the move
 *    — no orphaned links.
 */
describe('folder rename rewrites every inbound link shape and preserves intra-folder links', () => {
  test('rewrites nested `../` inbound links and leaves no stale folder references', async () => {
    seed(contentDir, 'foods/apple.md', '# Apple\n');
    seed(contentDir, 'foods/sub/banana.md', '# Banana\n');

    // Backlink sources pointing INTO foods/ via every supported link shape.
    seed(contentDir, 'top-wiki.md', 'See [[foods/apple]].\n');
    seed(contentDir, 'top-root.md', 'See [apple](/foods/apple.md).\n');
    seed(contentDir, 'top-dotrel.md', 'See [apple](./foods/apple.md).\n');
    seed(contentDir, 'one/note.md', 'See [apple](../foods/apple.md).\n');
    seed(contentDir, 'one/two/note.md', 'See [banana](../../foods/sub/banana.md).\n');

    const { status } = await renameFolder(contentDir, 'foods', 'recipes');
    expect(status).toBe(200);

    const read = (p: string) => readFileSync(join(contentDir, p), 'utf-8');
    // No source still references the old folder name…
    for (const p of [
      'top-wiki.md',
      'top-root.md',
      'top-dotrel.md',
      'one/note.md',
      'one/two/note.md',
    ]) {
      expect(read(p)).not.toContain('foods');
    }
    // …and each was repointed at the new folder, resolving to a real file.
    expect(read('top-wiki.md')).toContain('[[recipes/apple]]');
    expect(read('top-root.md')).toContain('(/recipes/apple.md)');
    expect(read('top-dotrel.md')).toContain('(./recipes/apple.md)');
    expect(read('one/note.md')).toContain('(../recipes/apple.md)');
    expect(read('one/two/note.md')).toContain('(../../recipes/sub/banana.md)');
    expect(existsSync(join(contentDir, 'recipes/apple.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'recipes/sub/banana.md'))).toBe(true);
    // The whole directory moved — no empty `foods/` shell left behind.
    expect(existsSync(join(contentDir, 'foods'))).toBe(false);
  });

  test('preserves relative links authored INSIDE the renamed folder (no orphans)', async () => {
    seed(
      contentDir,
      'foods/apple.md',
      '# Apple\n\nSee [banana](./sub/banana.md) and [carrot](../veg/carrot.md).\n',
    );
    seed(
      contentDir,
      'foods/sub/banana.md',
      '# Banana\n\nSee [apple](../apple.md) and [carrot](../../veg/carrot.md).\n',
    );
    seed(contentDir, 'veg/carrot.md', '# Carrot\n');

    const { status } = await renameFolder(contentDir, 'foods', 'recipes');
    expect(status).toBe(200);

    const apple = readFileSync(join(contentDir, 'recipes/apple.md'), 'utf-8');
    const banana = readFileSync(join(contentDir, 'recipes/sub/banana.md'), 'utf-8');

    // Pin the full link shape (not a loose substring) so an incorrect
    // re-relativization to e.g. `../recipes/sub/banana.md` would fail.
    // apple → banana (both moved together): the rewrite normalizes the leading
    // `./` away but the path still resolves to recipes/sub/banana.
    expect(apple).toContain('[banana](sub/banana.md)');
    // apple → carrot (carrot stayed put): unchanged, still resolves to veg/carrot.
    expect(apple).toContain('[carrot](../veg/carrot.md)');
    // banana → apple (intra-folder sibling): resolves to recipes/apple.
    expect(banana).toContain('[apple](../apple.md)');
    // banana → carrot (outbound from deeper): resolves to veg/carrot.
    expect(banana).toContain('[carrot](../../veg/carrot.md)');

    // Every link target exists on disk — zero orphans.
    expect(existsSync(join(contentDir, 'recipes/apple.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'recipes/sub/banana.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'veg/carrot.md'))).toBe(true);
  });
});
