import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';
import {
  installCmMeasurementStubs,
  mountSourceUndoEditor,
  runSourceUndo,
  typeInSource,
} from './source-undo-rig.test-helper';
import {
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
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

function paragraphTexts(fragment: Y.XmlFragment): string[] {
  return fragment
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement)
    .map((el) => el.toString().replace(/<[^>]+>/g, ''));
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
        () => paragraphTexts(client.fragment).filter((t) => t.includes('hello bug')).length >= 2,
        'Observer B derived the two paragraphs into the client fragment',
      );
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });

      setSourceModeActive(false);

      client.doc.transact(() => {
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'oops');
        p.insert(0, [t]);
        client.fragment.insert(1, [p]);
      }, WYSIWYG_LOCAL_ORIGIN);
      await pollUntil(
        () => client.ytext.toString().includes('oops'),
        'Observer A wrote the inserted paragraph back into Y.Text',
      );

      client.doc.transact(() => {
        const paras = client.fragment
          .toArray()
          .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement);
        const last = paras[paras.length - 1];
        const textNode = last?.get(0);
        if (!(textNode instanceof Y.XmlText)) throw new Error('expected XmlText in paragraph');
        textNode.insert(textNode.length, ' oops');
      }, WYSIWYG_LOCAL_ORIGIN);
      await pollUntil(
        () => client.ytext.toString().includes('hello bug oops'),
        'Observer A wrote the appended text back into Y.Text',
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
        () => paragraphTexts(client.fragment).filter((t) => t.includes('hello bug')).length >= 2,
        'Observer B derived the two paragraphs into the client fragment',
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
