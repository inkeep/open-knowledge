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
  }, 30_000);
  return server;
}

describe('editor-area swap — gate propagation', () => {
  test('conflict raise → dissolve round-trip preserves Y.Text identity', async () => {
    const docName = `swap-roundtrip-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'), 30_000);

    const ytextRefBefore = client.ytext;

    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => server.instance.conflicts.has(docName), 30_000);

    expect(server.instance.conflicts.findByDocName(docName)).toMatchObject({
      kind: 'reconcile',
      reason: 'disk-markers',
    });

    expect(server.instance.hocuspocus.documents.get(docName)).toBeTruthy();
    server.instance.conflicts.dissolveReconcile(docName);
    expect(server.instance.conflicts.has(docName)).toBe(false);

    expect(client.ytext).toBe(ytextRefBefore);
    expect(client.ytext).toBe(client.doc.getText('source'));
  }, 60_000);
});
