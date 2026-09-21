
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  awaitDocQuiescence,
  createTestClient,
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

function planInteriorEdit(
  tree: PmNodeJson,
  find: string,
  replace: string,
  flipDirty: boolean,
): PmNodeJson {
  const next = structuredClone(tree);
  const walk = (node: PmNodeJson): void => {
    if (flipDirty && node.type === 'jsxComponent' && node.attrs?.componentName === 'Callout') {
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

const INDENTED_CALLOUT = /\n[ \t]+<\/?Callout\b/;

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('interior-edit freshness — Observer-A drain re-derives a dirty registered component', () => {
  test('an interior edit reaches the persisted Y.Text bytes via re-derivation', async () => {
    const docName = `interior-edit-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, SEED, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      const seeded = client.doc.getText('source').toString();
      expect(seeded).toContain('Original interior body');
      expect(seeded).not.toContain('EDITED');

      commitFragment(client, planInteriorEdit(currentTree(client), 'Original', 'EDITED', true));
      await awaitDocQuiescence(client.doc);

      const after = getServerState(server, docName)?.ytext.toString() ?? '';
      expect(after).toContain('EDITED interior body');
      expect(after).not.toMatch(INDENTED_CALLOUT);
      expect(after).not.toMatch(/^[ \t]+<Callout\b/m);
      expect(after.match(/<Callout\b/g)).toHaveLength(1);
      expect(after.match(/<\/Callout>/g)).toHaveLength(1);
      expect(after).toContain('type="info"');
    } finally {
      await client.cleanup();
    }
  });

  test('without the client flip, the server structural-freshness derivation re-derives fresh bytes', async () => {
    const docName = `interior-edit-noflip-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, SEED, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      expect(client.doc.getText('source').toString()).toContain('Original interior body');

      commitFragment(client, planInteriorEdit(currentTree(client), 'Original', 'EDITED', false));
      await awaitDocQuiescence(client.doc);

      const after = getServerState(server, docName)?.ytext.toString() ?? '';
      expect(after).toContain('EDITED interior body');
      expect(after).not.toContain('Original interior body');
      expect(after).not.toMatch(INDENTED_CALLOUT);
      expect(after.match(/<Callout\b/g)).toHaveLength(1);
      expect(after).toContain('type="info"');
    } finally {
      await client.cleanup();
    }
  });
});
