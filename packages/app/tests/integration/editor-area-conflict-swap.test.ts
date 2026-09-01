import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestClient, createTestServer, pollUntil, type TestServer } from './test-harness';

const BASE_CONTENT = '# Base\n\nBase paragraph.\n';
const CONFLICT_MARKERS =
  '<<<<<<< HEAD\n# Mine\n\nLocal version.\n=======\n# Theirs\n\nTeam version.\n>>>>>>> origin/main\n';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

async function setupServerWithDoc(docName: string, initial: string): Promise<TestServer> {
  const server = await createTestServer({ debounce: 100, maxDebounce: 500 });
  cleanups.push(() => server.cleanup());
  writeFileSync(join(server.contentDir, `${docName}.md`), initial, 'utf-8');
  await pollUntil(async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
    if (!res?.ok) return false;
    const data = (await res.json()) as { documents?: Array<{ docName: string }> };
    return data.documents?.some((d) => d.docName === docName) ?? false;
  });
  return server;
}

describe('editor-area swap — gate propagation', () => {
  test('lifecycle.status conflict → clear round-trip preserves Y.Text identity', async () => {
    const docName = `swap-roundtrip-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const ytextRefBefore = client.ytext;
    const lifecycle = client.doc.getMap('lifecycle');

    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    expect(lifecycle.get('status')).toBe('conflict');

    const serverDoc = server.instance.hocuspocus.documents.get(docName);
    expect(serverDoc).toBeTruthy();
    serverDoc?.transact(() => {
      serverDoc.getMap('lifecycle').delete('status');
      serverDoc.getMap('lifecycle').delete('reason');
    });

    await pollUntil(() => lifecycle.get('status') === undefined, 5000);
    expect(lifecycle.get('status')).toBeUndefined();

    expect(client.ytext).toBe(ytextRefBefore);
    expect(client.ytext).toBe(client.doc.getText('source'));
  }, 30_000);
});
