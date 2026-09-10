// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, Extension } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { TextSelection } from '@tiptap/pm/state';
import { relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { readUndoManager } from '../editor-rig.test-helper';
import { BlockMover } from './block-mover';
import { createListItemDragController } from './list-item-drag';

const commonJs: Pick<typeof import('@tiptap/y-tiptap'), 'relativePositionToAbsolutePosition'> =
  createRequire(import.meta.url)('@tiptap/y-tiptap');

const markdown = new MarkdownManager({ extensions: sharedExtensions });
const disposers: (() => void)[] = [];

function setup(input: string) {
  const docs = [new Y.Doc(), new Y.Doc()];
  const controller = createListItemDragController();
  const editors = docs.map((doc, index) => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return new Editor({
      element,
      extensions: [
        ...sharedExtensions,
        BlockMover,
        Collaboration.configure({ document: doc }),
        ...(index === 0
          ? [
              Extension.create({
                name: 'testListDrag',
                addProseMirrorPlugins: () => [controller.plugin],
              }),
            ]
          : []),
      ],
      editorProps: { handleScrollToSelection: () => true },
    });
  });
  const [local, peer] = editors;
  local.on('destroy', controller.destroy);
  local.commands.setContent(markdown.parse(input));
  Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]));
  docs.forEach((doc, index) => {
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'test-peer') Y.applyUpdate(docs[1 - index], update, 'test-peer');
    });
  });
  const undoManager = readUndoManager(local);
  if (!undoManager) throw new Error('Collaboration must provide the production undo manager');
  undoManager.clear();
  undoManager.captureTimeout = 60_000;
  disposers.push(() => {
    for (const editor of editors) editor.destroy();
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
  };
  return { local, peer, position, start, drop, undoManager, expectConverged, controller };
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('list dragging with the production collaboration binding', () => {
  test.each([
    ['ESM', relativePositionToAbsolutePosition],
    ['CommonJS', commonJs.relativePositionToAbsolutePosition],
  ] as const)(
    '%s returns null for missing sibling mappings at either traversal depth',
    (_name, resolve) => {
      const { local } = setup('- A\n- B\n- C\n');
      const sync = ySyncPluginKey.getState(local.state);
      const list = sync.type.get(0);
      if (!(list instanceof Y.XmlElement)) throw new Error('Expected a shared list');
      const first = list.get(0);
      const last = list.get(2);
      if (!(first instanceof Y.XmlElement) || !(last instanceof Y.XmlElement))
        throw new Error('Expected shared list items');
      const mapping = new Map(sync.binding.mapping);
      mapping.delete(first);
      for (const anchor of [
        Y.createRelativePositionFromTypeIndex(list, 2),
        Y.createRelativePositionFromTypeIndex(last, 0),
      ]) {
        expect(resolve(sync.doc, sync.type, anchor, mapping)).toBeNull();
      }
    },
  );

  test('cancels the drag without losing a peer edit when its binding mapping is incomplete', () => {
    const { local, peer, position, start, expectConverged } = setup('- A\n- B\n- C\n');
    start('C');
    const sync = ySyncPluginKey.getState(local.state);
    const list = sync.type.get(0);
    if (!(list instanceof Y.XmlElement)) throw new Error('Expected a shared list');
    const item = list.get(0);
    if (!(item instanceof Y.XmlElement)) throw new Error('Expected a shared list item');
    const mapped = sync.binding.mapping.get(item);
    if (!mapped) throw new Error('Expected an existing node mapping');
    const dispatch = local.view.dispatch.bind(local.view);
    vi.spyOn(local.view, 'dispatch').mockImplementation((tr) => {
      if (!tr.docChanged || !tr.getMeta(ySyncPluginKey)) return dispatch(tr);
      sync.binding.mapping.delete(item);
      try {
        dispatch(tr);
      } finally {
        sync.binding.mapping.set(item, mapped);
      }
    });
    expect(local.view.dragging).not.toBeNull();
    expect(document.querySelector('[inert][aria-hidden="true"]')).not.toBeNull();
    peer.view.dispatch(peer.state.tr.insertText(' edited', position(peer, 'B') + 3));
    expectConverged('- A\n- B edited\n- C\n');
    expect(local.view.dragging).toBeNull();
    expect(document.querySelector('[inert][aria-hidden="true"]')).toBeNull();
  });

  test('cancels a mixed selection when an affected-list anchor no longer resolves', () => {
    const { local, peer, position, start, drop, expectConverged, controller } = setup(
      '1. A\n2. B\n3. C\n\nSelected\n\nDestination\n',
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
    const active = controller.plugin.getState(local.state);
    if (active?.status !== 'active' || !active.relative) throw new Error('Expected active anchors');
    expect(active.range.listPos).toBeNull();
    expect(active.relative.lists).toHaveLength(1);
    const sync = ySyncPluginKey.getState(local.state);
    const detached = sync.doc.getXmlFragment('invalidated-drag-anchor');
    const element = new Y.XmlElement('list');
    detached.push([element]);
    const invalidated = Y.createRelativePositionFromTypeIndex(element, 0);
    detached.delete(0, 1);
    active.relative.lists[0] = invalidated;
    expect(local.view.dragging).not.toBeNull();
    peer.view.dispatch(peer.state.tr.insertText(' edited', position(peer, 'B') + 3));
    expect(local.view.dragging).toBeNull();
    expect(document.querySelector('[inert][aria-hidden="true"]')).toBeNull();
    drop('Destination', 'paragraph');
    expectConverged('1. A\n2. B edited\n3. C\n\nSelected\n\nDestination\n');
  });

  test('composes local and remote edits while retaining the dragged range', () => {
    const { local, peer, position, start, drop, expectConverged } = setup('- A\n- B\n- C\n');
    start('C');
    local.view.dispatch(local.state.tr.insertText(' local', position(local, 'A') + 3));
    peer.view.dispatch(peer.state.tr.insertText(' remote', position(peer, 'B') + 3));
    drop('B remote');
    expectConverged('- A local\n- C\n- B remote\n');
  });

  test.each([false, true])(
    'normalizes the source after a peer prepend and a mixed=%s move',
    (mixed) => {
      const { local, peer, position, start, drop, expectConverged } = setup(
        '1. A\n2. B\n3. C\n\nSelected\n\nGap\n\nDestination\n',
      );
      if (mixed) {
        local.view.dispatch(
          local.state.tr.setSelection(
            TextSelection.create(
              local.state.doc,
              position(local, 'C') + 2,
              position(local, 'Selected', 'paragraph') + 5,
            ),
          ),
        );
      }
      start('C');
      peer.view.dispatch(
        peer.state.tr.insert(
          1,
          peer.schema.nodes.listItem.create(
            { sourceOrdinal: 7 },
            peer.schema.nodes.paragraph.create(null, peer.schema.text('Prepended')),
          ),
        ),
      );
      drop('Destination', 'paragraph');
      expectConverged(
        mixed
          ? '1. Prepended\n2. A\n3. B\n\nGap\n\n1. C\n\nSelected\n\nDestination\n'
          : '1. Prepended\n2. A\n3. B\n\nSelected\n\nGap\n\n1. C\n\nDestination\n',
      );
      local.state.doc.check();
    },
  );

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
    local.commands.undo();
    expectConverged('- A\n- C\n- B\n\nAfter before\n');
    local.commands.undo();
    expectConverged('- A\n- B\n- C\n\nAfter before\n');
    local.commands.undo();
    expectConverged('- A\n- B\n- C\n\nAfter\n');
  });

  test('keeps its source when a peer inserts before the list during a drag', () => {
    const { local, peer, start, drop, expectConverged } = setup('1. A\n2. B\n3. C\n');
    start('C');
    peer.view.dispatch(
      peer.state.tr.insert(0, peer.schema.nodes.paragraph.create(null, peer.schema.text('Before'))),
    );
    expect(local.state.doc.firstChild?.textContent).toBe('Before');
    drop('B');
    expectConverged('Before\n\n1. A\n2. C\n3. B\n');
  });

  test('moves the latest content when a peer edits the dragged item', () => {
    const { peer, position, start, drop, expectConverged } = setup('- A\n- B\n- C\n');
    start('C');
    peer.view.dispatch(peer.state.tr.insertText(' updated', position(peer, 'C') + 3));
    drop('B');
    expectConverged('- A\n- C updated\n- B\n');
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
    local.commands.undo();
    expectConverged('- A\n- C\n- B\n\nAfter before\n');
    local.commands.undo();
    expectConverged('- A\n- B\n- C\n\nAfter before\n');
    local.commands.undo();
    expectConverged('- A\n- B\n- C\n\nAfter\n');
  });

  test('undoing the move preserves a peer edit made during the drag', () => {
    const { local, peer, position, start, drop, expectConverged } = setup('- A\n- B\n- C\n');
    start('C');
    peer.view.dispatch(peer.state.tr.insertText(' updated', position(peer, 'A') + 3));
    drop('B');
    expectConverged('- A updated\n- C\n- B\n');
    local.commands.undo();
    expectConverged('- A updated\n- B\n- C\n');
  });
});
