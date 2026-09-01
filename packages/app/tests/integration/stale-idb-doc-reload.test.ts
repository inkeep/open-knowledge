import './idb-preload';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  createClientPersistence,
  UNKNOWN_BRANCH_SENTINEL,
} from '../../src/editor/client-persistence';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  awaitFileWatcherIndexed,
  createTestServer,
  getServerState,
  pollUntil,
  seedPoolServerInstanceId,
  wait,
} from './test-harness';

const FIXTURE_V1 = `# Lineage Fixture

Stable paragraph: shared marker LINEAGE-ALPHA.

## Session One Section

Paragraph with marker LINEAGE-V1-ONLY that the rewrite removes.
`;

const FIXTURE_V2 = `# Lineage Fixture

Stable paragraph: shared marker LINEAGE-ALPHA.

## Session Two Section

Paragraph with marker LINEAGE-V2-ONLY introduced by the rewrite.
`;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function readPersistedYtext(docName: string, serverInstanceId: string): Promise<string> {
  const doc = new Y.Doc();
  const persistence = createClientPersistence({
    branch: UNKNOWN_BRANCH_SENTINEL,
    serverInstanceId,
    docName,
    doc,
  });
  try {
    await persistence.whenSynced;
    return doc.getText('source').toString();
  } finally {
    await persistence.destroy();
    doc.destroy();
  }
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('client-persisted state meets a re-seeded doc lineage (same server instance)', () => {
  test('reopening a doc the server unloaded and re-seeded from disk shows the disk content exactly once', async () => {
    const server = await createTestServer();
    cleanups.push(() => server.cleanup());

    const docName = `lineage-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, FIXTURE_V1, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    const serverInstanceId = await seedPoolServerInstanceId(server, pool);

    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);
    const session1Text = pool.getActive()?.provider.document.getText('source').toString() ?? '';
    expect(countOccurrences(session1Text, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(session1Text, 'LINEAGE-V1-ONLY')).toBe(1);

    await pollUntil(
      async () =>
        countOccurrences(await readPersistedYtext(docName, serverInstanceId), 'LINEAGE-V1-ONLY') >
        0,
      10_000,
      100,
    );

    pool.close(docName);

    rmSync(filePath);
    await pollUntil(() => getServerState(server, docName) === null, 20_000, 100);
    writeFileSync(filePath, FIXTURE_V2, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);
    await wait(500);

    const clientYtext = (): string =>
      pool.getActive()?.provider.document.getText('source').toString() ?? '';
    const serverYtext = (): string => getServerState(server, docName)?.ytext.toString() ?? '';

    const clientText = clientYtext();
    expect(countOccurrences(clientText, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(clientText, 'LINEAGE-V1-ONLY')).toBe(0);
    expect(countOccurrences(clientText, 'LINEAGE-V2-ONLY')).toBe(1);

    await pollUntil(() => clientYtext().length > 0 && clientYtext() === serverYtext(), 10_000, 100);
    expect(clientYtext()).toBe(FIXTURE_V2);
    expect(countOccurrences(serverYtext(), 'LINEAGE-ALPHA')).toBe(1);

    await wait(1500);
    const diskContent = readFileSync(filePath, 'utf-8');
    expect(countOccurrences(diskContent, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(diskContent, 'LINEAGE-V1-ONLY')).toBe(0);
    expect(countOccurrences(diskContent, 'LINEAGE-V2-ONLY')).toBe(1);
  }, 120_000);
});
