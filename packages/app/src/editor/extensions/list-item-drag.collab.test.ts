// @vitest-environment jsdom
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { type Editor, Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { mountProjectionEditorOn } from '../editor-rig.test-helper';
import { BlockMover } from './block-mover';
import { createListItemDragController } from './list-item-drag';

const markdown = new MarkdownManager({ extensions: sharedExtensions });
const disposers: (() => void)[] = [];

function setup(input: string) {
  const docs = [new Y.Doc(), new Y.Doc()];
  docs[0].transact(() => docs[0].getText('source').insert(0, input), 'seed');
  Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]));
  docs.forEach((doc, index) => {
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'test-peer') Y.applyUpdate(docs[1 - index], update, 'test-peer');
    });
  });
  const controller = createListItemDragController();
  const rigs = docs.map((doc, index) =>
    mountProjectionEditorOn(doc.getText('source'), [
      BlockMover,
      ...(index === 0
        ? [
            Extension.create({
              name: 'testListDrag',
              addProseMirrorPlugins: () => [controller.plugin],
            }),
          ]
        : []),
    ]),
  );
  const [local, peer] = rigs.map((rig) => rig.editor);
  for (const editor of [local, peer]) {
    editor.setOptions({ editorProps: { handleScrollToSelection: () => true } });
  }
  local.on('destroy', controller.destroy);
  const undoManager = rigs[0].undoManager;
  undoManager.clear();
  undoManager.captureTimeout = 60_000;
  disposers.push(() => {
    for (const rig of rigs) rig.destroy();
    for (const doc of docs) doc.destroy();
  });
  const position = (editor: Editor, text: string, type = 'listItem') => {
    let result = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === type && node.textContent === text) result = pos;
    });
    if (result < 0) throw new Error(`Missing ${type}: ${text}`);
    return result;
  };
  const transfer = {
    types: ['text/html', 'text/plain'],
    clearData: vi.fn(),
    setData: vi.fn(),
    setDragImage: vi.fn(),
    getData: () => '',
    files: [],
  };
  const start = (text: string) => {
    const pos = position(local, text);
    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    expect(controller.start(event as DragEvent, local.view, local.state.doc.nodeAt(pos), pos)).toBe(
      true,
    );
  };
  const drop = (text: string, type = 'listItem') => {
    vi.spyOn(local.view, 'posAtCoords').mockReturnValue({
      pos: position(local, text, type),
      inside: -1,
    });
    const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    local.view.dom.dispatchEvent(event);
  };
  const expectConverged = (expected: string) => {
    expect(markdown.serialize(local.getJSON())).toBe(expected);
    expect(peer.getJSON()).toEqual(local.getJSON());
    expect(docs[1].getText('source').toString()).toBe(docs[0].getText('source').toString());
  };
  return { local, peer, position, start, drop, undoManager, expectConverged, controller };
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('list dragging with the production collaboration binding', () => {
  test('cancels the drag when a peer edits the dragged list, keeping both edits', () => {
    const { local, peer, position, start, drop, expectConverged } = setup('- A\n- B\n- C\n');
    start('C');
    local.view.dispatch(local.state.tr.insertText(' local', position(local, 'A') + 3));
    peer.view.dispatch(peer.state.tr.insertText(' remote', position(peer, 'B') + 3));
    drop('B remote');
    expectConverged('- A local\n- B remote\n- C\n');
    expect(local.view.dragging).toBeNull();
  });

  test('cancels a drag of a mixed selection when a peer edits the dragged list', () => {
    const { local, peer, position, start, drop, expectConverged } = setup(
      '1. A\n2. B\n3. C\n\nSelected\n\nGap\n\nDestination\n',
    );
    local.view.dispatch(
      local.state.tr.setSelection(
        TextSelection.create(
          local.state.doc,
          position(local, 'C') + 2,
          position(local, 'Selected', 'paragraph') + 5,
        ),
      ),
    );
    start('C');
    peer.view.dispatch(peer.state.tr.insertText(' edited', position(peer, 'A') + 3));
    drop('Destination', 'paragraph');
    expectConverged('1. A edited\n2. B\n3. C\n\nSelected\n\nGap\n\nDestination\n');
    expect(local.view.dragging).toBeNull();
  });

  test('isolates keyboard movement from adjacent typing in collaboration', () => {
    const { local, position, undoManager, expectConverged } = setup('- A\n- B\n- C\n\nAfter\n');
    local.view.dispatch(
      local.state.tr.insertText(' before', position(local, 'After', 'paragraph') + 6),
    );
    local.commands.setTextSelection(position(local, 'C') + 2);
    const key = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      code: 'ArrowUp',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    local.view.dom.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    local.view.dispatch(
      local.state.tr.insertText(' after', position(local, 'After before', 'paragraph') + 13),
    );
    expect(undoManager.undoStack).toHaveLength(3);
    undoManager.undo();
    expectConverged('- A\n- C\n- B\n\nAfter before\n');
    undoManager.undo();
    expectConverged('- A\n- B\n- C\n\nAfter before\n');
    undoManager.undo();
    expectConverged('- A\n- B\n- C\n\nAfter\n');
  });

  test('cancels the drag when a peer inserts before the list', () => {
    const { local, peer, start, drop, expectConverged } = setup('1. A\n2. B\n3. C\n');
    start('C');
    peer.view.dispatch(
      peer.state.tr.insert(0, peer.schema.nodes.paragraph.create(null, peer.schema.text('Before'))),
    );
    expect(local.state.doc.firstChild?.textContent).toBe('Before');
    drop('B');
    expectConverged('Before\n\n1. A\n2. B\n3. C\n');
    expect(local.view.dragging).toBeNull();
  });

  test('does not resurrect an item deleted by a peer during a drag', () => {
    const { local, peer, position, start, drop, expectConverged } = setup('- A\n- B\n- C\n');
    start('C');
    const pos = position(peer, 'C');
    const node = peer.state.doc.nodeAt(pos);
    if (!node) throw new Error('Source must exist before remote deletion');
    peer.view.dispatch(peer.state.tr.delete(pos, pos + node.nodeSize));
    drop('B');
    expectConverged('- A\n- B\n');
    expect(local.view.dragging).toBeNull();
  });

  test('keeps a selected group across a peer edit outside the selection', () => {
    const { local, peer, position, start, drop, expectConverged } = setup(
      '- A\n- B\n- C\n- D\n\nAfter\n',
    );
    local.view.dispatch(
      local.state.tr.setSelection(
        TextSelection.create(local.state.doc, position(local, 'B') + 2, position(local, 'C') + 3),
      ),
    );
    start('B');
    peer.view.dispatch(
      peer.state.tr.insertText(' updated', position(peer, 'After', 'paragraph') + 6),
    );
    drop('A');
    expectConverged('- B\n- C\n- A\n- D\n\nAfter updated\n');
  });

  test('isolates the move from typing immediately before and after it', () => {
    const { local, position, start, drop, undoManager, expectConverged } = setup(
      '- A\n- B\n- C\n\nAfter\n',
    );
    local.view.dispatch(
      local.state.tr.insertText(' before', position(local, 'After', 'paragraph') + 6),
    );
    start('C');
    drop('B');
    local.view.dispatch(
      local.state.tr.insertText(' after', position(local, 'After before', 'paragraph') + 13),
    );
    expect(undoManager.undoStack).toHaveLength(3);
    undoManager.undo();
    expectConverged('- A\n- C\n- B\n\nAfter before\n');
    undoManager.undo();
    expectConverged('- A\n- B\n- C\n\nAfter before\n');
    undoManager.undo();
    expectConverged('- A\n- B\n- C\n\nAfter\n');
  });

  test('a drag started after a canceled one moves, and undoing it keeps the peer edit', () => {
    const { peer, position, start, drop, undoManager, expectConverged } = setup('- A\n- B\n- C\n');
    start('C');
    peer.view.dispatch(peer.state.tr.insertText(' updated', position(peer, 'A') + 3));
    drop('B');
    expectConverged('- A updated\n- B\n- C\n');
    expect(undoManager.undoStack).toHaveLength(0);
    start('C');
    drop('B');
    expectConverged('- A updated\n- C\n- B\n');
    undoManager.undo();
    expectConverged('- A updated\n- B\n- C\n');
  });
});
