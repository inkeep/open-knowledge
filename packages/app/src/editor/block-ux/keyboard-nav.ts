
import { incrementJsxArrowNodeSelectFailed } from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';

type ArrowDirection = 'up' | 'down' | 'left' | 'right';

function tryL0NodeSelect(editor: Editor, dir: ArrowDirection): boolean {
  const { state, view } = editor;
  if (!state.selection.empty) return false;
  if (!view.endOfTextblock(dir)) return false;

  const $head = state.selection.$head;
  const isForward = dir === 'down' || dir === 'right';

  let adj: ReturnType<typeof state.doc.nodeAt> | null = null;
  let adjPos = -1;
  if (isForward) {
    const afterPos = $head.after();
    if (afterPos >= state.doc.content.size) return false;
    adj = state.doc.nodeAt(afterPos);
    adjPos = afterPos;
  } else {
    const beforePos = $head.before();
    if (beforePos <= 0) return false;
    const $beforePos = state.doc.resolve(beforePos);
    adj = $beforePos.nodeBefore;
    if (!adj) return false;
    adjPos = beforePos - adj.nodeSize;
  }

  if (!adj) return false;
  if (adj.type.name !== 'jsxComponent') return false;
  if (adj.childCount !== 0) return false;
  if (!NodeSelection.isSelectable(adj)) return false;

  try {
    const sel = NodeSelection.create(state.doc, adjPos);
    editor.view.dispatch(state.tr.setSelection(sel).scrollIntoView());
    return true;
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    incrementJsxArrowNodeSelectFailed(dir);
    console.warn(
      JSON.stringify({
        event: 'jsx-component-arrow-node-select-failed',
        direction: dir,
        tier: 'L0',
        reason: err.message.slice(0, 500),
      }),
    );
    return true;
  }
}

function tryExitCompoundJsxUp(editor: Editor): boolean {
  const { state, view } = editor;
  if (!(state.selection instanceof TextSelection)) return false;
  if (!state.selection.empty) return false;
  if (!view.endOfTextblock('up')) return false;

  const $head = state.selection.$head;

  let jsxDepth = -1;
  for (let d = $head.depth - 1; d >= 1; d--) {
    if ($head.node(d).type.name === 'jsxComponent') {
      jsxDepth = d;
      break;
    }
  }
  if (jsxDepth < 0) return false;

  for (let d = $head.depth; d > jsxDepth; d--) {
    if ($head.index(d - 1) !== 0) return false;
  }

  const exitPos = $head.before(jsxDepth);

  try {
    const $exitPos = state.doc.resolve(exitPos);
    const found = Selection.findFrom($exitPos, -1, true);
    if (!found || !(found instanceof TextSelection)) return false;
    editor.view.dispatch(state.tr.setSelection(found).scrollIntoView());
    return true;
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    incrementJsxArrowNodeSelectFailed('up');
    console.warn(
      JSON.stringify({
        event: 'jsx-component-arrow-node-select-failed',
        direction: 'up',
        tier: 'L2c',
        reason: err.message.slice(0, 500),
      }),
    );
    return true;
  }
}

function tryEnterCompoundJsx(editor: Editor, dir: ArrowDirection): boolean {
  const { state, view } = editor;
  if (!(state.selection instanceof TextSelection)) return false;
  if (!state.selection.empty) return false;
  if (!view.endOfTextblock(dir)) return false;

  const $head = state.selection.$head;
  const isForward = dir === 'down' || dir === 'right';

  let adj: ReturnType<typeof state.doc.nodeAt> | null = null;
  let adjPos = -1;
  if (isForward) {
    const afterPos = $head.after();
    if (afterPos >= state.doc.content.size) return false;
    adj = state.doc.nodeAt(afterPos);
    adjPos = afterPos;
  } else {
    const beforePos = $head.before();
    if (beforePos <= 0) return false;
    const $beforePos = state.doc.resolve(beforePos);
    adj = $beforePos.nodeBefore;
    if (!adj) return false;
    adjPos = beforePos - adj.nodeSize;
  }

  if (!adj) return false;
  if (adj.type.name !== 'jsxComponent') return false;
  if (adj.childCount === 0) return false;

  const adjEnd = adjPos + adj.nodeSize;

  try {
    const fromPos = isForward ? adjPos + 1 : adjEnd - 1;
    const found = Selection.findFrom(state.doc.resolve(fromPos), isForward ? 1 : -1, true);
    if (!found || !(found instanceof TextSelection)) return false;
    if (found.$head.pos <= adjPos || found.$head.pos >= adjEnd) return false;
    editor.view.dispatch(state.tr.setSelection(found).scrollIntoView());
    return true;
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    incrementJsxArrowNodeSelectFailed(dir);
    console.warn(
      JSON.stringify({
        event: 'jsx-component-arrow-node-select-failed',
        direction: dir,
        tier: 'L2d',
        reason: err.message.slice(0, 500),
      }),
    );
    return true;
  }
}

export const KeyboardNav = Extension.create({
  name: 'keyboardNav',
  priority: 50, // lower than Suggestion plugins so they intercept Escape first (L4)

  addKeyboardShortcuts() {
    return {
      Escape: ({ editor }) => {
        const { state } = editor;

        if (state.selection instanceof NodeSelection) {
          if (state.selection.$from.depth === 0) {
            editor.commands.blur();
            return true;
          }
          const pos = state.selection.from + state.selection.node.nodeSize;
          const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size));
          const sel = TextSelection.near($pos);
          editor.view.dispatch(state.tr.setSelection(sel));
          return true;
        }

        if (state.selection instanceof TextSelection) {
          return editor.commands.selectParentNode();
        }

        return false;
      },

      ArrowUp: ({ editor }) => {
        if (tryL0NodeSelect(editor, 'up')) return true;
        if (tryExitCompoundJsxUp(editor)) return true;
        if (tryEnterCompoundJsx(editor, 'up')) return true;

        const { state } = editor;
        if (!(state.selection instanceof NodeSelection)) return false;

        const pos = state.selection.from;
        const $pos = state.doc.resolve(pos);

        if ($pos.index($pos.depth) === 0) return false; // at first child
        const prevPos = $pos.before($pos.depth);
        if (prevPos <= 0) return false;

        const $prevPos = state.doc.resolve(prevPos - 1);
        const prevNode = $prevPos.nodeBefore;
        if (!prevNode) return false;

        const prevNodePos = prevPos - 1 - prevNode.nodeSize + 1;
        if (prevNodePos < 0) return false;

        try {
          const sel = NodeSelection.create(state.doc, prevPos - prevNode.nodeSize);
          editor.view.dispatch(state.tr.setSelection(sel).scrollIntoView());
          return true;
        } catch (err) {
          if (!(err instanceof RangeError)) throw err;
          incrementJsxArrowNodeSelectFailed('up');
          console.warn(
            JSON.stringify({
              event: 'jsx-component-arrow-node-select-failed',
              direction: 'up',
              tier: 'L2',
              reason: err.message.slice(0, 500),
            }),
          );
          return false;
        }
      },

      ArrowDown: ({ editor }) => {
        if (tryL0NodeSelect(editor, 'down')) return true;
        if (tryEnterCompoundJsx(editor, 'down')) return true;

        const { state } = editor;
        if (!(state.selection instanceof NodeSelection)) return false;

        const pos = state.selection.from;
        const nodeSize = state.selection.node.nodeSize;
        const nextPos = pos + nodeSize;

        if (nextPos >= state.doc.content.size) return false;

        try {
          const nextNode = state.doc.nodeAt(nextPos);
          if (!nextNode) return false;
          const sel = NodeSelection.create(state.doc, nextPos);
          editor.view.dispatch(state.tr.setSelection(sel).scrollIntoView());
          return true;
        } catch (err) {
          if (!(err instanceof RangeError)) throw err;
          incrementJsxArrowNodeSelectFailed('down');
          console.warn(
            JSON.stringify({
              event: 'jsx-component-arrow-node-select-failed',
              direction: 'down',
              tier: 'L2',
              reason: err.message.slice(0, 500),
            }),
          );
          return false;
        }
      },

      ArrowLeft: ({ editor }) =>
        tryL0NodeSelect(editor, 'left') || tryEnterCompoundJsx(editor, 'left'),

      ArrowRight: ({ editor }) =>
        tryL0NodeSelect(editor, 'right') || tryEnterCompoundJsx(editor, 'right'),

      Enter: ({ editor }) => {
        const { state } = editor;
        if (!(state.selection instanceof TextSelection)) return false;
        if (!state.selection.empty) return false;

        const $from = state.selection.$from;

        const parentNode = $from.parent;
        if (parentNode.type.name !== 'paragraph' || parentNode.textContent !== '') return false;

        if ($from.depth < 2) return false;

        let componentDepth = -1;
        for (let d = $from.depth - 1; d >= 1; d--) {
          if ($from.node(d).type.name === 'jsxComponent') {
            componentDepth = d;
            break;
          }
        }
        if (componentDepth < 0) return false;

        const componentNode = $from.node(componentDepth);
        const paragraphIndex = $from.index(componentDepth);
        if (paragraphIndex !== componentNode.childCount - 1) return false;

        const insertPos = $from.after(componentDepth);
        if (insertPos > state.doc.content.size) return false;

        const tr = state.tr;
        const emptyParaFrom = $from.before($from.depth);
        const emptyParaTo = $from.after($from.depth);
        tr.delete(emptyParaFrom, emptyParaTo);

        const adjustedInsertPos = insertPos - (emptyParaTo - emptyParaFrom);
        const newPara = state.schema.nodes.paragraph.create();
        tr.insert(adjustedInsertPos, newPara);

        const cursorPos = adjustedInsertPos + 1;
        tr.setSelection(TextSelection.create(tr.doc, cursorPos));
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },
});
