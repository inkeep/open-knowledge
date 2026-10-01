import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import * as core from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { createApiExtension } from './api-extension.test-helper.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';
import type { FileIndexEntry } from './file-watcher.ts';

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
  options: {
    documents?: Map<string, Y.Doc>;
    afterIndex?: () => void;
    fileIndex?: Map<string, FileIndexEntry>;
  } = {},
): Promise<{ status: number; structured: Record<string, unknown> }> {
  const backlinkIndex = new BacklinkIndex({ projectDir: contentDir, contentDir });
  await backlinkIndex.rebuildFromDisk();
  options.afterIndex?.();

  const ext = createApiExtension({
    hocuspocus: {
      documents: options.documents ?? new Map(),
      closeConnections() {},
      unloadDocument: async () => {},
      debouncer: { isDebounced: () => false, executeNow: async () => undefined },
    } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {
      closeSession: async () => {},
      closeAllForDoc: async () => {},
    } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    getFileIndex: () => options.fileIndex ?? new Map(),
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
    expect(srcBody).toContain('[[fr-final/deep/leaf|fr-nested/deep/leaf]]');
    expect(srcBody).toContain('[[fr-final/note|fr-nested/note]]');
    expect(srcBody).not.toContain('[[fr-nested/');
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
    expect(indexBody).toContain('[[guides/page|docs/page]]');
  });
});

describe('folder rename rewrites every inbound link shape and preserves intra-folder links', () => {
  test('rewrites nested `../` inbound links and preserves wiki display labels', async () => {
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
    for (const p of ['top-root.md', 'top-dotrel.md', 'one/note.md', 'one/two/note.md']) {
      expect(read(p)).not.toContain('foods');
    }
    expect(read('top-wiki.md')).toContain('[[recipes/apple|foods/apple]]');
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

describe('managed rename corpus discovery', () => {
  test('does not parse unrelated indexed document bodies', async () => {
    seed(contentDir, 'moving/target.md', '# Target\n');
    const names = Array.from({ length: 96 }, (_, i) => `work-${i}`);
    for (const name of names) seed(contentDir, `${name}.md`, `# Work source ${name}\n`);
    seed(contentDir, 'linked.md', '[[moving/target]]\n');
    const seen = new Set<string>();
    let active = false;
    const original = core.stripFrontmatter;
    const parse = vi.spyOn(core, 'stripFrontmatter').mockImplementation((body) => {
      if (active && body.startsWith('# Work source ')) seen.add(body);
      return original(body);
    });
    try {
      const result = await renameFolder(contentDir, 'moving', 'moved', {
        afterIndex: () => {
          active = true;
        },
      });
      expect(result.status).toBe(200);
      expect(seen.size).toBe(0);
      expect(readFileSync(join(contentDir, 'linked.md'), 'utf8')).toBe(
        '[[moved/target|moving/target]]\n',
      );
    } finally {
      parse.mockRestore();
    }
  });

  test('rewrites a link found only in loaded unsaved Y.Text', async () => {
    seed(contentDir, 'moving/target.md', '# Target\n');
    seed(contentDir, 'live.md', 'No link on disk.\n');
    const doc = new Y.Doc();
    doc.getText('source').insert(0, '[[moving/target]]\n');
    try {
      const result = await renameFolder(contentDir, 'moving', 'moved', {
        documents: new Map([['live', doc]]),
      });
      expect(result.status).toBe(200);
      expect(readFileSync(join(contentDir, 'live.md'), 'utf8')).toBe(
        '[[moved/target|moving/target]]\n',
      );
    } finally {
      doc.destroy();
    }
  });

  test('discovers a stale referrer and protects an unmoved target outside moved backlinks', async () => {
    seed(contentDir, 'notes/beta.md', '# Moving\n');
    seed(contentDir, 'm/beta.md', '# Intended\n');
    seed(contentDir, 'source.md', '[[beta|Original]]\n');
    seed(contentDir, 'stale.md', 'Unlinked when indexed.\n');
    const result = await renameFolder(contentDir, 'notes', 'archive', {
      afterIndex: () => {
        const path = join(contentDir, 'stale.md');
        const { atime, mtimeMs } = statSync(path);
        seed(contentDir, 'stale.md', '[[notes/beta|Added after indexing]]\n');
        utimesSync(path, atime, new Date(mtimeMs + 2_000));
      },
    });
    expect(result.status).toBe(200);
    expect(readFileSync(join(contentDir, 'source.md'), 'utf8')).toBe('[[m/beta|Original]]\n');
    expect(readFileSync(join(contentDir, 'stale.md'), 'utf8')).toBe(
      '[[archive/beta|Added after indexing]]\n',
    );
  });

  test('rewrites a file-indexed referrer that the backlink index has not seen yet', async () => {
    seed(contentDir, 'moving/target.md', '# Target\n');
    const result = await renameFolder(contentDir, 'moving', 'moved', {
      afterIndex: () => seed(contentDir, 'late.md', '[[moving/target]]\n'),
      fileIndex: new Map([
        [
          'late',
          {
            size: 18,
            modified: new Date(0).toISOString(),
            canonicalPath: join(contentDir, 'late.md'),
            inode: 0,
            aliases: [],
            kind: 'markdown',
          },
        ],
      ]),
    });
    expect(result.status).toBe(200);
    expect(readFileSync(join(contentDir, 'late.md'), 'utf8')).toBe(
      '[[moved/target|moving/target]]\n',
    );
  });

  test('leaves loaded non-Markdown documents untouched when a wiki winner changes', async () => {
    seed(contentDir, 'docs/Login.md', '# Login\n');
    seed(contentDir, 'm/Login.md', '# Other login\n');
    seed(contentDir, 'index.md', 'See [[Login]].\n');
    const diagram = 'flowchart LR\n  A --> B[[Login]]\n';
    seed(contentDir, 'diagram.mmd', diagram);
    const doc = new Y.Doc();
    doc.getText('source').insert(0, diagram);
    try {
      const result = await renameFolder(contentDir, 'docs', 'zz', {
        documents: new Map([['diagram.mmd', doc]]),
      });
      expect(result.status).toBe(200);
      expect(readFileSync(join(contentDir, 'index.md'), 'utf8')).toBe('See [[zz/Login|Login]].\n');
      expect(doc.getText('source').toString()).toBe(diagram);
      expect(readFileSync(join(contentDir, 'diagram.mmd'), 'utf8')).toBe(diagram);
      expect(
        (result.structured.rewrittenDocs as Array<{ docName: string }>).map((d) => d.docName),
      ).toEqual(['index']);
    } finally {
      doc.destroy();
    }
  });

  test('treats an unrelated document whose folder became a file as absent', async () => {
    seed(contentDir, 'moving/target.md', '# Target\n');
    seed(contentDir, 'linked.md', '[[moving/target]]\n');
    seed(contentDir, 'unrelated/a.md', '# A\n');
    const result = await renameFolder(contentDir, 'moving', 'moved', {
      afterIndex: () => {
        rmSync(join(contentDir, 'unrelated'), { recursive: true });
        writeFileSync(join(contentDir, 'unrelated'), 'now a file');
      },
    });
    expect(result.status).toBe(200);
    expect(readFileSync(join(contentDir, 'linked.md'), 'utf8')).toBe(
      '[[moved/target|moving/target]]\n',
    );
  });
});
