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

    expect(existsSync(join(contentDir, 'fr-final/note.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'fr-final/deep/leaf.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'fr-nested'))).toBe(false);

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

    expect(existsSync(join(contentDir, 'guides/page.mdx'))).toBe(true);
    expect(existsSync(join(contentDir, 'guides/page.md'))).toBe(false);

    const indexBody = readFileSync(join(contentDir, 'index.md'), 'utf-8');
    expect(indexBody).toContain('[[guides/page]]');
  });
});

describe('folder rename rewrites every inbound link shape and preserves intra-folder links', () => {
  test('rewrites nested `../` inbound links and leaves no stale folder references', async () => {
    seed(contentDir, 'foods/apple.md', '# Apple\n');
    seed(contentDir, 'foods/sub/banana.md', '# Banana\n');

    seed(contentDir, 'top-wiki.md', 'See [[foods/apple]].\n');
    seed(contentDir, 'top-root.md', 'See [apple](/foods/apple.md).\n');
    seed(contentDir, 'top-dotrel.md', 'See [apple](./foods/apple.md).\n');
    seed(contentDir, 'one/note.md', 'See [apple](../foods/apple.md).\n');
    seed(contentDir, 'one/two/note.md', 'See [banana](../../foods/sub/banana.md).\n');

    const { status } = await renameFolder(contentDir, 'foods', 'recipes');
    expect(status).toBe(200);

    const read = (p: string) => readFileSync(join(contentDir, p), 'utf-8');
    for (const p of [
      'top-wiki.md',
      'top-root.md',
      'top-dotrel.md',
      'one/note.md',
      'one/two/note.md',
    ]) {
      expect(read(p)).not.toContain('foods');
    }
    expect(read('top-wiki.md')).toContain('[[recipes/apple]]');
    expect(read('top-root.md')).toContain('(/recipes/apple.md)');
    expect(read('top-dotrel.md')).toContain('(./recipes/apple.md)');
    expect(read('one/note.md')).toContain('(../recipes/apple.md)');
    expect(read('one/two/note.md')).toContain('(../../recipes/sub/banana.md)');
    expect(existsSync(join(contentDir, 'recipes/apple.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'recipes/sub/banana.md'))).toBe(true);
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

    expect(apple).toContain('[banana](sub/banana.md)');
    expect(apple).toContain('[carrot](../veg/carrot.md)');
    expect(banana).toContain('[apple](../apple.md)');
    expect(banana).toContain('[carrot](../../veg/carrot.md)');

    expect(existsSync(join(contentDir, 'recipes/apple.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'recipes/sub/banana.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'veg/carrot.md'))).toBe(true);
  });
});
