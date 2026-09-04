import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema, type JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  awaitDocQuiescence,
  createRestartableServer,
  createTestClient,
  createTestServer,
  getServerState,
  mdManager,
  pollUntil,
  schema,
  serializeFragment,
  type TestClient,
  type TestServer,
} from './test-harness';

const freshMdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});
const freshSchema = getSchema(sharedExtensions);

function freshSerializeFragment(fragment: Y.XmlFragment): string {
  return freshMdManager.serialize(
    yXmlFragmentToProseMirrorRootNode(fragment, freshSchema).toJSON(),
  );
}

function mutateFirstText(node: JSONContent, from: string, to: string): boolean {
  if (typeof node.text === 'string' && node.text === from) {
    node.text = to;
    return true;
  }
  for (const child of node.content ?? []) {
    if (mutateFirstText(child, from, to)) return true;
  }
  return false;
}

const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const STALE_LINE = 'Step one bod';
const PENDING_LINE = 'Step one body.';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const SENTINEL = 'TOGGLE-SENTINEL typed in source mode';

function detachClientKeepingServerDoc(client: TestClient): void {
  client.provider.destroy();
  client.doc.destroy();
}

async function stageDeferHeldDivergence(port: number, docName: string, doc: Y.Doc): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
  });
  expect(res.status).toBe(200);

  const ytext = doc.getText('source');
  const fragment = doc.getXmlFragment('default');
  expect(ytext.toString()).toContain(STALE_LINE);

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);

  doc.transact(() => {
    ytext.insert(ytext.length, '\nTrailing.\n');
  }, 'external-peer');
  const echo = mdManager.parse(ytext.toString()) as JSONContent;
  expect(mutateFirstText(echo, STALE_LINE, PENDING_LINE)).toBe(true);
  doc.transact(() => {
    updateYFragment(doc, fragment, schema.nodeFromJSON(echo), {
      mapping: new Map(),
      isOMark: new Map(),
    });
  }, 'wysiwyg-echo');

  doc.transact(() => {
    ytext.insert(ytext.length, `\n${SENTINEL}\n`);
  }, 'external-peer');
}

describe('source → WYSIWYG toggle shows stale content', () => {
  test(
    'a defer-held stale fragment survives a detach and reconnect',
    async () => {
      const ownServer = await createTestServer();
      const docName = `stale-toggle-reopen-${crypto.randomUUID().slice(0, 8)}`;
      let reopened: TestClient | undefined;
      try {
        await fetch(`http://127.0.0.1:${ownServer.port}/api/agent-write-md`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
        });
        const doc = ownServer.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
        expect(doc).toBeTruthy();

        await stageDeferHeldDivergence(ownServer.port, docName, doc);
        vi.useRealTimers();

        expect(doc.getText('source').toString()).toContain(SENTINEL);
        expect(freshSerializeFragment(doc.getXmlFragment('default'))).not.toContain(SENTINEL);

        reopened = await createTestClient(ownServer.port, docName, {
          skipInvariantWatcher: true,
        });
        await awaitDocQuiescence(reopened.doc);
        expect(reopened.ytext.toString()).toContain(SENTINEL);
        expect(serializeFragment(reopened.fragment)).not.toContain(SENTINEL);

        detachClientKeepingServerDoc(reopened);
        reopened = undefined;

        expect(getServerState(ownServer, docName)).not.toBeNull();

        reopened = await createTestClient(ownServer.port, docName, {
          skipInvariantWatcher: true,
        });
        await awaitDocQuiescence(reopened.doc);

        expect(reopened.ytext.toString()).toContain(SENTINEL);
        expect(serializeFragment(reopened.fragment)).not.toContain(SENTINEL);
      } finally {
        vi.useRealTimers();
        if (reopened) {
          reopened.provider.destroy();
          reopened.doc.destroy();
        }
        await ownServer.cleanup();
      }
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'control: restarting the server does clear it',
    async () => {
      let restartable = await createRestartableServer();
      const docName = `stale-toggle-restart-${crypto.randomUUID().slice(0, 8)}`;
      try {
        await fetch(`http://127.0.0.1:${restartable.port}/api/agent-write-md`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
        });
        const doc = restartable.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
        expect(doc).toBeTruthy();

        await stageDeferHeldDivergence(restartable.port, docName, doc);
        vi.useRealTimers();

        expect(doc.getText('source').toString()).toContain(SENTINEL);
        expect(freshSerializeFragment(doc.getXmlFragment('default'))).not.toContain(SENTINEL);

        const filePath = join(restartable.contentDir, `${docName}.md`);
        await pollUntil(
          () => existsSync(filePath) && readFileSync(filePath, 'utf-8').includes(SENTINEL),
          10_000,
        );

        restartable = await restartable.killAndRestartOnSamePort({ downtimeMs: 200 });

        const after = await createTestClient(restartable.port, docName, {
          skipInvariantWatcher: true,
        });
        try {
          await pollUntil(() => serializeFragment(after.fragment).includes(SENTINEL), 10_000);
          expect(after.ytext.toString()).toContain(SENTINEL);
          expect(serializeFragment(after.fragment)).toContain(SENTINEL);
        } finally {
          after.provider.destroy();
          after.doc.destroy();
        }
      } finally {
        vi.useRealTimers();
        await restartable.shutdown();
      }
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});
