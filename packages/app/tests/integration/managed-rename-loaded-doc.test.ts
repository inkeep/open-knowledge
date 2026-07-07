/**
 * Loaded-Y.Doc rewrite path through real Hocuspocus.
 *
 * The unit harness in api-rename-rollback-summary.test.ts stubs
 * `hocuspocus.documents = new Map()` so the loaded-Y.Doc branch of
 * `applyManagedRenameMapToLoadedDocument` is never exercised end-to-end.
 *
 * This test boots a real server + connected client, opens a doc that
 * contains a wiki-link to another renamed doc, and asserts:
 *  - the client's Y.Text observably mutates from `[[old]]` → `[[new]]`
 *  - the disk file matches
 *  - bridge invariant holds (Y.Text and XmlFragment converge through the
 *    server-authoritative observer A path; precedent #14)
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createMultiClientContext, createRestartableServer, pollUntil } from './test-harness';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('Managed rename — loaded-Y.Doc rewrite path (QA-040 / QA-008)', () => {
  test('open editor on doc with [[old]] link → file rename → Y.Text observably becomes [[new]]', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    // Seed: 'host' contains a wiki-link to 'old'. We will rename 'old' → 'new'
    // via the API. host.md is the doc the client has loaded — it is NOT being
    // renamed, but its body contains a backlink that the rewrite spine touches.
    writeFileSync(join(server.contentDir, 'old.md'), '# Old doc\n', 'utf-8');
    writeFileSync(join(server.contentDir, 'host.md'), '# Host doc\n\nLink: [[old]]\n', 'utf-8');
    await wait(300); // file watcher index settle

    // Connect a client to 'host' and wait for the [[old]] link to appear.
    const ctx = await createMultiClientContext({
      server,
      docName: 'host',
      clientCount: 1,
    });
    cleanups.push(() => ctx.cleanup());

    await pollUntil(
      () =>
        ctx.pools[0]
          .getActive()
          ?.provider.document.getText('source')
          .toString()
          .includes('[[old]]') ?? false,
      8000,
      50,
    );

    const entry = ctx.pools[0].getActive();
    if (!entry) throw new Error('pool[0] has no active entry');
    const doc = entry.provider.document;
    const ytext = doc.getText('source');
    const fragment = doc.getXmlFragment('default');

    // Sanity precondition.
    expect(ytext.toString()).toContain('[[old]]');
    expect(ytext.toString()).not.toContain('[[new]]');

    // Trigger the rename via the consolidated endpoint. host is the loaded
    // doc, old is being renamed — so applyManagedRenameMapToLoadedDocument
    // fires for host (the loaded doc whose body contains the inbound link).
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rename-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'file', fromPath: 'old', toPath: 'new' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      renamed: unknown[];
      rewrittenDocs: unknown[];
    };
    expect(body.renamed).toHaveLength(1);
    expect(body.rewrittenDocs.length).toBeGreaterThan(0);

    // Wait for the loaded-Y.Doc rewrite to land on the connected client.
    await pollUntil(() => ytext.toString().includes('[[new]]'), 5000, 25);
    expect(ytext.toString()).toContain('[[new]]');
    expect(ytext.toString()).not.toContain('[[old]]');

    // Disk content should match (persistence flushed via writeManagedRenameDocumentToDisk
    // for non-loaded docs; for loaded docs the debouncer flushes the post-rewrite Y.Text).
    await wait(800);
    const hostDisk = readFileSync(join(server.contentDir, 'host.md'), 'utf-8');
    expect(hostDisk).toContain('[[new]]');
    expect(hostDisk).not.toContain('[[old]]');

    // Bridge invariant: XmlFragment serialization matches Y.Text body. Use the
    // production normalize pass — observer A's lastSyncedXmlMd path (trailing
    // whitespace stripped both sides per CLAUDE.md "Bridge invariant").
    const fragmentText = fragment.toString();
    expect(fragmentText).toContain('new');
    expect(fragmentText).not.toContain('[[old]]');
  }, 30_000);
});
