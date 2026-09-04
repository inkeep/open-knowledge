import { buildProjection } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';
import {
  installCmMeasurementStubs,
  mountSourceUndoEditor,
  runSourceUndo,
  typeInSource,
} from './source-undo-rig.test-helper';
import {
  applyProjectionEdit,
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  editProjectionBlocks,
  mdManager,
  projectionBlocks,
  schema,
  type TestClient,
  type TestServer,
  wait,
} from './test-harness';

const WYSIWYG_LOCAL_ORIGIN = Object.freeze({ kind: 'source-undo-flip-wysiwyg-local-edit' });

let restoreDom: (() => void) | null = null;
let server: TestServer;

beforeAll(async () => {
  const nativeEvent = globalThis.Event;
  restoreDom = installDomGlobals();
  installCmMeasurementStubs();
  globalThis.Event = nativeEvent;
  server = await createTestServer();
}, 60_000);

afterAll(async () => {
  await server?.cleanup();
  restoreDom?.();
});

async function pollUntil(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(25);
  }
  throw new Error(`pollUntil timed out: ${label}`);
}

function paragraphTexts(source: string): string[] {
  return projectionBlocks(buildProjection(source, mdManager).doc).map((b) => b.textContent);
}

interface Mounted {
  client: TestClient;
  parent: HTMLElement;
  mounted: ReturnType<typeof mountSourceUndoEditor>;
}

async function mountProductionEditor(): Promise<Mounted> {
  const client: TestClient = await createTestClient(server.port);
  const parent = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(parent);
  const mounted = mountSourceUndoEditor({
    ytext: client.ytext,
    awareness: client.provider.awareness ?? undefined,
    wiring: 'production',
    parent,
  });
  return { client, parent, mounted };
}

async function teardown({ client, parent, mounted }: Mounted): Promise<void> {
  mounted.destroy();
  parent.remove();
  await client.cleanup();
}

describe('source undo after a mode flip (real server observers + real provider)', () => {
  test('one source undo after an untracked WYSIWYG-derived rewrite must not destroy the pre-flip burst', {
    timeout: 60_000,
  }, async () => {
    const rig = await mountProductionEditor();
    const { client } = rig;
    const { view, undoManager, setSourceModeActive } = rig.mounted;

    try {
      setSourceModeActive(true);
      typeInSource(view, 'hello bug\n');
      typeInSource(view, '\n');
      typeInSource(view, '\n');
      typeInSource(view, 'hello bug');
      expect(client.ytext.toString()).toBe('hello bug\n\n\nhello bug');
      expect(undoManager.undoStack.length).toBe(1);

      await pollUntil(
        () =>
          paragraphTexts(client.ytext.toString()).filter((t) => t.includes('hello bug')).length >=
          2,
        'the projection holds the two paragraphs',
      );
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });

      setSourceModeActive(false);

      editProjectionBlocks(
        client,
        (blocks) => [
          blocks[0],
          schema.node('paragraph', null, schema.text('oops')),
          ...blocks.slice(1),
        ],
        WYSIWYG_LOCAL_ORIGIN,
      );
      await pollUntil(
        () => client.ytext.toString().includes('oops'),
        'the projection splice wrote the inserted paragraph into Y.Text',
      );

      applyProjectionEdit(
        client,
        (tr, doc) => tr.insertText(' oops', doc.content.size - 1),
        WYSIWYG_LOCAL_ORIGIN,
      );
      await pollUntil(
        () => client.ytext.toString().includes('hello bug oops'),
        'the projection splice wrote the appended text into Y.Text',
      );
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });

      setSourceModeActive(true);

      const textBeforeUndo = client.ytext.toString();
      expect(textBeforeUndo.match(/hello bug/g)?.length).toBe(2);
      expect(textBeforeUndo).toContain('oops');

      runSourceUndo(view, 'production');
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });

      expect(client.ytext.toString()).toBe(textBeforeUndo);
    } finally {
      await teardown(rig);
    }
  });

  test('a flip round trip with no rewrite seals the capture window and preserves history', {
    timeout: 60_000,
  }, async () => {
    const rig = await mountProductionEditor();
    const { client } = rig;
    const { view, undoManager, setSourceModeActive } = rig.mounted;

    try {
      setSourceModeActive(true);
      typeInSource(view, 'hello bug\n\n\nhello bug');
      expect(undoManager.undoStack.length).toBe(1);

      await pollUntil(
        () =>
          paragraphTexts(client.ytext.toString()).filter((t) => t.includes('hello bug')).length >=
          2,
        'the projection holds the two paragraphs',
      );
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });

      setSourceModeActive(false);

      await wait(250);
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });
      expect(client.ytext.toString()).toBe('hello bug\n\n\nhello bug');

      setSourceModeActive(true);

      typeInSource(view, ' tail');
      expect(undoManager.undoStack.length).toBe(2);

      runSourceUndo(view, 'production');
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });
      expect(client.ytext.toString()).toBe('hello bug\n\n\nhello bug');
    } finally {
      await teardown(rig);
    }
  });
});
