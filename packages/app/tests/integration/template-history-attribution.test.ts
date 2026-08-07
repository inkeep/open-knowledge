import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  awaitWipCommits,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness.ts';

/**
 * End-to-end proof, through the real server + real shadow git, that a template's
 * attribution stays whole across the cutover and that the content store never
 * mints a typed folder subject.
 *
 * A template is now an ordinary content doc at `<folder>/.ok/templates/<name>`.
 * An HTTP lifecycle write records its contributor under
 * `okArtifactKey('template', folder, name)`, which is byte-identical to that
 * content doc name — so the typed `template-create` folder event and the plain
 * `wip:` doc commits both resolve to the one content-doc identity. Crucially,
 * the persistence store's own commits are `wip:`: the typed `template-*` subject
 * is stamped only by the HTTP route (a folder-timeline event), never by the
 * store as an editor CRDT edit flows through it.
 */
type HistoryEntry = {
  sha: string;
  message: string;
  type: string;
  contributors: Array<{ docs: string[] }>;
};

describe('template history — HTTP typed writes and editor wip edits unify under one key (FR6 / D11)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer({ gitEnabled: true, commitDebounceMs: 100 });
  });
  afterEach(async () => {
    await server.cleanup();
  });

  async function history(query: string): Promise<HistoryEntry[]> {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history?${query}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: HistoryEntry[] };
    return body.entries;
  }

  const docHistory = (docName: string) =>
    history(`docName=${encodeURIComponent(docName)}&limit=100`);
  const folderTimeline = (folder: string) => history(`folder=${encodeURIComponent(folder)}`);

  test('a typed HTTP write attributes under the content doc name; the store mints wip:, never a typed folder subject', async () => {
    const folder = 'notes';
    const name = `standup-${randomUUID().slice(0, 8)}`;
    const docName = `${folder}/.ok/templates/${name}`;

    // HTTP create routes composed bytes through the template's CRDT doc and
    // stamps a typed `template-create:` folder event, attributed under
    // okArtifactKey('template', folder, name). The agentId makes attribution
    // non-anonymous, so the typed subject is actually recorded (an anonymous
    // write would fall back to a plain wip: subject).
    const putRes = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder,
        name,
        body: '# Standup\n\nAgenda.\n',
        frontmatter: { title: 'Standup', description: 'Use for standups.' },
        agentId: 'http-writer',
      }),
    });
    expect(putRes.status).toBe(200);
    await awaitWipCommits(server, docName, 1);

    // The typed lifecycle event lives on the FOLDER timeline, attributed under a
    // key byte-identical to the content doc name — this is the attribution
    // identity the editor edits below share.
    const putFolder = await folderTimeline(folder);
    const createEvent = putFolder.find((e) => e.message.startsWith('template-create:'));
    expect(createEvent).toBeDefined();
    expect(createEvent?.contributors.some((c) => c.docs.includes(docName))).toBe(true);

    // The store's OWN commit for the doc content is a plain wip: subject — the
    // typed `template-*` subject is the HTTP route's folder event, not the store's.
    const putDoc = await docHistory(docName);
    expect(putDoc.length).toBeGreaterThanOrEqual(1);
    expect(putDoc.every((e) => /^wip:/i.test(e.message))).toBe(true);
    const putShas = new Set(putDoc.map((e) => e.sha));

    // An editor CRDT edit to the same doc lands as an ordinary content write.
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    await pollUntil(() => client.ytext.toString().includes('Agenda.'), 5000);
    client.doc.transact(() => {
      client.ytext.insert(client.ytext.length, '\nMore agenda.\n');
    });

    // Await the editor edit's OWN commit — a NEW wip: row distinct from the PUT's
    // (flush every poll to drain the L2 debounce deterministically).
    let editDoc: HistoryEntry[] = [];
    let editEntry: HistoryEntry | undefined;
    await pollUntil(
      async () => {
        await fetch(`http://127.0.0.1:${server.port}/api/test-flush-git`, { method: 'POST' }).catch(
          () => null,
        );
        editDoc = await docHistory(docName);
        editEntry = editDoc.find((e) => !putShas.has(e.sha));
        return editEntry !== undefined;
      },
      20_000,
      250,
    );
    await client.cleanup();

    // The editor edit is in the template's OWN document history (unifying under
    // the content doc name) and the store minted a wip: subject for it — not a
    // typed template-* subject. A store that started stamping typed template-*
    // subjects on content edits would flip this message; that must never happen.
    expect(editEntry?.message).toMatch(/^wip:/i);
    expect(editDoc.every((e) => /^wip:/i.test(e.message))).toBe(true);

    // The editor CRDT edit produced NO new folder event — the folder timeline
    // still carries exactly the one typed HTTP subject, and no wip: row leaks in.
    const editFolder = await folderTimeline(folder);
    expect(editFolder.filter((e) => e.message.startsWith('template-'))).toHaveLength(1);
    expect(editFolder.every((e) => !/^wip:/i.test(e.message))).toBe(true);
  }, 30_000);
});
