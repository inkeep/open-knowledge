'use client';

import { offset } from '@floating-ui/dom';
import { type Editor, Extension } from '@tiptap/core';
import { DragHandlePlugin, normalizeNestedOptions } from '@tiptap/extension-drag-handle';
import type { Node as PmNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';

const HANDLE_HEIGHT = 24;
const MAX_SINGLE_LINE_HEIGHT = 44;
const BODY_LINE_HEIGHT = 26;

const PLUS_SVG = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;
const GRIP_SVG = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;

function buildControls() {
  const container = document.createElement('div');
  container.className = 'ok-block-controls';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ok-block-btn';
  addBtn.setAttribute('aria-label', 'Add block below');
  addBtn.innerHTML = PLUS_SVG;
  addBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'ok-block-btn ok-block-grip';
  grip.setAttribute('aria-label', 'Drag to move');
  grip.setAttribute('tabindex', '-1');
  grip.innerHTML = GRIP_SVG;

  container.append(addBtn, grip);
  return { container, addBtn, grip };
}

function addBlockBelow(editor: Editor, pos: number, node: PmNode) {
  const { state, view } = editor;
  const insertAt = pos + node.nodeSize;
  if (insertAt > state.doc.content.size) return;
  const paragraph = state.schema.nodes.paragraph?.create();
  if (!paragraph) return;
  const tr = state.tr.insert(insertAt, paragraph);
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1))).scrollIntoView();
  view.dispatch(tr);
  view.focus();
  editor.commands.insertContent('/');
}

export const BlockDragHandle = Extension.create({
  name: 'okBlockDragHandle',

  addProseMirrorPlugins() {
    const editor = this.editor;
    let curNode: PmNode | null = null;
    let curPos = -1;

    const { container, addBtn, grip } = buildControls();

    addBtn.addEventListener('click', () => {
      if (curNode && curPos >= 0) addBlockBelow(editor, curPos, curNode);
    });
    grip.addEventListener('click', () => {
      if (curPos < 0) return;
      try {
        editor.chain().focus().setNodeSelection(curPos).run();
      } catch {}
    });

    return [
      DragHandlePlugin({
        editor,
        element: container,
        nestedOptions: normalizeNestedOptions(false),
        computePositionConfig: {
          placement: 'left-start',
          strategy: 'absolute',
          middleware: [
            offset(({ rects }) => {
              const firstLineHeight =
                rects.reference.height <= MAX_SINGLE_LINE_HEIGHT
                  ? rects.reference.height
                  : BODY_LINE_HEIGHT;
              return { mainAxis: 6, crossAxis: (firstLineHeight - HANDLE_HEIGHT) / 2 };
            }),
          ],
        },
        onNodeChange: ({ node, pos }) => {
          curNode = node;
          curPos = pos;
        },
      }).plugin,
    ];
  },
});
