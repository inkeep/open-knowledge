
import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';
import { createTestClient, createTestServer, pollUntil, wait } from './test-harness';

function makeContentDir(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-single-file-content-')));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf-8');
  }
  return dir;
}

const dirsToClean: string[] = [];
function ephemeralContentDir(files: Record<string, string>): string {
  const dir = makeContentDir(files);
  dirsToClean.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirsToClean.splice(0)) rmSync(d, { recursive: true, force: true });
});

function typeParagraph(fragment: Y.XmlFragment, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  fragment.push([paragraph]);
}

/** Replace the source-mode Y.Text wholesale — the CodeMirror / load-reconcile
 *  surface. Used to drive the exact-canonical-form store that the G8 gate must
 *  suppress in ephemeral mode. */
function setSource(ytext: Y.Text, value: string): void {
  ytext.delete(0, ytext.length);
  ytext.insert(0, value);
}

describe('single-file mode — content scope (D3)', () => {
  test('admits only the target doc; siblings are unscoped', async () => {
    const contentDir = ephemeralContentDir({
      'notes.md': '# Notes\n\nbody\n',
      'secret.md': '# Secret\n\nprivate\n',
      'journal.md': '# Journal\n',
    });
    const server = await createTestServer({
      ephemeral: true,
      contentDir,
      keepContentDir: true,
      singleDocRelPath: 'notes.md',
    });
    try {
      const { contentFilter } = server.instance;
      expect(contentFilter.isExcluded('notes.md')).toBe(false);
      expect(contentFilter.isExcluded('secret.md')).toBe(true);
      expect(contentFilter.isExcluded('journal.md')).toBe(true);

      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
      const json = (await res.json()) as { documents?: Array<{ docName: string }> };
      const docNames = (json.documents ?? []).map((d) => d.docName);
      expect(docNames).toContain('notes');
      expect(docNames).not.toContain('secret');
      expect(docNames).not.toContain('journal');
    } finally {
      await server.cleanup();
    }
  });
});

describe('single-file mode — sibling-asset embeds (D9)', () => {
  test('own-dir asset resolves; subfolder asset does not; referenced asset still serves', async () => {
    const contentDir = ephemeralContentDir({
      'notes.md': '# Notes\n\n![[pic.png]]\n',
      'pic.png': 'PNGDATA',
      'sub/deep.png': 'PNGDATA',
    });
    const server = await createTestServer({
      ephemeral: true,
      contentDir,
      keepContentDir: true,
      singleDocRelPath: 'notes.md',
    });
    try {
      const { basenameIndex, contentFilter } = server.instance;
      expect(basenameIndex.resolveEmbed('pic.png', 'notes')).not.toBeNull();
      expect(basenameIndex.resolveEmbed('deep.png', 'notes')).toBeNull();
      expect(contentFilter.isPathIgnored('pic.png')).toBe(false);
      expect(contentFilter.isExcluded('sub/deep.png')).toBe(true);
    } finally {
      await server.cleanup();
    }
  });
});

describe('single-file mode — no MCP (FR5)', () => {
  test('the /mcp endpoint is not mounted', async () => {
    const contentDir = ephemeralContentDir({ 'notes.md': '# Notes\n' });
    const server = await createTestServer({
      ephemeral: true,
      contentDir,
      keepContentDir: true,
      singleDocRelPath: 'notes.md',
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(404);
    } finally {
      await server.cleanup();
    }
  });
});

describe('single-file mode — write-back (FR3)', () => {
  test('a user edit reaches the on-disk file', async () => {
    const contentDir = ephemeralContentDir({ 'notes.md': '# Notes\n\nstart\n' });
    const server = await createTestServer({
      ephemeral: true,
      contentDir,
      keepContentDir: true,
      singleDocRelPath: 'notes.md',
      debounce: 100,
    });
    const client = await createTestClient(server.port, 'notes');
    try {
      typeParagraph(client.fragment, 'PERSISTED-EDIT');
      await pollUntil(
        () => readFileSync(join(contentDir, 'notes.md'), 'utf-8').includes('PERSISTED-EDIT'),
        4000,
      );
      expect(readFileSync(join(contentDir, 'notes.md'), 'utf-8')).toContain('PERSISTED-EDIT');
    } finally {
      await client.cleanup();
      await server.cleanup();
    }
  });
});

describe('single-file mode — no rewrite on open (FR4 / G8)', () => {
  const RAW = '\tfoo\n';
  const CANONICAL = '    foo\n';

  /** Parse-side tab dropper: reproduces the pre-capture engine's leading-tab
   *  expansion (a parse-time loss) while serialize stays the real engine. */
  class TabDroppingManager extends MarkdownManager {
    override parseWithFallback(
      markdown: string,
      opts?: Parameters<MarkdownManager['parseWithFallback']>[1],
    ): ReturnType<MarkdownManager['parseWithFallback']> {
      return super.parseWithFallback(markdown.replace(/^\t/gm, '    '), opts);
    }
  }
  const tabDroppingManager = new TabDroppingManager({ extensions: sharedExtensions });

  test('a reconciliation to the file’s own canonical form is suppressed; a genuine edit persists', async () => {
    const contentDir = ephemeralContentDir({ 'notes.md': RAW });
    const server = await createTestServer({
      ephemeral: true,
      contentDir,
      keepContentDir: true,
      singleDocRelPath: 'notes.md',
      debounce: 100,
      mdManager: tabDroppingManager,
    });
    const client = await createTestClient(server.port, 'notes');
    try {
      setSource(client.ytext, CANONICAL);
      await wait(600);
      expect(readFileSync(join(contentDir, 'notes.md'), 'utf-8')).toBe(RAW);

      setSource(client.ytext, '# Edited\n\nGENUINE-EDIT\n');
      await pollUntil(
        () => readFileSync(join(contentDir, 'notes.md'), 'utf-8').includes('GENUINE-EDIT'),
        4000,
      );
      expect(readFileSync(join(contentDir, 'notes.md'), 'utf-8')).toContain('GENUINE-EDIT');
    } finally {
      await client.cleanup();
      await server.cleanup();
    }
  });

  test('CONTRAST: a regular (non-ephemeral) project persists the same canonicalization on open', async () => {
    const contentDir = ephemeralContentDir({ 'notes.md': RAW });
    const server = await createTestServer({
      contentDir,
      keepContentDir: true,
      debounce: 100,
      mdManager: tabDroppingManager,
    });
    const client = await createTestClient(server.port, 'notes');
    try {
      setSource(client.ytext, CANONICAL);
      await pollUntil(
        () => readFileSync(join(contentDir, 'notes.md'), 'utf-8') === CANONICAL,
        4000,
      );
      expect(readFileSync(join(contentDir, 'notes.md'), 'utf-8')).toBe(CANONICAL);
    } finally {
      await client.cleanup();
      await server.cleanup();
    }
  });
});

describe('single-file mode — /api host gate (DNS-rebinding defense)', () => {
  const REBIND_HOST = 'attacker.example.com';

  test('a rebound Host is refused on /api/document, /api/asset-text, /api/asset (403 host-not-allowed)', async () => {
    const contentDir = ephemeralContentDir({
      'notes.md': '# Notes\n',
      'secret.md': '# Secret\n\nprivate\n',
      'secret.txt': 'plaintext secret',
      'secret.png': 'PNGDATA',
    });
    const server = await createTestServer({
      ephemeral: true,
      contentDir,
      keepContentDir: true,
      singleDocRelPath: 'notes.md',
    });
    try {
      for (const path of [
        '/api/document?docName=secret',
        '/api/asset-text?path=secret.txt',
        '/api/asset?path=secret.png',
      ]) {
        const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          headers: { Host: REBIND_HOST },
        });
        expect(res.status).toBe(403);
        expect((await res.json()).type).toBe('urn:ok:error:host-not-allowed');
      }
    } finally {
      await server.cleanup();
    }
  });

  test('a loopback Host still serves the legit editor traffic in ephemeral mode', async () => {
    const contentDir = ephemeralContentDir({ 'notes.md': '# Notes\n' });
    const server = await createTestServer({
      ephemeral: true,
      contentDir,
      keepContentDir: true,
      singleDocRelPath: 'notes.md',
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
      expect(res.status).toBe(200);
    } finally {
      await server.cleanup();
    }
  });

  test('non-ephemeral (project mode): a rebound Host on a read is NOT ephemeral-gated', async () => {
    const contentDir = ephemeralContentDir({ 'notes.md': '# Notes\n' });
    const server = await createTestServer({ contentDir, keepContentDir: true });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=notes`, {
        headers: { Host: REBIND_HOST },
      });
      expect(res.status).not.toBe(403);
    } finally {
      await server.cleanup();
    }
  });
});

describe('single-file mode — content-tree writes refused (G4)', () => {
  test('PUT /api/folder-config is refused (single-file-mode 403)', async () => {
    const contentDir = ephemeralContentDir({ 'notes.md': '# Notes\n' });
    const server = await createTestServer({
      ephemeral: true,
      contentDir,
      keepContentDir: true,
      singleDocRelPath: 'notes.md',
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/folder-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '.', frontmatter: { title: 'Nope' } }),
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { type?: string };
      expect(json.type).toBe('urn:ok:error:single-file-mode');
      expect(readdirSync(contentDir).sort()).toEqual(['notes.md']);
    } finally {
      await server.cleanup();
    }
  });

  test('PUT /api/template is refused (single-file-mode 403)', async () => {
    const contentDir = ephemeralContentDir({ 'notes.md': '# Notes\n' });
    const server = await createTestServer({
      ephemeral: true,
      contentDir,
      keepContentDir: true,
      singleDocRelPath: 'notes.md',
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder: '.', name: 'daily', body: '# {{title}}\n' }),
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { type?: string };
      expect(json.type).toBe('urn:ok:error:single-file-mode');
      expect(readdirSync(contentDir).sort()).toEqual(['notes.md']);
    } finally {
      await server.cleanup();
    }
  });
});

describe('single-file mode — zero user-dir artifacts (FR2 / G4)', () => {
  test('open + edit + close leaves the directory clean except the edited file', async () => {
    const contentDir = ephemeralContentDir({ 'notes.md': '# Notes\n\nstart\n' });
    const before = readdirSync(contentDir).sort();
    expect(before).toEqual(['notes.md']);

    const server = await createTestServer({
      ephemeral: true,
      contentDir,
      keepContentDir: true,
      singleDocRelPath: 'notes.md',
      debounce: 100,
    });
    const client = await createTestClient(server.port, 'notes');
    typeParagraph(client.fragment, 'EDIT');
    await pollUntil(
      () => readFileSync(join(contentDir, 'notes.md'), 'utf-8').includes('EDIT'),
      4000,
    );
    await client.cleanup();
    await server.cleanup();

    const after = readdirSync(contentDir).sort();
    expect(after).toEqual(['notes.md']);
  });
});
