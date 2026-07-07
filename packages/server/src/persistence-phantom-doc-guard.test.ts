/**
 * Bun-tier coverage for the phantom-doc guard in `persistence.onStoreDocument`.
 *
 * The guard refuses to materialize a 0-byte file when the Y.Doc was never
 * confirmed to exist on disk (no reconciledBase from a successful
 * onLoadDocument) AND the serialized markdown is empty. Without it, any
 * code path that opens a Y.Doc for a missing docName produces an empty
 * orphan file at that path on the next debounced store — including the
 * race during sidebar rename, `/api/document?docName=<missing>`, and MCP
 * queries on deleted docs.
 *
 * Tests drive the production `onStoreDocument` path via `createServer` +
 * `openDirectConnection` + direct server-side Y.Doc transactions — same
 * shape used by the sibling `persistence-phantom-commit.test.ts`. A future
 * refactor that removes or reorders the guard fails the negative test
 * below; a regression that breaks legitimate first-writes fails the
 * positive test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import * as Y from 'yjs';
import { createServer } from './server-factory.ts';

interface Fixture {
  tmpDir: string;
  contentDir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ok-phantom-doc-'));
  const contentDir = tmpDir;
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  return {
    tmpDir,
    contentDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/**
 * Assert `existsSync(filePath) === false` for the entire window. A fixed
 * sleep would false-pass if the debounce hadn't yet fired by the time we
 * checked; polling proves the file stayed absent across the debounce flush
 * + any asynchronous post-processing.
 */
async function expectFileAbsentFor(
  filePath: string,
  { durationMs = 800, pollMs = 50 }: { durationMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      throw new Error(`Phantom file appeared at ${filePath} within the no-write window`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Poll until the file exists with the expected content, or fail with
 * context. Mirrors `waitForContributorCount` from the sibling test.
 */
async function waitForFileWithContent(
  filePath: string,
  needle: string,
  { timeoutMs = 5_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const content = await Bun.file(filePath).text();
      if (content.includes(needle)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`File ${filePath} did not contain "${needle}" within ${timeoutMs}ms`);
}

describe('persistence onStoreDocument phantom-doc guard', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('opening a Y.Doc for a missing docName + empty transaction does NOT create a file', async () => {
    // Pre-condition: the file does not exist on disk.
    const ghostPath = join(fixture.contentDir, 'nonexistent-ghost.md');
    expect(existsSync(ghostPath)).toBe(false);

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      // Short debounce so the L1 drain fires fast in-test.
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await server.ready;
    try {
      const conn = await server.hocuspocus.openDirectConnection('nonexistent-ghost');
      const serverDoc = server.hocuspocus.documents.get('nonexistent-ghost');
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      // Fire a transaction shaped like y-prosemirror's editor-mount init —
      // an empty paragraph append. Mirrors the exact shape that triggered
      // the rename data-loss bug: the orphaned server-side Y.Doc receives
      // browser sync messages, accumulates an empty fragment, and would
      // otherwise flush an empty markdown to disk via the debounced store.
      const connectionOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-phantom-guard' } },
      };
      serverDoc.transact(() => {
        serverDoc.getXmlFragment('default').push([new Y.XmlElement('paragraph')]);
      }, connectionOrigin);

      // The guard's invariant: with `currentBase === undefined` (file never
      // existed → onLoadDocument returned early without setReconciledBase)
      // AND `normalizeBridge(markdown) === ''` (the empty paragraph
      // normalizes to the empty string), onStoreDocument returns BEFORE
      // the disk write. Steady-state-poll across the debounce window so a
      // delayed phantom write would fail the test rather than slip past.
      await expectFileAbsentFor(ghostPath, { durationMs: 800 });

      conn.disconnect();
    } finally {
      await server.destroy();
    }

    // Post-condition: still no file at the path.
    expect(existsSync(ghostPath)).toBe(false);
  });

  test('lifecycle="deleted-upstream" prevents persistence from resurrecting a removed file', async () => {
    // Repro for the user-reported "CRDT ghost auto-regenerates on rm"
    // class: a file is loaded into a Y.Doc, the user rms it, the file
    // watcher's delete event marks the doc lifecycle, but a debounced
    // store from a prior transaction still fires after the unload — and
    // before this guard, that store rewrote the in-memory state to disk,
    // resurrecting the file the user just deleted.
    //
    // Guard: `onStoreDocument` checks `lifecycle.status === 'deleted-upstream'`
    // at the very top and short-circuits before any disk write.
    const docPath = join(fixture.contentDir, 'mortal-doc.md');
    writeFileSync(docPath, '# Mortal\n\nReal content here.\n', 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await server.ready;
    try {
      // Load the doc into memory (simulates a prior session leaving the
      // Y.Doc resident). reconciledBase is set by onLoadDocument.
      const conn = await server.hocuspocus.openDirectConnection('mortal-doc');
      const serverDoc = server.hocuspocus.documents.get('mortal-doc');
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      // Simulate the file-watcher delete handler: mark lifecycle BEFORE
      // any pending store fires. (The real handler also calls
      // forceUnloadDocument; here we just verify the persistence guard
      // in isolation since unload behavior is Hocuspocus-internal.)
      serverDoc.getMap('lifecycle').set('status', 'deleted-upstream');

      // rm the file out from under the Y.Doc.
      rmSync(docPath);
      expect(existsSync(docPath)).toBe(false);

      // Fire a transaction with REAL content — not just an empty paragraph.
      // Without the lifecycle guard, the semantically-unchanged short-circuit
      // wouldn't fire (markdown differs from base), so onStoreDocument would
      // proceed past every other check and write the resurrected file.
      const connectionOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-rm-after-load' } },
      };
      serverDoc.transact(() => {
        const frag = serverDoc.getXmlFragment('default');
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [new Y.XmlText('NEW content that would resurrect the file')]);
        frag.push([para]);
      }, connectionOrigin);

      // Steady-state poll: the file MUST stay absent across the debounce
      // window. A regression that drops the lifecycle guard would have
      // resurrected the file by now.
      await expectFileAbsentFor(docPath, { durationMs: 800 });

      conn.disconnect();
    } finally {
      await server.destroy();
    }

    expect(existsSync(docPath)).toBe(false);
  });

  test('opening a Y.Doc for a missing docName + non-empty transaction DOES create the file', async () => {
    // Pre-condition: the file does not exist on disk. This scenario mirrors
    // the agent-write-md flow against a brand-new doc — without the guard
    // distinguishing empty-vs-non-empty, a naive "skip if no reconciledBase"
    // would silently swallow legitimate first-writes (data loss for new
    // agent-authored docs). The guard MUST allow this path through.
    const newDocPath = join(fixture.contentDir, 'new-doc.md');
    expect(existsSync(newDocPath)).toBe(false);

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await server.ready;
    try {
      const conn = await server.hocuspocus.openDirectConnection('new-doc');
      const serverDoc = server.hocuspocus.documents.get('new-doc');
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const connectionOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-real-content' } },
      };
      // Real content — visible text inside a paragraph. normalizeBridge
      // sees a non-empty markdown body, so the guard's empty-content
      // condition is false and the write proceeds.
      serverDoc.transact(() => {
        const frag = serverDoc.getXmlFragment('default');
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [new Y.XmlText('first content from a fresh doc')]);
        frag.push([para]);
      }, connectionOrigin);

      // Event-driven wait — the file MUST appear with our content within
      // the debounce + write window.
      await waitForFileWithContent(newDocPath, 'first content from a fresh doc');
      conn.disconnect();
    } finally {
      await server.destroy();
    }

    expect(existsSync(newDocPath)).toBe(true);
    const content = await Bun.file(newDocPath).text();
    expect(content).toContain('first content from a fresh doc');
  });
});
