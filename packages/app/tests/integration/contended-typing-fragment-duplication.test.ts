/**
 * Why the assertion is at the server Y.Text level: that is the authoritative source persisted to
 * disk and converged to every peer (precedent #38, Y.Text-is-truth).
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  getServerState,
  type TestClient,
  type TestServer,
} from './test-harness';

const STEPS_UNCLOSED = [
  '## Guide',
  '',
  'Intro paragraph.',
  '',
  '<Steps>',
  '',
  '<Step>',
  '',
  'Step one body.',
  '',
].join('\n');
const CLOSING = '</Step>\n\n</Steps>\n';

let server: TestServer;
let client: TestClient;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await client?.cleanup();
  await server?.cleanup();
});

test('concurrent client structural replace vs Observer-B rewrite must not duplicate the Step subtree', async () => {
  client = await createTestClient(server.port, undefined, {
    syncControl: true,
    skipInvariantWatcher: true,
  });

  client.doc.transact(() => {
    client.ytext.insert(0, STEPS_UNCLOSED);
  });
  await awaitDocQuiescence(client.doc, { timeoutMs: 10_000, idleTicks: 5 });

  const pre = getServerState(server, client.docName);
  expect(pre).not.toBeNull();
  expect(pre?.ytext.toString().match(/Step one body\./g)?.length).toBe(1);

  client.pauseSync();

  let at = client.ytext.length;
  for (const ch of CLOSING) {
    client.doc.transact(() => {
      client.ytext.insert(at, ch);
    });
    at += 1;
  }

  expect(client.fragment.length).toBeGreaterThanOrEqual(5);
  const fallback = new Y.XmlElement('rawMdxFallback');
  fallback.setAttribute('reason', 'Unregistered component: Step');
  fallback.insert(0, [new Y.XmlText('<Step>\n\nStep one body.\n\n</Step>')]);
  client.doc.transact(() => {
    client.fragment.delete(2, 3);
    client.fragment.insert(2, [fallback]);
  });

  client.resumeSync();
  await awaitDocQuiescence(client.doc, { timeoutMs: 15_000, idleTicks: 10 });

  const post = getServerState(server, client.docName);
  expect(post).not.toBeNull();
  const bytes = post?.ytext.toString() ?? '';

  expect(bytes.match(/Step one body\./g)?.length ?? 0).toBe(1);
  expect(bytes.match(/<Step>/g)?.length ?? 0).toBe(1);
  expect(bytes.match(/<Steps>/g)?.length ?? 0).toBe(1);

  expect(post?.md.match(/Step one body\./g)?.length ?? 0).toBe(1);
  expect(post?.md.match(/<Step>/g)?.length ?? 0).toBe(1);
}, 30_000);
