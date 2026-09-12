import { DOMSerializer, Fragment, type Node as PmNode, Slice } from '@tiptap/pm/model';
import { type EditorState, NodeSelection, Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  type ProsemirrorBinding,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import { type Doc, RelativePosition, type XmlFragment } from 'yjs';
import { stripClipboardOmitted } from '../clipboard/comment-scrub.ts';
import { dispatchAsOwnUndoStep } from '../undo-isolation.ts';
import { listItemIntersectsSelection, normalizeList } from './list-editing-helpers.ts';

type DragRange = {
  from: number;
  to: number;
  listPos: number | null;
  sourceLists: number[];
};

function selectionBoundary(doc: PmNode, pos: number, edge: 'start' | 'end'): number {
  const end = edge === 'end';
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock && (end ? $pos.nodeBefore : $pos.nodeAfter)) {
    return pos;
  }
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === 'listItem') {
      const listPos = $pos.before(depth - 1);
      const boundary = end ? $pos.after(depth) : $pos.before(depth);
      const list = $pos.node(depth - 1);
      const outerEdge = end
        ? boundary === listPos + 1 + list.content.size
        : boundary === listPos + 1;
      return outerEdge ? (end ? listPos + list.nodeSize : listPos) : boundary;
    }
  }
  return $pos.depth ? (end ? $pos.after(1) : $pos.before(1)) : pos;
}

function normalizeListNode(list: PmNode): PmNode {
  if (!list.attrs.ordered) return list;
  const items: PmNode[] = [];
  list.forEach((item, _offset, index) => {
    items.push(
      item.type.create(
        {
          ...item.attrs,
          sourceOrdinal: Number(list.attrs.start) + index,
        },
        item.content,
        item.marks,
      ),
    );
  });
  return list.copy(Fragment.from(items));
}

function appendListBlock(content: PmNode[], node: PmNode): void {
  const previous = content.at(-1);
  if (
    previous?.type.name === 'list' &&
    node.type === previous.type &&
    node.attrs.ordered === previous.attrs.ordered &&
    node.attrs.bulletMarker === previous.attrs.bulletMarker &&
    node.attrs.listMarkerDelimiter === previous.attrs.listMarkerDelimiter
  ) {
    content[content.length - 1] = normalizeListNode(
      previous.type.create(
        {
          ...previous.attrs,
          spread: previous.attrs.spread || node.attrs.spread,
        },
        previous.content.append(node.content),
        previous.marks,
      ),
    );
  } else {
    content.push(node);
  }
}

function closePartialNode(node: PmNode, openStart: number, openEnd: number): PmNode[] {
  if (openStart === 0 && openEnd === 0) return [node];
  const children: PmNode[] = [];
  node.forEach((child, _offset, index) => {
    const start = index === 0 ? Math.max(0, openStart - 1) : 0;
    const end = index === node.childCount - 1 ? Math.max(0, openEnd - 1) : 0;
    children.push(...closePartialNode(child, start, end));
  });
  if (node.type.name === 'list') {
    const blocks: PmNode[] = [];
    let items: PmNode[] = [];
    const flush = () => {
      if (items.length === 0) return;
      appendListBlock(blocks, normalizeListNode(node.copy(Fragment.from(items))));
      items = [];
    };
    for (const child of children) {
      if (child.type.name === 'listItem') {
        items.push(child);
      } else {
        flush();
        appendListBlock(blocks, child);
      }
    }
    flush();
    return blocks;
  }
  if (node.type.name === 'listItem' && children[0]?.type.name !== 'paragraph') return children;
  return [node.copy(Fragment.from(children))];
}

function closeMixedSlice(slice: Slice): Slice {
  const content: PmNode[] = [];
  slice.content.forEach((node, _offset, index) => {
    const start = index === 0 ? slice.openStart : 0;
    const end = index === slice.content.childCount - 1 ? slice.openEnd : 0;
    for (const block of closePartialNode(node, start, end)) appendListBlock(content, block);
  });
  return new Slice(Fragment.from(content), 0, 0);
}

function selectionLists(doc: PmNode, from: number, to: number): number[] {
  const positions = new Set<number>();
  for (const pos of [from, to]) {
    const $pos = doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth--) {
      if ($pos.node(depth).type.name === 'list') positions.add($pos.before(depth));
    }
  }
  return [...positions];
}

function selectedRange(view: EditorView, node: PmNode, pos: number): DragRange | null {
  const { doc, selection } = view.state;
  if (node.type.name !== 'listItem') {
    if (selection.empty || selection.to <= pos || selection.from >= pos + node.nodeSize)
      return null;
    const from = selectionBoundary(doc, selection.from, 'start');
    const to = selectionBoundary(doc, selection.to, 'end');
    const sourceLists = selectionLists(doc, selection.from, selection.to);
    if (sourceLists.length === 0) return null;
    return { from, to, listPos: null, sourceLists };
  }
  const $pos = doc.resolve(pos);
  if ($pos.parent.type.name !== 'list') return null;
  const listPos = $pos.before();
  const list = $pos.parent;
  const start = listPos + 1;
  const end = start + list.content.size;
  if (selection.empty || selection.to <= pos || selection.from >= pos + node.nodeSize) {
    return { from: pos, to: pos + node.nodeSize, listPos, sourceLists: [listPos] };
  }
  if (selection.from < start || selection.to > end) {
    const from = selectionBoundary(doc, selection.from, 'start');
    const to = selectionBoundary(doc, selection.to, 'end');
    return {
      from,
      to,
      listPos: null,
      sourceLists: selectionLists(doc, selection.from, selection.to),
    };
  }
  let from = pos;
  let to = pos + node.nodeSize;
  list.forEach((item, offset) => {
    const itemPos = start + offset;
    if (listItemIntersectsSelection(selection, itemPos, item.nodeSize)) {
      from = Math.min(from, itemPos);
      to = Math.max(to, itemPos + item.nodeSize);
    }
  });
  if (from === start && to === end) {
    return { from: listPos, to: listPos + list.nodeSize, listPos: null, sourceLists: [] };
  }
  return { from, to, listPos, sourceLists: [listPos] };
}

type SyncState = {
  doc: Doc;
  type: XmlFragment;
  binding: ProsemirrorBinding;
};

type RelativeRange = {
  from: RelativePosition;
  to: RelativePosition;
  lists: RelativePosition[];
};

type DragState =
  | { status: 'idle' }
  | { status: 'canceled' }
  | { status: 'active'; range: DragRange; relative: RelativeRange | null };

function relativeRange(state: EditorState, range: DragRange): RelativeRange | null {
  const sync: SyncState | undefined = ySyncPluginKey.getState(state);
  if (!sync) return null;
  const relative = (pos: number): RelativePosition =>
    absolutePositionToRelativePosition(pos, sync.type, sync.binding.mapping);
  return {
    from: relative(range.from + 1),
    to: relative(range.to - 1),
    lists: range.sourceLists.map((pos) => {
      const anchor = relative(pos + 1);
      return new RelativePosition(anchor.type, anchor.tname, null, -1);
    }),
  };
}

function resolveRelativeRange(
  state: EditorState,
  active: Extract<DragState, { status: 'active' }>,
): DragRange | null {
  const sync: SyncState | undefined = ySyncPluginKey.getState(state);
  if (!sync || !active.relative) return null;
  const absolute = (pos: RelativePosition): number | null =>
    relativePositionToAbsolutePosition(sync.doc, sync.type, pos, sync.binding.mapping);
  const start = absolute(active.relative.from);
  const end = absolute(active.relative.to);
  if (start === null || end === null || start < 1 || end >= state.doc.content.size || start > end)
    return null;
  const from = start - 1;
  const to = end + 1;
  const $from = state.doc.resolve(from);
  const listPos =
    active.range.listPos !== null && $from.parent.type.name === 'list' ? $from.before() : null;
  if (active.range.listPos !== null && listPos === null) return null;
  const sourceLists: number[] = [];
  if (listPos !== null) {
    sourceLists.push(listPos);
  } else {
    for (const anchor of active.relative.lists) {
      const pos = absolute(anchor);
      if (pos === null || pos <= 0 || state.doc.nodeAt(pos - 1)?.type.name !== 'list') return null;
      sourceLists.push(pos - 1);
    }
  }
  return { from, to, listPos, sourceLists };
}

function stylePreview(preview: HTMLElement, view: EditorView, source: Element | null): void {
  const style = getComputedStyle(view.dom);
  preview.className = 'ProseMirror';
  for (const name of [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'line-height',
    'letter-spacing',
    'color',
    'direction',
    'text-align',
  ]) {
    preview.style.setProperty(name, style.getPropertyValue(name));
  }
  preview.style.position = 'fixed';
  preview.style.left = '-10000px';
  preview.style.top = '0';
  preview.style.width = `${(source ?? view.dom).getBoundingClientRect().width}px`;
  preview.style.height = 'auto';
  preview.style.minHeight = '0';
  preview.style.margin = '0';
  preview.style.padding = '0';
  preview.style.pointerEvents = 'none';
  const list = preview.firstElementChild;
  if (source?.matches('ul, ol') && list instanceof HTMLElement && list.matches('ul, ol')) {
    list.style.listStyleType = getComputedStyle(source).listStyleType;
  }
}

export function createListItemDragController() {
  const key = new PluginKey<DragState>('listItemDrag');
  let dragView: EditorView | null = null;
  let preview: HTMLElement | null = null;
  let dragDocument: Document | null = null;

  const removePreview = () => {
    preview?.remove();
    preview = null;
  };

  const cleanup = () => {
    if (dragView) dragView.dragging = null;
    dragView = null;
    removePreview();
    dragDocument?.removeEventListener('dragend', finish);
    dragDocument?.removeEventListener('drop', finish);
    dragDocument = null;
  };

  const reset = (view: EditorView | null) => {
    cleanup();
    if (view && !view.isDestroyed && key.getState(view.state)?.status !== 'idle') {
      view.dispatch(view.state.tr.setMeta(key, { status: 'idle' } satisfies DragState));
    }
  };
  const finish = () => reset(dragView);

  const plugin = new Plugin<DragState>({
    key,
    state: {
      init: () => ({ status: 'idle' }),
      apply(tr, value, _oldState, state) {
        const action: DragState | undefined = tr.getMeta(key);
        if (action) return action;
        if (value.status !== 'active' || !tr.docChanged) return value;
        if (tr.getMeta(ySyncPluginKey) && value.relative) {
          const range = resolveRelativeRange(state, value);
          return range ? { ...value, range } : { status: 'canceled' };
        }
        const from = tr.mapping.mapResult(value.range.from, 1);
        const to = tr.mapping.mapResult(value.range.to, -1);
        if (from.deletedAcross || to.deletedAcross || from.pos >= to.pos)
          return { status: 'canceled' };
        return {
          ...value,
          range: {
            from: from.pos,
            to: to.pos,
            listPos: value.range.listPos === null ? null : tr.mapping.map(value.range.listPos, 1),
            sourceLists: value.range.sourceLists.map((pos) => tr.mapping.map(pos, 1)),
          },
        };
      },
    },
    view: () => ({
      update(view, previousState) {
        const current = key.getState(view.state);
        if (current?.status === 'canceled') {
          view.dragging = null;
          removePreview();
          if (key.getState(previousState)?.status !== 'canceled') {
            console.warn('[list-item-drag] drag canceled: source invalidated during drag');
          }
        } else if (current?.status === 'idle') {
          cleanup();
        } else if (current?.status === 'active' && view.dragging) {
          const { range } = current;
          const sourceSlice = view.state.doc.slice(range.from, range.to);
          view.dragging = {
            slice: range.listPos === null ? closeMixedSlice(sourceSlice) : sourceSlice,
            move: true,
          };
        }
      },
    }),
    props: {
      handleDOMEvents: {
        drop(view, event) {
          const active = key.getState(view.state);
          if (!active || active.status === 'idle') return false;
          event.preventDefault();
          try {
            if (active.status === 'canceled') return true;
            const source = active.range;
            const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!hit) {
              return true;
            }
            const { doc } = view.state;
            const sourceSlice = doc.slice(source.from, source.to);
            let slice = source.listPos === null ? closeMixedSlice(sourceSlice) : sourceSlice;
            let insertPos = dropPoint(doc, hit.pos, slice);
            if (insertPos === null || (insertPos >= source.from && insertPos <= source.to)) {
              return true;
            }
            const $insert = doc.resolve(insertPos);
            const targetListPos = $insert.parent.type.name === 'list' ? $insert.before() : null;
            const sourceList = source.listPos === null ? null : doc.nodeAt(source.listPos);
            if (sourceList && targetListPos === null) {
              slice = new Slice(Fragment.from(sourceList.copy(slice.content)), 0, 0);
              insertPos = dropPoint(doc, hit.pos, slice);
              if (insertPos === null) {
                return true;
              }
            }
            const tr = view.state.tr;
            tr.deleteRange(source.from, source.to);
            const mappedInsert = tr.mapping.map(insertPos);
            const beforeInsert = tr.doc;
            tr.replaceRange(mappedInsert, mappedInsert, slice);
            if (tr.doc.eq(beforeInsert)) {
              console.warn('[list-item-drag] drop canceled: insertion did not change the document');
              return true;
            }
            const affected = new Set<number>();
            for (const listPos of source.sourceLists) {
              const originalList = doc.nodeAt(listPos);
              if (originalList?.type.name !== 'list') continue;
              originalList.forEach((item, offset) => {
                const itemPos = listPos + 1 + offset;
                if (itemPos + item.nodeSize <= source.from || itemPos >= source.to) {
                  const $remaining = tr.doc.resolve(tr.mapping.map(itemPos, 1));
                  if ($remaining.parent.type.name === 'list') affected.add($remaining.before());
                }
              });
            }
            if (targetListPos !== null) affected.add(tr.mapping.map(targetListPos, 1));
            if (sourceList && targetListPos === null) affected.add(mappedInsert);
            for (const pos of affected) normalizeList(tr, pos);
            tr.setSelection(
              Selection.near(tr.doc.resolve(Math.min(mappedInsert, tr.doc.content.size))),
            );
            tr.setMeta(key, { status: 'idle' } satisfies DragState);
            dispatchAsOwnUndoStep(view, tr.setMeta('uiEvent', 'drop').scrollIntoView());
            view.focus();
            return true;
          } finally {
            finish();
          }
        },
      },
    },
  });

  function start(event: DragEvent, view: EditorView, node: PmNode | null, pos: number): boolean {
    if (!node || !event.dataTransfer || !view.editable) return false;
    const range = selectedRange(view, node, pos);
    if (!range) return false;
    finish();
    let started = false;
    try {
      const { doc } = view.state;
      const sourceSlice = doc.slice(range.from, range.to);
      const content = range.listPos === null ? closeMixedSlice(sourceSlice) : sourceSlice;
      const list = range.listPos === null ? null : doc.nodeAt(range.listPos);
      const slice = list ? new Slice(Fragment.from(list.copy(content.content)), 1, 1) : content;
      const ownerDocument = view.dom.ownerDocument;
      const serializer = DOMSerializer.fromSchema(view.state.schema);
      const exported = stripClipboardOmitted(slice, view.state.schema);
      const outbound = ownerDocument.createElement('div');
      outbound.appendChild(
        serializer.serializeFragment(exported.content, { document: ownerDocument }),
      );
      outbound.firstElementChild?.setAttribute(
        'data-pm-slice',
        `${exported.openStart} ${exported.openEnd} []`,
      );
      event.dataTransfer.clearData();
      event.dataTransfer.setData('text/html', outbound.innerHTML);
      event.dataTransfer.setData(
        'text/plain',
        exported.content.textBetween(0, exported.content.size, '\n'),
      );
      event.dataTransfer.effectAllowed = 'move';
      preview = ownerDocument.createElement('div');
      preview.appendChild(serializer.serializeFragment(slice.content, { document: ownerDocument }));
      preview.setAttribute('inert', '');
      preview.setAttribute('aria-hidden', 'true');
      const sourceDom = view.nodeDOM(range.listPos ?? range.from);
      const sourceElement = sourceDom instanceof Element ? sourceDom : null;
      stylePreview(preview, view, sourceElement);
      ownerDocument.body.appendChild(preview);
      const sourceRect = sourceElement?.getBoundingClientRect();
      const firstDom = view.nodeDOM(range.from);
      const firstRect = firstDom instanceof Element ? firstDom.getBoundingClientRect() : sourceRect;
      const previewRect = preview.getBoundingClientRect();
      const x = sourceRect ? Math.min(event.clientX - sourceRect.left, previewRect.width) : 0;
      const y = firstRect
        ? Math.min(Math.max(event.clientY - firstRect.top, 0), previewRect.height)
        : 0;
      event.dataTransfer.setDragImage(preview, x, y);
      const selectedNode = doc.nodeAt(range.from);
      const selection =
        selectedNode?.nodeSize === range.to - range.from
          ? NodeSelection.create(doc, range.from)
          : view.state.selection;
      view.dragging = { slice: content, move: true };
      dragView = view;
      view.dispatch(
        view.state.tr.setSelection(selection).setMeta(key, {
          status: 'active',
          range,
          relative: relativeRange(view.state, range),
        } satisfies DragState),
      );
      dragDocument = ownerDocument;
      dragDocument.addEventListener('dragend', finish);
      dragDocument.addEventListener('drop', finish);
      started = true;
      return true;
    } finally {
      if (!started) {
        reset(view);
      }
    }
  }

  return { plugin, start, destroy: cleanup };
}
