import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  awaitWipCommits,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness.ts';

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

    const putFolder = await folderTimeline(folder);
    const createEvent = putFolder.find((e) => e.message.startsWith('template-create:'));
    expect(createEvent).toBeDefined();
    expect(createEvent?.contributors.some((c) => c.docs.includes(docName))).toBe(true);

    const storeMinted = (e: HistoryEntry) => e.sha !== createEvent?.sha;

    const putDoc = await docHistory(docName);
    expect(putDoc.length).toBeGreaterThanOrEqual(1);
    expect(putDoc.filter(storeMinted).every((e) => /^wip:/i.test(e.message))).toBe(true);

    const coalescedRow = putDoc.find((e) => !storeMinted(e));
    if (coalescedRow !== undefined) {
      expect(coalescedRow.message).toBe(createEvent?.message);
      expect(coalescedRow.contributors.some((c) => c.docs.includes(docName))).toBe(true);
    }

    const putShas = new Set(putDoc.map((e) => e.sha));

    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    await pollUntil(() => client.ytext.toString().includes('Agenda.'), 5000);
    client.doc.transact(() => {
      client.ytext.insert(client.ytext.length, '\nMore agenda.\n');
    });

    let editDoc: HistoryEntry[] = [];
    let editEntry: HistoryEntry | undefined;
    await pollUntil(
      async () => {
        await fetch(`http://127.0.0.1:${server.port}/api/test-flush-git`, { method: 'POST' }).catch(
          () => null,
        );
        editDoc = await docHistory(docName);
        editEntry = editDoc.find((e) => !putShas.has(e.sha) && storeMinted(e));
        return editEntry !== undefined;
      },
      20_000,
      250,
    );
    await client.cleanup();

    expect(editEntry?.message).toMatch(/^wip:/i);
    expect(editDoc.filter(storeMinted).every((e) => /^wip:/i.test(e.message))).toBe(true);

    const editFolder = await folderTimeline(folder);
    expect(editFolder.filter((e) => e.message.startsWith('template-'))).toHaveLength(1);
    expect(editFolder.every((e) => !/^wip:/i.test(e.message))).toBe(true);
  }, 30_000);
});
