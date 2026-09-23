import type { EditorView } from '@codemirror/view';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PROJECTION_WRITE_ORIGIN } from '../../src/editor/shared-undo-manager';
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
  type TestClient,
  type TestServer,
  wait,
} from './test-harness';

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

interface Mounted {
  client: TestClient;
  peer: TestClient;
  parent: HTMLElement;
  mounted: ReturnType<typeof mountSourceUndoEditor>;
}

async function mountWithPeer(): Promise<Mounted> {
  const client: TestClient = await createTestClient(server.port);
  const peer: TestClient = await createTestClient(server.port, client.docName);
  const parent = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(parent);
  const mounted = mountSourceUndoEditor({
    ytext: client.ytext,
    awareness: client.provider.awareness ?? undefined,
    wiring: 'production',
    parent,
  });
  return { client, peer, parent, mounted };
}

async function teardown({ client, peer, parent, mounted }: Mounted): Promise<void> {
  mounted.destroy();
  parent.remove();
  peer.provider.destroy();
  peer.doc.destroy();
  await client.cleanup();
}

function deleteInSource(view: EditorView, from: number, to: number): void {
  view.dispatch({ changes: { from, to }, userEvent: 'delete.backward' });
}

function rewriteWholeText(peer: TestClient, text: string): void {
  peer.doc.transact(() => {
    peer.ytext.delete(0, peer.ytext.length);
    peer.ytext.insert(0, text);
  });
}

describe('source undo across a mode flip (real server, real provider, shared manager)', () => {
  test('a peer edit while source mode is away leaves your own edits undoable', {
    timeout: 60_000,
  }, async () => {
    const rig = await mountWithPeer();
    const { client, peer } = rig;
    const { view, undoManager, setSourceModeActive } = rig.mounted;

    try {
      setSourceModeActive(true);
      typeInSource(view, 'hello bug\n\nother paragraph');
      await pollUntil(
        () => peer.ytext.toString() === 'hello bug\n\nother paragraph',
        'the peer sees the source edit',
      );
      undoManager.stopCapturing();

      setSourceModeActive(false);
      applyProjectionEdit(
        client,
        (tr, doc) => tr.insertText(' visual', (doc.firstChild?.nodeSize ?? 2) - 1),
        PROJECTION_WRITE_ORIGIN,
      );
      await pollUntil(
        () => peer.ytext.toString().includes('visual'),
        'the peer sees the visual edit',
      );
      undoManager.stopCapturing();

      peer.doc.transact(() => {
        const at = peer.ytext.toString().indexOf('other paragraph') + 'other paragraph'.length;
        peer.ytext.insert(at, ' PEER');
      });
      await pollUntil(
        () => client.ytext.toString().includes('other paragraph PEER'),
        'the peer edit arrives',
      );
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });

      setSourceModeActive(true);
      expect(undoManager.undoStack.length).toBe(2);

      runSourceUndo(view, 'production');
      expect(client.ytext.toString()).not.toContain('visual');
      expect(client.ytext.toString()).toContain('hello bug\n\nother paragraph PEER');

      runSourceUndo(view, 'production');
      expect(client.ytext.toString()).not.toContain('hello bug');
      expect(client.ytext.toString()).toContain('PEER');
    } finally {
      await teardown(rig);
    }
  });

  test('after a whole-text rewrite while source mode is away, undo cannot resurrect what you deleted', {
    timeout: 60_000,
  }, async () => {
    const rig = await mountWithPeer();
    const { client, peer } = rig;
    const { view, undoManager, setSourceModeActive } = rig.mounted;

    try {
      setSourceModeActive(true);
      typeInSource(view, 'hello bug\n\n\nhello bug');
      undoManager.stopCapturing();
      deleteInSource(view, 0, 6);
      await pollUntil(
        () => peer.ytext.toString() === 'bug\n\n\nhello bug',
        'the peer sees the deletion',
      );

      setSourceModeActive(false);
      rewriteWholeText(peer, 'rewritten by an agent\n');
      await pollUntil(
        () => client.ytext.toString() === 'rewritten by an agent\n',
        'the rewrite arrives',
      );
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });

      setSourceModeActive(true);
      runSourceUndo(view, 'production');
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });
      expect(client.ytext.toString()).toBe('rewritten by an agent\n');

      runSourceUndo(view, 'production');
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });
      expect(client.ytext.toString()).toBe('rewritten by an agent\n');
      expect(undoManager.undoStack.length).toBe(0);
    } finally {
      await teardown(rig);
    }
  });

  test('after a whole-text rewrite while you sit in source mode, undo cannot resurrect what you deleted', {
    timeout: 60_000,
  }, async () => {
    const rig = await mountWithPeer();
    const { client, peer } = rig;
    const { view, undoManager, setSourceModeActive } = rig.mounted;

    try {
      setSourceModeActive(true);
      typeInSource(view, 'hello bug\n\n\nhello bug');
      undoManager.stopCapturing();
      deleteInSource(view, 0, 6);
      await pollUntil(
        () => peer.ytext.toString() === 'bug\n\n\nhello bug',
        'the peer sees the deletion',
      );

      rewriteWholeText(peer, 'rewritten by an agent\n');
      await pollUntil(
        () => client.ytext.toString() === 'rewritten by an agent\n',
        'the rewrite arrives',
      );
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });

      runSourceUndo(view, 'production');
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });
      expect(client.ytext.toString()).toBe('rewritten by an agent\n');

      runSourceUndo(view, 'production');
      await awaitDocQuiescence(client.doc, { timeoutMs: 5000 });
      expect(client.ytext.toString()).toBe('rewritten by an agent\n');
    } finally {
      await teardown(rig);
    }
  });

  test('a flip round trip with no rewrite seals the capture window and preserves history', {
    timeout: 60_000,
  }, async () => {
    const rig = await mountWithPeer();
    const { client } = rig;
    const { view, undoManager, setSourceModeActive } = rig.mounted;

    try {
      setSourceModeActive(true);
      typeInSource(view, 'hello bug\n\n\nhello bug');
      expect(undoManager.undoStack.length).toBe(1);
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
