/**
 * Producer guard — wired into the real server, silent on legal edits.
 *
 * The Observer-A producer guard runs on every server drain that carries a
 * danger-space node (jsxComponent / table). This pins the OTHER half of its
 * contract from the server-side unit test (which faults the serializer to prove
 * it FIRES): here the serializer is real, so a legal interior edit inside a
 * registered component must round-trip cleanly and the guard must stay silent.
 *
 * Under `bun test` the guard is in its loud (throw) posture, so a false-fire on
 * this legal edit would abort the server-side Observer-A sync and the edit would
 * never reach the persisted bytes — the freshness assertion below would go red.
 * Two clients converge on the fresh bytes, exercising the observer seam
 * multi-client (a read-only guard must not perturb convergence).
 *
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertAllConverged,
  awaitDocQuiescence,
  createTestClients,
  createTestServer,
  getServerState,
  schema,
  type TestClient,
  type TestServer,
} from './test-harness';

const SEED = ['<Callout type="info">', '', 'Original interior body.', '', '</Callout>', ''].join(
  '\n',
);

type PmNodeJson = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PmNodeJson[];
  marks?: unknown[];
};

function currentTree(client: TestClient): PmNodeJson {
  return yXmlFragmentToProseMirrorRootNode(client.fragment, schema).toJSON() as PmNodeJson;
}

/** A legal WYSIWYG interior edit as its settled wire state: rewrite the interior
 *  text and flip the enclosing Callout dirty exactly as the client
 *  SourceDirtyObserver would, so Observer A re-derives from the edited children. */
function planInteriorEdit(tree: PmNodeJson, find: string, replace: string): PmNodeJson {
  const next = structuredClone(tree);
  const walk = (node: PmNodeJson): void => {
    if (node.type === 'jsxComponent' && node.attrs?.componentName === 'Callout') {
      node.attrs = { ...node.attrs, sourceDirty: true };
    }
    if (typeof node.text === 'string' && node.text.includes(find)) {
      node.text = node.text.replace(find, replace);
    }
    node.content?.forEach(walk);
  };
  walk(next);
  return next;
}

function commitFragment(client: TestClient, tree: PmNodeJson): void {
  const pmNode = schema.nodeFromJSON(tree);
  client.doc.transact(() => {
    updateYFragment(client.doc, client.fragment, pmNode, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('producer guard (FR6) — wired, silent on a legal danger-space edit', () => {
  test('a legal interior edit round-trips through the guarded drain; two clients converge on the fresh bytes', async () => {
    const docName = `producer-guard-wiring-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, SEED, { docName, position: 'replace' });
    await wait(300);
    const [a, b] = await createTestClients(server.port, { count: 2, docName });
    try {
      await awaitDocQuiescence(a.doc);
      await awaitDocQuiescence(b.doc);
      await assertAllConverged([a, b]);
      expect(a.doc.getText('source').toString()).toContain('Original interior body');

      // Client A edits the Callout interior. The drain serializes the danger
      // space (jsxComponent present → the guard runs) and, on legal content,
      // must NOT throw — so the fresh bytes reach Y.Text and both peers.
      commitFragment(a, planInteriorEdit(currentTree(a), 'Original', 'EDITED'));
      await awaitDocQuiescence(a.doc);
      await awaitDocQuiescence(b.doc);
      await assertAllConverged([a, b]);

      const persisted = getServerState(server, docName)?.ytext.toString() ?? '';
      expect(persisted).toContain('EDITED interior body');
      expect(persisted).toContain('type="info"');
      expect(persisted.match(/<Callout\b/g)).toHaveLength(1);
      // The remote peer received the same fresh bytes — the read-only guard did
      // not perturb convergence.
      expect(b.doc.getText('source').toString()).toContain('EDITED interior body');
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()]);
    }
  });
});
