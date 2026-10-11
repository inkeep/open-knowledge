import { DOMSerializer, type Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { MarkChange, SpanChange } from './build-rendered-diff';
import type { RenderedJsxBlock } from './diff-jsx-block';

export type JsxBlockRenderer = (node: PMNode) => RenderedJsxBlock;

export const RENDERED_DIFF_CHANGE_SELECTOR =
  '.ok-diff-ins, .ok-diff-ins-block, [data-diff-deleted]';

export function countRenderedDiffAnchors(diff: {
  changes: readonly SpanChange[];
  markChanges: readonly MarkChange[];
}): number {
  return diff.changes.length + 2 * diff.markChanges.length;
}

function fragmentHasBlock(frag: Fragment): boolean {
  let hasBlock = false;
  frag.forEach((child) => {
    if (child.isBlock) hasBlock = true;
  });
  return hasBlock;
}

function isAllListItems(frag: Fragment): boolean {
  if (frag.childCount === 0) return false;
  let all = true;
  frag.forEach((child) => {
    if (child.type.name !== 'listItem' && child.type.name !== 'taskItem') all = false;
  });
  return all;
}

function buildDeletedWidget(
  serializer: DOMSerializer,
  content: Fragment,
  isBlock: boolean,
): HTMLElement {
  const host = document.createElement(isBlock ? 'div' : 'span');
  host.className = isBlock ? 'ok-diff-del ok-diff-del-block' : 'ok-diff-del';
  host.setAttribute('data-diff-deleted', '');
  const rendered = serializer.serializeFragment(content);
  if (isBlock && isAllListItems(content)) {
    const ul = document.createElement('ul');
    ul.appendChild(rendered);
    host.appendChild(ul);
  } else {
    host.appendChild(rendered);
  }
  return host;
}

const widgetCleanups = new WeakMap<Node, Array<() => void>>();

function widgetSerializer(
  schema: Schema,
  renderJsxBlock: JsxBlockRenderer,
  cleanups: Array<() => void>,
): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema);
  return new DOMSerializer(
    {
      ...base.nodes,
      jsxComponent: (node) => {
        const block = renderJsxBlock(node);
        cleanups.push(block.destroy);
        return { dom: block.dom, contentDOM: block.contentDOM };
      },
    },
    base.marks,
  );
}

function deletedWidget(
  pos: number,
  content: Fragment,
  schema: Schema,
  renderJsxBlock: JsxBlockRenderer,
): Decoration {
  const isBlock = fragmentHasBlock(content);
  return Decoration.widget(
    pos,
    () => {
      const cleanups: Array<() => void> = [];
      const dom = buildDeletedWidget(
        widgetSerializer(schema, renderJsxBlock, cleanups),
        content,
        isBlock,
      );
      widgetCleanups.set(dom, cleanups);
      return dom;
    },
    {
      side: -1,
      ignoreSelection: true,
      marks: [],
      destroy: (dom) => {
        for (const cleanup of widgetCleanups.get(dom) ?? []) cleanup();
        widgetCleanups.delete(dom);
      },
    },
  );
}

export function buildDiffDecorations(
  afterDoc: PMNode,
  beforeDoc: PMNode,
  changes: readonly SpanChange[],
  markChanges: readonly MarkChange[],
  schema: Schema,
  renderJsxBlock: JsxBlockRenderer,
): DecorationSet {
  const decorations: Decoration[] = [];

  for (const mark of markChanges) {
    const slice = beforeDoc.slice(mark.fromA, mark.toA);
    decorations.push(deletedWidget(mark.fromB, slice.content, schema, renderJsxBlock));
    decorations.push(
      Decoration.inline(mark.fromB, mark.toB, { class: 'ok-diff-ins' }, { inclusiveEnd: true }),
    );
  }

  for (const change of changes) {
    if (change.toB > change.fromB) {
      decorations.push(Decoration.node(change.fromB, change.toB, { class: 'ok-diff-ins-block' }));
    }
    if (change.toA > change.fromA) {
      const slice = beforeDoc.slice(change.fromA, change.toA);
      decorations.push(deletedWidget(change.fromB, slice.content, schema, renderJsxBlock));
    }
  }

  return DecorationSet.create(afterDoc, decorations);
}
