import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sharedUndoManagerFor } from '@/editor/shared-undo-manager';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  appendProjectionParagraph,
  assertAllConverged,
  createTestClients,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('a remote peer edit never becomes locally undoable', () => {
  test('leaves the receiving client with nothing to undo', async () => {
    const docName = `peer-undo-${crypto.randomUUID()}`;
    const [author, peer] = await createTestClients(server.port, { count: 2, docName });
    try {
      author.doc.transact(() => author.ytext.insert(0, 'Seed paragraph.\n'));
      await assertAllConverged([author, peer], { timeout: 5000 });

      const peerUndo = sharedUndoManagerFor(peer.ytext);
      peerUndo.clear();

      appendProjectionParagraph(author, 'Written by the other client.');
      await pollUntil(() => peer.ytext.toString().includes('Written by the other client.'), 5000);
      await wait(200);

      expect(peerUndo.undoStack).toHaveLength(0);
      expect(peerUndo.canUndo()).toBe(false);

      peerUndo.undo();
      expect(peer.ytext.toString()).toContain('Written by the other client.');
    } finally {
      await Promise.all([author.cleanup(), peer.cleanup()]);
    }
  });

  test('still records the receiving client own edit as undoable', async () => {
    const docName = `peer-undo-own-${crypto.randomUUID()}`;
    const [author, peer] = await createTestClients(server.port, { count: 2, docName });
    try {
      author.doc.transact(() => author.ytext.insert(0, 'Seed paragraph.\n'));
      await assertAllConverged([author, peer], { timeout: 5000 });

      const peerUndo = sharedUndoManagerFor(peer.ytext);
      peerUndo.clear();

      appendProjectionParagraph(peer, 'Typed here.');
      peerUndo.stopCapturing();

      expect(peerUndo.undoStack).toHaveLength(1);
      peerUndo.undo();
      expect(peer.ytext.toString()).not.toContain('Typed here.');
    } finally {
      await Promise.all([author.cleanup(), peer.cleanup()]);
    }
  });
});
