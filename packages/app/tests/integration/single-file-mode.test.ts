/**
 * No-project single-file mode (`ok <file>`) — server-side integration.
 *
 * Boots the production ephemeral shape via `createTestServer({ ephemeral })`:
 * a throwaway `projectDir` (`.ok/local/` runtime state) distinct from the
 * user's real `contentDir`, single-file content scope, git + MCP off. Verifies
 * the spec's server-side requirements at real fidelity:
 *
 *   - single-file content scope (siblings not indexed)
 *   - bounded sibling-asset embed seed (own-dir resolves, subfolder doesn't)
 *   - no MCP endpoint mounted
 *   - write-back (an edit reaches the on-disk file)
 *   - no silent normalization on open (round-trip-unstable file stays
 *         byte-identical until a genuine edit — the canonical-baseline no-op)
 *   - zero user-dir artifacts (open + edit + close leaves the dir clean)
 *
 * Path-identity + the CLI/desktop dispatch live in their own unit tests
 * (the realpath-before-detection + dedup logic is not a server concern).
 */

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

/** Make a throwaway "user directory" with the given files (relativePath → contents). */
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

/** Append a paragraph carrying real text — a genuine WYSIWYG user edit. */
function typeParagraph(fragment: Y.XmlFragment, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  fragment.push([paragraph]);
}

/** Replace the source-mode Y.Text wholesale — the CodeMirror / load-reconcile
 *  surface. Used to drive the exact-canonical-form store that the gate must
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

      // The HTTP file index surfaces only the one scoped doc — siblings were
      // never walked.
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
      // Own-dir sibling resolves (bounded one-dir seed).
      expect(basenameIndex.resolveEmbed('pic.png', 'notes')).not.toBeNull();
      // Subfolder asset is NOT seeded (documented residual).
      expect(basenameIndex.resolveEmbed('deep.png', 'notes')).toBeNull();
      // `isPathIgnored` is unscoped, so the referenced sibling still serves
      // (`![](pic.png)` / `![[pic.png]]`).
      expect(contentFilter.isPathIgnored('pic.png')).toBe(false);
      // A non-referenced sibling doc is still excluded from the doc system.
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
      // mountMcpAndApi leaves `/mcp` unhandled → the catch-all 404 fires.
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
  // The fixture contract: a shape where (a) the persistence engine's
  // serialize(parse(RAW)) rewrites the bytes (so a load-canonicalization
  // exists at all) and (b) normalizeBridge keeps RAW and CANONICAL distinct
  // (so the existing raw-bytes no-op gate misses it and only the canonical
  // baseline suppresses the rewrite). Every real-engine fixture was retired
  // as the engine grew byte-faithful — `## H\nP`, `1. a\n1. b` (serializer
  // source-form retention), and finally `\tfoo` (the parse-time capture
  // lever) — so the load-canonicalization is now modeled by an injected
  // manager whose parse drops the leading tab exactly the way the
  // pre-capture engine did. The gate is engine-agnostic; the stub keeps
  // its suppression path exercisable at the persistence seam. The
  // load-canonicalization is reproduced deterministically by setting the
  // source Y.Text to the exact canonical form — the signature the gate keys on.
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
      // Load-canonicalization signature: source becomes the canonical form
      // with no semantic change. The gate suppresses the disk write.
      setSource(client.ytext, CANONICAL);
      await wait(600);
      expect(readFileSync(join(contentDir, 'notes.md'), 'utf-8')).toBe(RAW);

      // A genuinely different edit DOES persist (diverges from the baseline).
      // Use a bridge-stable replacement so the assertion targets persistence,
      // not the fixture's source/fragment divergence.
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
    // Proves the contrast case exercises the real rewrite path: with the ephemeral no-op
    // removed, the identical source reconciliation DOES rewrite the file — the
    // exact footgun the ephemeral no-op guards against.
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
  // In ephemeral mode contentDir is the opened file's parent, and the byte-read
  // routes (`/api/document`, `/api/asset`, `/api/asset-text`) are NOT bounded by
  // the single-file content scope (that's enforced at the indexing layer). A
  // DNS-rebound page (loopback TCP peer, attacker-controlled Host header) could
  // otherwise read sibling files through any of them. The ephemeral `/api/*`
  // gate must refuse a non-loopback Host BEFORE the read — across every read
  // route, not one. Bun's fetch honors a `Host` override (same mechanism the
  // workspace-endpoint host-gate test uses).
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
      // Each targets a real sibling file that exists on disk — proving the gate
      // fires BEFORE the read (a missing-file 404 would mean the read ran).
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
      // Default Host is `127.0.0.1:<port>` (loopback) → passes the gate.
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
      expect(res.status).toBe(200);
    } finally {
      await server.cleanup();
    }
  });

  test('non-ephemeral (project mode): a rebound Host on a read is NOT ephemeral-gated', async () => {
    // The ephemeral gate must not touch project/desktop read serving — the user
    // chose that root. A rebound-Host read there keeps its prior origin-only
    // posture (here: served, since a server-to-server fetch sends no Origin).
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
  // The two handlers that would otherwise land an `<folder>/.ok/` artifact in
  // the user's tree must short-circuit to 403 BEFORE any disk write. Defense
  // in depth over the content-scope filter: even with a valid body, the
  // ephemeral flag alone refuses the write.
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
      // No `.ok/` sidecar landed in the user's tree.
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
      // No `.ok/templates/` artifact landed in the user's tree.
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

    // No `.ok/`, no sidecars, no leftover atomic-write temp files — only the
    // one edited doc. The `.ok/local/` runtime state lived in the throwaway
    // projectDir, which the harness removed.
    const after = readdirSync(contentDir).sort();
    expect(after).toEqual(['notes.md']);
  });
});
