// @vitest-environment jsdom
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor } from '@tiptap/core';
import type { DragHandlePlugin } from '@tiptap/extension-drag-handle';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { BubbleMenu } from '@tiptap/react/menus';
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { EDITOR_BUBBLE_MENU_KEY } from '../bubble-menu/bubble-menu-key';
import { shouldShowBubbleMenu } from '../bubble-menu/bubble-menu-state';
import { BlockDragHandle } from './drag-handle.ts';

let handleOptions: Parameters<typeof DragHandlePlugin>[0] | null = null;

vi.mock('@tiptap/extension-drag-handle', () => ({
  DragHandlePlugin: (options: Parameters<typeof DragHandlePlugin>[0]) => {
    handleOptions = options;
    return { plugin: new Plugin({}) };
  },
  normalizeNestedOptions: () => ({}),
}));

const markdown = new MarkdownManager({ extensions: sharedExtensions });
const editors: Editor[] = [];
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each([
  'dragend',
  'no-op',
  'invalid',
  'success',
  'failed-start',
  'destroy',
  'reconfigure',
  'reconfigure-success',
  'restart',
  'collapsed-caret',
])('keeps bubble visibility consistent after %s without changing the selection', async (ending) => {
  const successfulDrop = ending === 'success' || ending === 'reconfigure-success';
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    content: markdown.parse('- Alpha\n- Beta\n- Gamma\n- Delta\n'),
    extensions: [...sharedExtensions, BlockDragHandle],
    editorProps: { handleScrollToSelection: () => true },
  });
  editors.push(editor);
  const options = handleOptions;
  if (!options) throw new Error('Drag controls must mount');
  document.body.appendChild(options.element);
  let from = 0;
  let to = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'listItem' && node.textContent === 'Beta') from = pos;
    if (node.type.name === 'listItem' && node.textContent === 'Gamma') to = pos + 4;
  });
  editor.commands.setTextSelection(
    ending === 'collapsed-caret' ? from + 2 : { from: from + 2, to },
  );
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const menuRef = createRef<HTMLDivElement>();
  await act(async () =>
    root.render(
      createElement(
        BubbleMenu,
        {
          editor,
          ref: menuRef,
          pluginKey: EDITOR_BUBBLE_MENU_KEY,
          shouldShow: shouldShowBubbleMenu,
          updateDelay: 250,
          appendTo: document.body,
          getReferencedVirtualElement: () => ({
            getBoundingClientRect: () => new DOMRect(20, 20, 100, 20),
          }),
        },
        'Formatting',
      ),
    ),
  );
  const menu = menuRef.current;
  if (!menu) throw new Error('Bubble menu must mount');
  expect(menu.isConnected).toBe(ending !== 'collapsed-caret');
  editor.commands.setTextSelection(
    ending === 'collapsed-caret' ? from + 3 : { from: from + 3, to },
  );
  const transfer = {
    clearData: vi.fn(),
    setData: vi.fn(),
    setDragImage: vi.fn(),
  };
  const start = () => {
    options.onNodeChange?.({ editor, node: editor.state.doc.nodeAt(from), pos: from });
    const event = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    options.element.dispatchEvent(event);
  };
  if (ending === 'failed-start') {
    const failure = new Error('drag image failed');
    const report = vi.fn((event: ErrorEvent) => event.preventDefault());
    let menuVisibleAtFallback = true;
    const fallback = vi.fn(() => {
      menuVisibleAtFallback = menu.isConnected;
      editor.view.dragging = { slice: editor.state.doc.slice(from, to), move: true };
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, from)),
      );
    });
    transfer.setDragImage.mockImplementationOnce(() => {
      throw failure;
    });
    window.addEventListener('error', report);
    options.element.addEventListener('dragstart', fallback);
    try {
      start();
      expect(report).toHaveBeenCalledOnce();
      expect(report.mock.calls[0][0].error).toBe(failure);
      expect(menuVisibleAtFallback).toBe(false);
      expect(fallback).toHaveBeenCalledOnce();
      expect(editor.view.dragging).not.toBeNull();
      expect(menu.isConnected).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(menu.isConnected).toBe(false);
      document.dispatchEvent(new Event('dragend'));
      expect(editor.view.dragging).toBeNull();
      expect(menu.isConnected).toBe(true);
    } finally {
      window.removeEventListener('error', report);
      options.element.removeEventListener('dragstart', fallback);
    }
    return;
  }
  start();
  if (ending === 'restart') start();
  expect(editor.view.dragging).not.toBeNull();
  const originalSelection = editor.state.selection.toJSON();
  const originalDoc = editor.state.doc;
  expect(menu.isConnected).toBe(false);
  await vi.advanceTimersByTimeAsync(300);
  expect(menu.isConnected).toBe(false);
  if (ending === 'destroy') {
    editor.destroy();
    document.dispatchEvent(new Event('dragend'));
    await vi.advanceTimersByTimeAsync(300);
    expect(menu.isConnected).toBe(false);
    return;
  }
  if (ending === 'reconfigure' || ending === 'reconfigure-success') {
    const key = new PluginKey('runtimeDecoration');
    editor.registerPlugin(new Plugin({ key }));
    editor.unregisterPlugin(key);
    expect(menu.isConnected).toBe(false);
    expect(editor.view.dragging).not.toBeNull();
  }
  if (['dragend', 'reconfigure', 'restart', 'collapsed-caret'].includes(ending)) {
    document.dispatchEvent(new Event('dragend'));
  } else {
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(
      ending === 'invalid' ? null : { pos: successfulDrop ? 1 : from, inside: -1 },
    );
    const drop = new MouseEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    editor.view.dom.dispatchEvent(drop);
  }
  expect(editor.view.dragging).toBeNull();
  expect(menu.isConnected).toBe(!successfulDrop);
  await vi.advanceTimersByTimeAsync(300);
  expect(menu.isConnected).toBe(!successfulDrop);
  if (successfulDrop) {
    expect(editor.state.selection.empty).toBe(true);
    expect(markdown.serialize(editor.getJSON())).toBe('- Beta\n- Gamma\n- Alpha\n- Delta\n');
  } else {
    expect(editor.state.selection.toJSON()).toEqual(originalSelection);
    expect(editor.state.doc.eq(originalDoc)).toBe(true);
  }
});
