import type { HocuspocusProvider } from '@hocuspocus/provider';
import { describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  acquireMermaidUndoManager,
  MERMAID_DIAGRAM_EDIT_ORIGIN,
  replaceYText,
} from './MermaidDocEditor.tsx';

function makeYText(initial: string): { doc: Y.Doc; ytext: Y.Text; events: Y.YTextEvent[] } {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  ytext.insert(0, initial);
  const events: Y.YTextEvent[] = [];
  ytext.observe((ev) => events.push(ev));
  return { doc, ytext, events };
}

describe('replaceYText', () => {
  test('identical strings — no-op (no event fires)', () => {
    const { ytext, events } = makeYText('graph LR\n  A --> B\n');
    replaceYText(ytext, 'graph LR\n  A --> B\n');
    expect(ytext.toString()).toBe('graph LR\n  A --> B\n');
    expect(events.length).toBe(0);
  });

  test('prefix-only change splices at the start, preserves the trailing suffix', () => {
    const { ytext, events } = makeYText('OldPrefix middle suffix');
    replaceYText(ytext, 'NewPrefix middle suffix');
    expect(ytext.toString()).toBe('NewPrefix middle suffix');
    expect(events.length).toBe(1);
  });

  test('suffix-only change splices at the end, preserves the leading prefix', () => {
    const { ytext, events } = makeYText('prefix middle OldSuffix');
    replaceYText(ytext, 'prefix middle NewSuffix');
    expect(ytext.toString()).toBe('prefix middle NewSuffix');
    expect(events.length).toBe(1);
  });

  test('middle change splices only the differing interior', () => {
    const { ytext } = makeYText('prefix OLD suffix');
    replaceYText(ytext, 'prefix NEW suffix');
    expect(ytext.toString()).toBe('prefix NEW suffix');
  });

  test('complete replacement splices the whole doc', () => {
    const { ytext } = makeYText('graph LR\n  A --> B');
    replaceYText(ytext, 'sequenceDiagram\n  A->>B: hi');
    expect(ytext.toString()).toBe('sequenceDiagram\n  A->>B: hi');
  });

  test('empty → content inserts the whole string', () => {
    const { ytext } = makeYText('');
    replaceYText(ytext, 'graph LR\n  A --> B');
    expect(ytext.toString()).toBe('graph LR\n  A --> B');
  });

  test('content → empty deletes the whole string', () => {
    const { ytext } = makeYText('graph LR\n  A --> B');
    replaceYText(ytext, '');
    expect(ytext.toString()).toBe('');
  });

  test('overlapping prefix/suffix (identical surrounding text) locates the middle change', () => {
    const { ytext } = makeYText('abcXabc');
    replaceYText(ytext, 'abcYabc');
    expect(ytext.toString()).toBe('abcYabc');
  });

  test('insertion in a symmetrical repeat preserves both ends', () => {
    const { ytext } = makeYText('abcabc');
    replaceYText(ytext, 'abcZabc');
    expect(ytext.toString()).toBe('abcZabc');
  });

  test('single-character change at the boundary between prefix + suffix', () => {
    const { ytext } = makeYText('aaXaa');
    replaceYText(ytext, 'aaYaa');
    expect(ytext.toString()).toBe('aaYaa');
  });

  test('multi-line mermaid label rewrite (real WYSIWYG shape)', () => {
    const before = 'graph LR\n  Shopper --> Storefront\n  Storefront --> Cart\n';
    const after = 'graph LR\n  Buyer --> Storefront\n  Storefront --> Cart\n';
    const { ytext } = makeYText(before);
    replaceYText(ytext, after);
    expect(ytext.toString()).toBe(after);
  });

  test('splice runs inside a Y.Doc transaction so cursors + peers see one update', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    ytext.insert(0, 'prefix OLD suffix');
    let transactionCount = 0;
    doc.on('afterTransaction', () => {
      transactionCount += 1;
    });
    replaceYText(ytext, 'prefix NEW suffix');
    expect(transactionCount).toBe(1);
    expect(ytext.toString()).toBe('prefix NEW suffix');
  });
});

describe('acquireMermaidUndoManager', () => {
  test('tracks diagram edits but excludes origin-less seed and reconcile writes', () => {
    const { doc, ytext } = makeYText('');
    const provider = {
      document: doc,
      on() {},
      off() {},
    } as unknown as HocuspocusProvider;

    const undoManager = acquireMermaidUndoManager(provider, ytext);

    expect(undoManager.trackedOrigins.has(null)).toBe(false);
    expect(undoManager.trackedOrigins.has(MERMAID_DIAGRAM_EDIT_ORIGIN)).toBe(true);

    replaceYText(ytext, 'seed');
    expect(undoManager.undoStack).toHaveLength(0);

    replaceYText(ytext, 'diagram edit', MERMAID_DIAGRAM_EDIT_ORIGIN);
    expect(undoManager.undoStack).toHaveLength(1);
  });

  test('an untracked full reconcile clears a stale diagram edit before undo can corrupt it', () => {
    const before = 'graph LR\n  Shopper --> Storefront\n';
    const afterDiagramEdit = 'graph LR\n  Buyer --> Storefront\n';
    const afterReconcile = 'graph LR\n  Buyer --> Warehouse\n';
    const { doc, ytext } = makeYText(before);
    const provider = {
      document: doc,
      on() {},
      off() {},
    } as unknown as HocuspocusProvider;
    const undoManager = acquireMermaidUndoManager(provider, ytext);

    replaceYText(ytext, afterDiagramEdit, MERMAID_DIAGRAM_EDIT_ORIGIN);
    expect(undoManager.canUndo()).toBe(true);

    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, afterReconcile);
    }, Symbol('mermaid-source-reconcile'));

    expect(ytext.toString()).toBe(afterReconcile);
    expect(undoManager.undoStack).toHaveLength(0);
    undoManager.undo();
    expect(ytext.toString()).toBe(afterReconcile);
  });

  test('a remote full reconcile clears history even though transport replaces the server origin', () => {
    const before = 'graph LR\n  Shopper --> Storefront\n';
    const afterDiagramEdit = 'graph LR\n  Buyer --> Storefront\n';
    const afterReconcile = 'graph LR\n  Buyer --> Warehouse\n';
    const serverDoc = new Y.Doc();
    const serverText = serverDoc.getText('source');
    serverText.insert(0, before);
    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc));
    const clientText = clientDoc.getText('source');
    const provider = {
      document: clientDoc,
      on() {},
      off() {},
    } as unknown as HocuspocusProvider;
    const undoManager = acquireMermaidUndoManager(provider, clientText);

    replaceYText(clientText, afterDiagramEdit, MERMAID_DIAGRAM_EDIT_ORIGIN);
    Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(clientDoc));
    let reconcileUpdate: Uint8Array | undefined;
    serverDoc.on('update', (update, origin) => {
      if (origin === 'server-reconcile') reconcileUpdate = update;
    });
    serverDoc.transact(() => {
      serverText.delete(0, serverText.length);
      serverText.insert(0, afterReconcile);
    }, 'server-reconcile');
    expect(reconcileUpdate).toBeDefined();
    if (!reconcileUpdate) throw new Error('Expected the server reconcile update');
    Y.applyUpdate(clientDoc, reconcileUpdate, provider);

    expect(clientText.toString()).toBe(afterReconcile);
    expect(undoManager.canUndo()).toBe(false);
    undoManager.undo();
    expect(clientText.toString()).toBe(afterReconcile);
  });

  test('an untracked partial peer edit preserves diagram undo history', () => {
    const { doc, ytext } = makeYText('graph LR\n  Shopper --> Storefront\n');
    const provider = {
      document: doc,
      on() {},
      off() {},
    } as unknown as HocuspocusProvider;
    const undoManager = acquireMermaidUndoManager(provider, ytext);
    replaceYText(ytext, 'graph LR\n  Buyer --> Storefront\n', MERMAID_DIAGRAM_EDIT_ORIGIN);

    doc.transact(() => ytext.insert(ytext.length, '  Storefront --> Cart\n'), Symbol('peer'));

    expect(undoManager.canUndo()).toBe(true);
  });

  test('repeated acquisition installs one full-reconcile observer', () => {
    const listeners = new Set<() => void>();
    const { doc, ytext } = makeYText('graph LR\n  Shopper --> Storefront\n');
    const provider = {
      document: doc,
      on(name: string, listener: () => void) {
        if (name === 'destroy') listeners.add(listener);
      },
      off(name: string, listener: () => void) {
        if (name === 'destroy') listeners.delete(listener);
      },
    } as unknown as HocuspocusProvider;
    const observe = vi.spyOn(ytext, 'observe');

    const first = acquireMermaidUndoManager(provider, ytext);
    const destroyListenerCount = listeners.size;
    expect(observe).toHaveBeenCalledTimes(1);

    const second = acquireMermaidUndoManager(provider, ytext);

    expect(second).toBe(first);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(destroyListenerCount);

    for (const listener of listeners) listener();
    expect(listeners.size).toBe(0);
  });

  test('provider teardown detaches the full-reconcile observer', () => {
    const listeners = new Set<() => void>();
    const { doc, ytext } = makeYText('graph LR\n  Shopper --> Storefront\n');
    const provider = {
      document: doc,
      on(name: string, listener: () => void) {
        if (name === 'destroy') listeners.add(listener);
      },
      off(name: string, listener: () => void) {
        if (name === 'destroy') listeners.delete(listener);
      },
    } as unknown as HocuspocusProvider;
    const undoManager = acquireMermaidUndoManager(provider, ytext);
    const clear = vi.spyOn(undoManager, 'clear');

    for (const listener of listeners) listener();
    clear.mockClear();
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, 'graph LR\n  Buyer --> Warehouse\n');
    }, Symbol('late-reconcile'));

    expect(clear).not.toHaveBeenCalled();
  });
});
