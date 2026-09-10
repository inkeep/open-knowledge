import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { act, cleanup, render } from '@testing-library/react';
import { type Content, Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { afterEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { BlockMover, blockMoveAnnouncementKey } from '../../editor/extensions/block-mover';
import { BridgeIdPlugin } from '../../editor/extensions/bridge-id-plugin';
import {
  SELECTION_ORIGIN_META_KEY,
  SelectionStatePlugin,
} from '../../editor/extensions/selection-state-plugin';
import { SelectionAnnouncer } from './SelectionAnnouncer';

const markdown = new MarkdownManager({ extensions: sharedExtensions });
const disposers: (() => void)[] = [];

function setup(content: Content = markdown.parse('- A\n- B\n- C\n- D\n'), withBridgeIds = true) {
  vi.useFakeTimers();
  const doc = new Y.Doc();
  const editor = new Editor({
    extensions: [
      ...sharedExtensions,
      BlockMover,
      ...(withBridgeIds ? [BridgeIdPlugin] : []),
      SelectionStatePlugin,
      ...(withBridgeIds ? [Collaboration.configure({ document: doc })] : []),
    ],
    editorProps: { handleScrollToSelection: () => true },
  });
  editor.commands.setContent(content);
  const result = render(<SelectionAnnouncer editor={editor} />);
  disposers.push(() => {
    editor.destroy();
    doc.destroy();
  });
  const cursor = (text: string) => {
    let position = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === text) position = pos + 1;
    });
    act(() => {
      editor.commands.setTextSelection(position);
    });
  };
  const move = (direction: 'Up' | 'Down') => {
    const event = new KeyboardEvent('keydown', {
      key: `Arrow${direction}`,
      code: `Arrow${direction}`,
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      editor.view.dom.dispatchEvent(event);
    });
    return event;
  };
  const settle = () =>
    act(() => {
      vi.advanceTimersByTime(200);
    });
  return {
    editor,
    doc,
    cursor,
    move,
    settle,
    status: result.getByRole('status'),
    unmount: result.unmount,
  };
}

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

test('announces consecutive successful moves and survives a selection-only transaction', () => {
  const { editor, cursor, move, settle, status } = setup();
  cursor('C');
  settle();
  expect(status.textContent).toBe('');
  expect(move('Up').defaultPrevented).toBe(true);
  act(() => {
    editor.view.dispatch(editor.state.tr.setSelection(editor.state.selection));
  });
  settle();
  expect(status.textContent).toBe('Moved up.');
  expect(move('Up').defaultPrevented).toBe(true);
  expect(status.textContent).toBe('');
  settle();
  expect(status.textContent).toBe('Moved up.');
  expect(markdown.serialize(editor.getJSON())).toBe('- C\n- A\n- B\n- D\n');
  move('Down');
  settle();
  expect(status.textContent).toBe('Moved down.');
});

test('does not announce a blocked move', () => {
  const { cursor, move, settle, status } = setup();
  cursor('A');
  settle();
  expect(move('Up').defaultPrevented).toBe(false);
  settle();
  expect(status.textContent).toBe('');
});

test('cancels a pending announcement on unmount', () => {
  const { cursor, move, settle, status, unmount } = setup();
  cursor('C');
  move('Up');
  unmount();
  settle();
  expect(status.textContent).toBe('');
});

const jsxContent: Content = {
  type: 'doc',
  content: [
    {
      type: 'jsxComponent',
      attrs: { componentName: 'Callout' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inside' }] }],
    },
    {
      type: 'jsxComponent',
      attrs: { componentName: 'CustomBox' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Other' }] }],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'Outside' }] },
  ],
};

test('keeps a pending JSX selection announcement through unrelated transaction bursts', () => {
  const { editor, cursor, status } = setup(jsxContent);
  cursor('Inside');
  act(() => {
    vi.advanceTimersByTime(100);
  });
  act(() => {
    editor.view.dispatch(editor.state.tr.setMeta('selectionStatePlugin/refresh', true));
    editor.view.dispatch(editor.state.tr.insertText('!', editor.state.selection.from));
  });
  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(status.textContent).toBe('Selected: Callout');
});

test('does not rewrite unchanged JSX selection messages and announces meaningful selection changes', () => {
  const { editor, cursor, status, settle } = setup(jsxContent);
  cursor('Inside');
  settle();
  expect(status.textContent).toBe('Selected: Callout');
  const observer = new MutationObserver(() => {});
  observer.observe(status, { childList: true, characterData: true, subtree: true });
  act(() => {
    editor.view.dispatch(editor.state.tr);
    editor.view.dispatch(editor.state.tr.insertText('!', editor.state.selection.from));
  });
  settle();
  expect(observer.takeRecords()).toHaveLength(0);
  observer.disconnect();
  cursor('Other');
  settle();
  expect(status.textContent).toBe('Selected: CustomBox (unregistered)');
  cursor('Outside');
  settle();
  expect(status.textContent).toBe('Outside any block');
});

test.each(['sideways', 1, true, { direction: 'up' }])(
  'ignores unsupported move metadata %j',
  (meta) => {
    const { editor, cursor, settle, status } = setup();
    cursor('A');
    settle();
    act(() => {
      editor.view.dispatch(
        editor.state.tr
          .insertText('!', editor.state.selection.from)
          .setMeta(blockMoveAnnouncementKey, meta),
      );
    });
    settle();
    expect(status.textContent).toBe('');
  },
);

const adjacentCallouts: Content = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Leading' }] },
    {
      type: 'jsxComponent',
      attrs: { componentName: 'Callout' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }],
    },
    {
      type: 'jsxComponent',
      attrs: { componentName: 'Callout' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }],
    },
  ],
};

test.each([true, false])(
  'keeps unchanged component context quiet across preceding edits with bridge IDs %s',
  (withBridgeIds) => {
    const { editor, cursor, settle, status } = setup(adjacentCallouts, withBridgeIds);
    cursor('First');
    settle();
    expect(status.textContent).toBe('Selected: Callout');
    const observer = new MutationObserver(() => {});
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('Extra ', 1));
    });
    settle();
    expect(observer.takeRecords()).toHaveLength(0);
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('More ', 1));
    });
    settle();
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    cursor('Second');
    expect(status.textContent).toBe('');
    settle();
    expect(status.textContent).toBe('Selected: Callout');
  },
);

test('does not repeat a component announcement for modality or drag state changes', async () => {
  const { editor, cursor, settle, status } = setup(adjacentCallouts);
  cursor('First');
  settle();
  const observer = new MutationObserver(() => {});
  observer.observe(status, { childList: true, characterData: true, subtree: true });
  act(() => {
    editor.view.dispatch(editor.state.tr.setMeta(SELECTION_ORIGIN_META_KEY, 'pointer'));
  });
  settle();
  expect(observer.takeRecords()).toHaveLength(0);
  act(() => {
    editor.view.dispatch(editor.state.tr.setMeta(SELECTION_ORIGIN_META_KEY, 'keyboard'));
  });
  settle();
  expect(observer.takeRecords()).toHaveLength(0);
  const host = editor.view.dom.parentElement ?? editor.view.dom;
  await act(async () => {
    host.dispatchEvent(new Event('dragstart'));
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
  });
  settle();
  expect(observer.takeRecords()).toHaveLength(0);
  await act(async () => {
    host.dispatchEvent(new Event('dragend'));
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
  });
  settle();
  expect(observer.takeRecords()).toHaveLength(0);
  observer.disconnect();
});

test('does not replace a move confirmation with unchanged selection context', () => {
  const { editor, cursor, move, settle, status } = setup(adjacentCallouts);
  cursor('Second');
  settle();
  move('Up');
  settle();
  expect(status.textContent).toBe('Moved up.');
  const observer = new MutationObserver(() => {});
  observer.observe(status, { childList: true, characterData: true, subtree: true });
  act(() => {
    editor.view.dispatch(editor.state.tr.setMeta(SELECTION_ORIGIN_META_KEY, 'pointer'));
  });
  settle();
  expect(observer.takeRecords()).toHaveLength(0);
  expect(status.textContent).toBe('Moved up.');
  observer.disconnect();
});

test('defers a selection that changed inside the pending move window until the next transaction', () => {
  const { editor, cursor, move, settle, status } = setup(jsxContent);
  cursor('Other');
  settle();
  expect(status.textContent).toBe('Selected: CustomBox (unregistered)');
  expect(move('Up').defaultPrevented).toBe(true);
  cursor('Inside');
  settle();
  expect(status.textContent).toBe('Moved up.');
  act(() => {
    editor.view.dispatch(editor.state.tr);
  });
  settle();
  expect(status.textContent).toBe('Selected: Callout');
});

test.each([true, false])(
  'announces a replaced component at the same position with bridge IDs %s',
  (withBridgeIds) => {
    const { editor, cursor, settle, status } = setup(adjacentCallouts, withBridgeIds);
    cursor('First');
    settle();
    const pos = editor.state.selection.$from.before(1);
    const node = editor.state.doc.nodeAt(pos);
    if (!node) throw new Error('Expected selected component');
    act(() => {
      editor.view.dispatch(
        editor.state.tr.replaceWith(
          pos,
          pos + node.nodeSize,
          editor.schema.nodes.jsxComponent.create(
            { componentName: 'Callout' },
            editor.schema.nodes.paragraph.create(null, editor.schema.text('Replacement')),
          ),
        ),
      );
      editor.commands.setTextSelection(pos + 2);
    });
    expect(status.textContent).toBe('');
    settle();
    expect(status.textContent).toBe('Selected: Callout');
  },
);

test('announces a changed nested position even when the selected component identity stays the same', () => {
  const { editor, cursor, settle, status } = setup({
    type: 'doc',
    content: [
      {
        type: 'jsxComponent',
        attrs: { componentName: 'Callout' },
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
          {
            type: 'jsxComponent',
            attrs: { componentName: 'Callout' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested' }] }],
          },
        ],
      },
    ],
  });
  cursor('Nested');
  settle();
  expect(status.textContent).toBe('Selected: Callout, 2 of 2 in Callout');
  act(() => {
    editor.view.dispatch(
      editor.state.tr.insert(
        1,
        editor.schema.nodes.paragraph.create(null, editor.schema.text('Added')),
      ),
    );
  });
  settle();
  expect(status.textContent).toBe('Selected: Callout, 3 of 3 in Callout');
});

test.each(['preceding', 'selected'] as const)(
  'keeps the selected component quiet when a peer edits its %s paragraph',
  (target) => {
    const { doc, cursor, settle, status } = setup(adjacentCallouts);
    cursor('First');
    settle();
    const peer = new Y.Doc();
    disposers.push(() => peer.destroy());
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const block = peer.getXmlFragment('default').get(target === 'preceding' ? 0 : 1);
    if (!(block instanceof Y.XmlElement)) throw new Error('Expected a block');
    const paragraph = target === 'preceding' ? block : block.get(0);
    if (!(paragraph instanceof Y.XmlElement)) throw new Error('Expected a paragraph');
    const text = paragraph.get(0);
    if (!(text instanceof Y.XmlText)) throw new Error('Expected leading text');
    text.insert(0, 'Remote ');
    const observer = new MutationObserver(() => {});
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    act(() => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    });
    settle();
    expect(observer.takeRecords()).toHaveLength(0);
    expect(status.textContent).toBe('Selected: Callout');
    observer.disconnect();
  },
);
