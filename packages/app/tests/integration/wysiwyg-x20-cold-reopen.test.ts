/**
 * RED integration test — `&#x20;` literal in the WYSIWYG after close + reopen.
 *
 * The teammate's report: "random characters `&#x20;` inserted into my doc …
 * after closing and reopening a doc". A phrasing-boundary space is stored by
 * the byte-fidelity serializer as a bare `&#x20;`; on a COLD reopen (Y.Doc
 * evicted from server memory → re-parse from disk) it comes back as the literal
 * six characters `&#x20;` in the editor instead of a real space.
 *
 * These tests drive the FULL real-app chain the unit-tier PM-altitude test
 * (`packages/core/src/markdown/boundary-whitespace-pm-display.test.ts`) cannot:
 * agent write → Observer A serialize → persistence → disk, then cold restart →
 * onLoadDocument re-parse → fragment. They assert the editor-visible text (the
 * server XmlFragment's ProseMirror textContent) shows a real space, while the
 * disk bytes stay byte-identical `&#x20;` (byte-fidelity unchanged — this also
 * guards the known ProseMirror trailing-space-trim risk: a trimmed space would
 * drop `sourceRaw` and corrupt the disk bytes on the next serialize).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import {
  agentWriteMd,
  createRestartableServer,
  createTestClient,
  createTestServer,
  pollDiskContentStable,
  pollUntil,
  schema,
  type TestServer,
} from './test-harness';

/** Both TestServer and RestartableServer expose the same `.instance`. */
type AnyServer = { instance: TestServer['instance'] };

/** The loaded server-side XmlFragment for a doc, or undefined if not loaded. */
function serverFragment(server: AnyServer, docName: string): Y.XmlFragment | undefined {
  return server.instance.hocuspocus.documents.get(docName)?.getXmlFragment('default');
}

/** Editor-visible text of an XmlFragment — what the user actually sees. */
function fragmentVisibleText(fragment: Y.XmlFragment): string {
  return yXmlFragmentToProseMirrorRootNode(fragment, schema).textContent;
}

describe('WYSIWYG &#x20; literal after close + cold reopen (the reported bug)', () => {
  test('agent write of a boundary space, cold restart, reopen: shows a space, bytes stable', async () => {
    let server = await createRestartableServer({ debounce: 100, maxDebounce: 400 });
    const docName = `x20-restart-${crypto.randomUUID()}`;
    const docFile = join(server.contentDir, `${docName}.md`);
    try {
      // Write a paragraph whose trailing edge is a phrasing-boundary space.
      // The server parses + Observer-A-serializes; the byte-fidelity engine
      // mints the bare `&#x20;` and persistence flushes it to disk.
      await agentWriteMd(server.port, 'before&#x20;', {
        docName,
        position: 'replace',
      });
      const preDisk = await pollDiskContentStable(docFile, (c) => c.includes('before&#x20;'), {
        timeoutMs: 8000,
        settleMs: 300,
      });
      expect(preDisk).toContain('before&#x20;');

      // Cold restart on the same port — Y.Doc evicted; next connect re-parses disk.
      server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });

      const client = await createTestClient(server.port, docName);
      try {
        await pollUntil(() => serverFragment(server, docName) !== undefined, 10_000, 50);
        const fragment = serverFragment(server, docName);
        if (!fragment) throw new Error('doc not loaded on server after cold restart');

        const shown = fragmentVisibleText(fragment);
        // The editor shows the literal six characters `&#x20;`.
        expect(shown).not.toContain('&#x20;');
        expect(shown).toContain('before ');

        // Byte-fidelity: after reopen + a settle window the disk bytes are still
        // the bare `&#x20;`. A trimmed trailing space would corrupt this.
        const postDisk = await pollDiskContentStable(docFile, (c) => c.includes('before&#x20;'), {
          timeoutMs: 5000,
          settleMs: 300,
        });
        expect(postDisk).toContain('before&#x20;');
      } finally {
        await client.cleanup();
      }
    } finally {
      await server.shutdown();
    }
  }, 30_000);
});

describe('WYSIWYG &#x20; literal — pure cold load of a doc already stored with &#x20;', () => {
  let server: TestServer | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await server?.cleanup();
    server = undefined;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test('cold load shows a real space, not literal &#x20;, and bytes are byte-stable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-x20-coldload-'));
    const docName = `x20-${crypto.randomUUID()}`;
    // A doc that was saved earlier with a phrasing-boundary space.
    writeFileSync(join(dir, `${docName}.md`), 'alpha&#x20;\n', 'utf-8');

    server = await createTestServer({ contentDir: dir, keepContentDir: true });
    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(
        () => serverFragment(server as TestServer, docName) !== undefined,
        10_000,
        50,
      );
      const fragment = serverFragment(server, docName);
      if (!fragment) throw new Error('doc not loaded on server');

      const shown = fragmentVisibleText(fragment);
      expect(shown).not.toContain('&#x20;');
      expect(shown).toContain('alpha ');

      // disk unchanged through the cold load (the decoded space re-serializes to &#x20;)
      const disk = await pollDiskContentStable(
        join(dir, `${docName}.md`),
        (c) => c.includes('alpha&#x20;'),
        { timeoutMs: 5000, settleMs: 300 },
      );
      expect(disk).toContain('alpha&#x20;');
    } finally {
      await client.cleanup();
    }
  }, 30_000);

  test('cold load of ADJACENT refs shows multiple spaces and keeps bytes byte-stable', async () => {
    // Regression: two byte-identical adjacent refs must not be destroyed —
    // ProseMirror merges equal-mark decoded nodes; without coalescing the run
    // into one sourceLiteral segment, the gate drops sourceRaw and the decoded
    // spaces overwrite the &#x20; bytes on disk.
    dir = mkdtempSync(join(tmpdir(), 'ok-x20-adjacent-'));
    const docName = `x20adj-${crypto.randomUUID()}`;
    writeFileSync(join(dir, `${docName}.md`), 'gamma&#x20;&#x20;delta\n', 'utf-8');

    server = await createTestServer({ contentDir: dir, keepContentDir: true });
    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(
        () => serverFragment(server as TestServer, docName) !== undefined,
        10_000,
        50,
      );
      const fragment = serverFragment(server, docName);
      if (!fragment) throw new Error('doc not loaded on server');

      const shown = fragmentVisibleText(fragment);
      expect(shown).not.toContain('&#x20;');
      expect(shown).toContain('gamma  delta'); // two real spaces

      const disk = await pollDiskContentStable(
        join(dir, `${docName}.md`),
        (c) => c.includes('gamma&#x20;&#x20;delta'),
        { timeoutMs: 5000, settleMs: 300 },
      );
      expect(disk).toContain('gamma&#x20;&#x20;delta');
    } finally {
      await client.cleanup();
    }
  }, 30_000);
});
