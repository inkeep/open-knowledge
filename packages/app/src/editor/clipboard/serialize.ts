import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import { markdownToHtml } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import type { Node, ResolvedPos, Schema, Slice } from '@tiptap/pm/model';
import { DOMSerializer, Fragment, Slice as SliceCtor } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import {
  type SerializeResult,
  type WalkerEnv,
  walkLiveDomToInlineStyledFragment,
} from './clipboard-walker.ts';
import {
  stripClipboardOmitted,
  stripClipboardOmittedFromFragment,
  stripClipboardOmittedFromNode,
} from './comment-scrub.ts';
import { classifyError, logSerializeFail } from './instrument.ts';

interface WysiwygSerializerDeps {
  mdManager: MarkdownManager;
}

export interface ClipboardHtmlSerializerHandle {
  serializer: DOMSerializer;
  setView: (view: EditorView) => void;
}

export function createClipboardTextSerializer(deps: WysiwygSerializerDeps) {
  return (rawSlice: Slice, view: EditorView): string => {
    const slice = stripClipboardOmitted(rawSlice, view.state.schema);
    if (view.state.selection instanceof CellSelection) {
      try {
        return serializeCellSelectionAsText(view.state.selection);
      } catch (err) {
        logSerializeFail({
          view: 'wysiwyg',
          kind: 'text',
          reason: `cellselection:${(err as Error)?.message ?? 'unknown'}`,
        });
      }
    }
    if (view.state.selection instanceof TextSelection && !view.state.selection.empty) {
      try {
        const stripped = stripEnclosingMarkerWrappers(slice, view.state);
        if (stripped !== slice) {
          return sliceToMarkdown(stripped, view.state.schema, deps.mdManager);
        }
      } catch (err) {
        logSerializeFail({
          view: 'wysiwyg',
          kind: 'text',
          reason: `interior:${(err as Error)?.message ?? 'unknown'}`,
        });
      }
    }
    try {
      return sliceToMarkdown(slice, view.state.schema, deps.mdManager);
    } catch (err) {
      logSerializeFail({
        view: 'wysiwyg',
        kind: 'text',
        reason: (err as Error)?.message ?? 'unknown',
      });
      return slice.content.textBetween(0, slice.content.size, '\n\n');
    }
  };
}

export function serializeCellSelectionAsText(selection: CellSelection): string {
  const rows: string[][] = [];
  let currentRowTop: number | null = null;
  let currentRow: string[] = [];
  selection.forEachCell((cell, pos) => {
    const rowTop = selection.$anchorCell.doc.resolve(pos).before();
    if (currentRowTop === null || rowTop !== currentRowTop) {
      if (currentRow.length > 0) rows.push(currentRow);
      currentRow = [];
      currentRowTop = rowTop;
    }
    currentRow.push(encodeTsvField(cellText(cell)));
  });
  if (currentRow.length > 0) rows.push(currentRow);
  return rows.map((r) => r.join('\t')).join('\n');
}

function cellText(cell: Node): string {
  const scrubbed = stripClipboardOmittedFromNode(cell, cell.type.schema);
  return scrubbed.textBetween(0, scrubbed.content.size, '\n', (leaf) =>
    leaf.type.name === 'hardBreak' ? '\n' : '',
  );
}

const TABLE_WRAPPER_TYPES = new Set(['table', 'tableRow', 'tableCell', 'tableHeader']);

const STRIPPABLE_WRAPPER_TYPES = new Set(['blockquote', 'list', 'listItem', 'footnoteDefinition']);

function selectionCoversAllTextOf($from: ResolvedPos, $to: ResolvedPos, depth: number): boolean {
  const doc = $from.doc;
  return (
    doc.textBetween($from.start(depth), $from.pos, '\n', '￼') === '' &&
    doc.textBetween($to.pos, $to.end(depth), '\n', '￼') === ''
  );
}

export function stripEnclosingMarkerWrappers(slice: Slice, state: EditorState): Slice {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || selection.empty) return slice;
  const { $from, $to } = selection;
  let content = slice.content;
  let openStart = slice.openStart;
  let openEnd = slice.openEnd;
  let prev: { content: Fragment; openStart: number; openEnd: number } | null = null;
  let depth = $from.depth - slice.openStart + 1;
  while (openStart > 0 && openEnd > 0) {
    const only = content.firstChild;
    if (content.childCount !== 1 || only === null) break;
    if (depth < 1 || depth > $from.depth || $from.node(depth).type !== only.type) break;
    let peel: boolean;
    if (TABLE_WRAPPER_TYPES.has(only.type.name) || only.isTextblock) {
      peel = true;
    } else if (STRIPPABLE_WRAPPER_TYPES.has(only.type.name)) {
      if (selectionCoversAllTextOf($from, $to, depth)) {
        if (only.type.name === 'listItem' && prev !== null) {
          ({ content, openStart, openEnd } = prev);
        }
        break;
      }
      peel = true;
    } else {
      break;
    }
    if (!peel) break;
    prev = { content, openStart, openEnd };
    content = only.content;
    openStart -= 1;
    openEnd -= 1;
    depth += 1;
  }
  if (content === slice.content) return slice;
  return new SliceCtor(content, openStart, openEnd);
}

function encodeTsvField(value: string): string {
  if (!/["\t\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

class MdastClipboardSerializer extends DOMSerializer {
  private readonly mdManager: MarkdownManager;
  private view: EditorView | null = null;

  constructor(mdManager: MarkdownManager) {
    super({}, {});
    this.mdManager = mdManager;
  }

  setView(view: EditorView): void {
    this.view = view;
  }

  override serializeFragment(
    fragment: Fragment,
    _options?: { document?: Document },
    target?: HTMLElement | DocumentFragment,
  ): HTMLElement | DocumentFragment {
    const view = this.view;
    if (view && view.state.selection instanceof CellSelection) {
      try {
        const schema = fragment.firstChild?.type.schema ?? view.state.schema;
        const defaultSerializer = DOMSerializer.fromSchema(schema);
        const wrapped = wrapAsTableFragment(
          stripClipboardOmittedFromFragment(fragment, schema),
          schema,
        );
        return defaultSerializer.serializeFragment(wrapped, { document }, target);
      } catch (err) {
        logSerializeFail({
          view: 'wysiwyg',
          kind: 'html',
          reason: `cellselection:${(err as Error)?.message ?? 'unknown'}`,
        });
      }
    }
    if (view && view.state.selection.from !== view.state.selection.to) {
      try {
        const slice = view.state.selection.content();
        const env = buildWalkerEnv(view, this.mdManager);
        const walked = walkLiveDomToInlineStyledFragment(slice, view, env);
        if (walked.childNodes.length > 0) {
          if (target) {
            for (const child of Array.from(walked.childNodes)) target.appendChild(child);
            return target;
          }
          return walked;
        }
      } catch (err) {
        logSerializeFail({
          view: 'wysiwyg',
          kind: 'html',
          reason: `walker:${(err as Error)?.message ?? 'unknown'}`,
        });
      }
    }
    try {
      const schema = fragment.firstChild?.type.schema;
      if (!schema) return target ?? document.createDocumentFragment();
      let slice = new SliceCtor(fragment, 0, 0);
      if (view && view.state.selection instanceof TextSelection && !view.state.selection.empty) {
        try {
          slice = stripEnclosingMarkerWrappers(view.state.selection.content(), view.state);
        } catch (err) {
          logSerializeFail({
            view: 'wysiwyg',
            kind: 'html',
            reason: `interior:${(err as Error)?.message ?? 'unknown'}`,
          });
          slice = new SliceCtor(fragment, 0, 0);
        }
      }
      const html = markdownToHtml(
        sliceToMarkdown(stripClipboardOmitted(slice, schema), schema, this.mdManager),
      );
      const frag = parseHtmlToDocumentFragment(html);
      if (target) {
        for (const child of Array.from(frag.childNodes)) target.appendChild(child);
        return target;
      }
      return frag;
    } catch (err) {
      logSerializeFail({
        view: 'wysiwyg',
        kind: 'html',
        reason: `markdown:${(err as Error)?.message ?? 'unknown'}`,
      });
      return target ?? document.createDocumentFragment();
    }
  }
}

export function createClipboardHtmlSerializer(
  deps: WysiwygSerializerDeps,
): ClipboardHtmlSerializerHandle {
  const serializer = new MdastClipboardSerializer(deps.mdManager);
  return {
    serializer,
    setView: (view) => serializer.setView(view),
  };
}

function sliceToMarkdown(slice: Slice, schema: Schema, mdManager: MarkdownManager): string {
  return mdManager.serialize(sliceToDocJson(slice, schema));
}

export function findDescriptorRoot(live: Element): Element | null {
  let descriptorRoot: Element | null = null;
  let cur: Element | null = live;
  let optedOutWrapper: Element | null = null;
  while (cur && !cur.classList.contains('ProseMirror')) {
    if (cur.hasAttribute('data-node-view-content')) break;
    if (cur.hasAttribute('data-clipboard-inline-leaf')) {
      optedOutWrapper = cur;
      cur = cur.parentElement;
      continue;
    }
    if (optedOutWrapper?.parentElement === cur && cur.classList.contains('react-renderer')) {
      cur = cur.parentElement;
      continue;
    }
    if (
      cur.classList.contains('react-renderer') ||
      cur.hasAttribute('data-node-view-wrapper') ||
      cur.hasAttribute('data-jsx-component')
    ) {
      descriptorRoot = cur;
    }
    cur = cur.parentElement;
  }
  return descriptorRoot;
}

function buildWalkerEnv(view: EditorView, mdManager: MarkdownManager): WalkerEnv {
  return {
    getComputedStyle: (el) => window.getComputedStyle(el),
    serializeElementMarkdown: (live): SerializeResult => {
      const descriptorRoot = findDescriptorRoot(live);
      let pos: number;
      try {
        const parent = descriptorRoot?.parentElement;
        if (parent && descriptorRoot) {
          const idx = Array.prototype.indexOf.call(parent.childNodes, descriptorRoot);
          pos = view.posAtDOM(parent, idx, -1);
        } else {
          pos = view.posAtDOM(live, 0);
        }
      } catch (err) {
        return { kind: 'failed', errorClass: classifyError(err) };
      }
      if (pos < 0) return { kind: 'no-correspondence' };
      const node = view.state.doc.nodeAt(pos);
      if (!node) return { kind: 'no-correspondence' };
      const slice = view.state.doc.slice(pos, pos + node.nodeSize);
      try {
        return { kind: 'ok', markdown: sliceToMarkdown(slice, view.state.schema, mdManager) };
      } catch (err) {
        return { kind: 'failed', errorClass: classifyError(err) };
      }
    },
  };
}

export function sliceToDocJson(slice: Slice, schema: Schema): JSONContent {
  let content = slice.content;
  const first = content.firstChild;
  if (first?.isInline) {
    const paragraph = schema.nodes.paragraph;
    if (paragraph) {
      const wrapped = paragraph.createAndFill(null, content);
      if (wrapped) content = Fragment.from(wrapped);
    }
  }
  let docNode = schema.topNodeType.createAndFill(null, content);
  if (!docNode) {
    const lifted = liftUnfittableChildren(content, schema);
    if (lifted !== content) docNode = schema.topNodeType.createAndFill(null, lifted);
  }
  if (!docNode) {
    const empty = schema.topNodeType.createAndFill();
    if (!empty) throw new Error('[clipboard] schema cannot fill topNodeType');
    return empty.toJSON() as JSONContent;
  }
  return docNode.toJSON() as JSONContent;
}

function liftUnfittableChildren(content: Fragment, schema: Schema): Fragment {
  const match = schema.topNodeType.contentMatch;
  const out: Node[] = [];
  let changed = false;
  content.forEach((child) => {
    if (!match.matchType(child.type) && child.childCount > 0) {
      child.content.forEach((grandchild) => {
        out.push(grandchild);
      });
      changed = true;
    } else {
      out.push(child);
    }
  });
  return changed ? Fragment.fromArray(out) : content;
}

export function wrapAsTableFragment(fragment: Fragment, schema: Schema): Fragment {
  const tableType = schema.nodes.table;
  const rowType = schema.nodes.tableRow;
  if (!tableType || !rowType) return fragment;
  const first = fragment.firstChild;
  if (!first) return fragment;
  if (first.type === tableType) return fragment;
  const rows: Node[] = [];
  fragment.forEach((child) => {
    if (child.type === rowType) {
      rows.push(child);
    } else {
      const row = rowType.createAndFill(null, child);
      if (row) rows.push(row);
    }
  });
  const table = tableType.createAndFill(null, Fragment.fromArray(rows));
  return table ? Fragment.from(table) : fragment;
}

function parseHtmlToDocumentFragment(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const frag = document.createDocumentFragment();
  for (const child of Array.from(doc.body.childNodes)) {
    frag.appendChild(child);
  }
  return frag;
}
