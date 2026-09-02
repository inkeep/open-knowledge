/**
 * WYSIWYG paste/drop dispatcher — 5-branch router per precedent #19(b).
 *
 * Branch A: `vscode-editor-data` MIME → fenced code block with language.
 * Branch B: `text/x-gfm` MIME → MarkdownManager.parse (markdown path).
 * Markdown-first ambiguity tiebreak: both text/plain (markdown-shaped) and
 *           text/html present → MarkdownManager.parse on text/plain. Runs
 *           BEFORE Branch C so OK→OK paste of JSX descriptors (`<img/>`,
 *           `<Callout>`) routes through the canonical text/plain markdown
 *           path and preserves descriptor identity, instead of falling to
 *           PM-native parseFromClipboard where TipTap's parseDOM rules can
 *           win over `jsxComponent`.
 * Branch C: HTML contains `data-pm-slice` → PM native parseFromClipboard
 *           (return false and let PM handle). Cross-PM-editor interop:
 *           Linear/Outline/BlockNote also emit canonical markdown to
 *           text/plain, so the markdown-first tiebreak above catches them
 *           with equivalent results — Branch C remains the fallback for
 *           PM payloads whose text/plain isn't markdown-shaped.
 * Branch D: generic HTML → htmlToMdast → remark-stringify → MarkdownManager.parse.
 * Branch E: text/plain only → markdown-first if isMarkdown threshold hit;
 *           else verbatim plain-text insert.
 *
 * Placement: the markdown branches insert the re-parsed JSON as a closed
 * slice, EXCEPT when the caret is inside a list item — then a list-aware
 * splice runs instead of letting the fitter nest or orphan the content
 * (issue #609). All-list payloads splice as item siblings at the caret's
 * list level (`buildListSiblingSpliceTr`); mixed payloads split the list at
 * the caret and place non-list blocks as siblings of the list itself
 * (`buildMixedSiblingSpliceTr`).
 *
 * codeBlock short-circuit: cursor inside a codeBlock → skip all branches,
 * insert text/plain verbatim.
 *
 * Lone-URL step: after those two gates and before the MIME branches, a
 * payload whose text/plain is a single URL token linkifies instead of
 * falling into the branch tree. Over a one-block text selection the
 * selected text is kept and link-marked (trust-the-gesture policy — see
 * lone-url.ts); at a cursor only GFM autolink shapes convert, routed
 * through MarkdownManager.parse so the mark and bytes are exactly what the
 * pipeline itself produces. Everything else falls through unchanged. The
 * step runs before Branch A/D so a browser link-copy (which also carries
 * text/html) converts the selection rather than replacing it.
 *
 * Every dispatcher-minted transaction carries `preventAutolink` meta:
 * paste output is never re-scanned by the typed-autolink plugin, so a URL
 * inside pasted prose stays exactly as pasted.
 *
 * Cmd+Shift+V (paste): detected via `pasteShiftHeld(event)` which checks
 * the most-recent keyboard event (real browsers don't set `shiftKey` on
 * ClipboardEvent) plus a Playwright-test-style injected property. Drop
 * surface reads `shiftKey` directly off the DragEvent (DragEvent extends
 * MouseEvent → modifier flags are first-class).
 *
 * Drop surface: `createHandleDrop` runs the same dispatcher against
 * `event.dataTransfer`. Drag-from-Finder of any file (.md or otherwise)
 * carries `dataTransfer.files` — that path is owned by the FileHandler
 * extension's `onDrop` callback (`extensions/shared.ts`); the dispatcher
 * defers by returning `false` whenever files are present so PM continues
 * to the next handler.
 *
 * Error-path: every conversion call is try/caught; on throw, fall through
 * to the next layer, never silently drop content. Per-stage telemetry
 * emitted as structured `clipboard-html-conversion-fail` events so log
 * aggregators see which stage failed instead of a single bracket-prefixed
 * string.
 */

import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import { htmlToMdast, mdastToMarkdown } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { type EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { PREVENT_AUTOLINK_META } from '../gfm-autolink-plugin.ts';
import { OK_INTERNAL_CLIPBOARD_MIME } from './comment-scrub.ts';
import { type ClipboardSource, detectSource } from './detect-source.ts';
import {
  type ClipboardBranch,
  classifyError,
  logConversionFail,
  logIfSlow,
  logSourceDetected,
} from './instrument.ts';
import { isMarkdown } from './is-markdown.ts';
import { detectLoneGfmUrl, detectLoneTrustedUrl } from './lone-url.ts';
import { notifyPasteDegraded } from './paste-failure-toast.ts';
import { pasteShiftHeld } from './shift-tracker.ts';

interface PasteDispatcherDeps {
  mdManager: MarkdownManager;
}

type DispatchSurface = 'paste' | 'drop';

export function createHandlePaste(deps: PasteDispatcherDeps) {
  return (view: EditorView, event: ClipboardEvent): boolean =>
    handleDropOrPaste(view, event, 'paste', deps);
}

export function createHandleDrop(deps: PasteDispatcherDeps) {
  return (view: EditorView, event: DragEvent): boolean => {
    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      return false;
    }
    return handleDropOrPaste(view, event, 'drop', deps);
  };
}

function handleDropOrPaste(
  view: EditorView,
  event: ClipboardEvent | DragEvent,
  surface: DispatchSurface,
  deps: PasteDispatcherDeps,
): boolean {
  const dt =
    surface === 'paste'
      ? (event as ClipboardEvent).clipboardData
      : (event as DragEvent).dataTransfer;
  if (!dt || dt.types.length === 0) return false;

  const start = performance.now();
  const source = detectSource(dt);
  const plain = dt.getData('text/plain');
  const html = dt.getData('text/html');

  if (isShiftHeldForSurface(event, surface)) {
    if (plain) insertPlainText(view, plain);
    logSourceDetected({ view: 'wysiwyg', branch: 'shift', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'shift', source });
    return true;
  }

  if (isCursorInCodeBlock(view)) {
    if (plain) insertPlainText(view, plain);
    logSourceDetected({ view: 'wysiwyg', branch: 'codeblock', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'codeblock', source });
    return true;
  }

  if (plain) {
    if (!view.state.selection.empty) {
      const href = detectLoneTrustedUrl(plain);
      if (href && linkifySelection(view, href, source)) {
        logSourceDetected({ view: 'wysiwyg', branch: 'url', source });
        logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'url', source });
        return true;
      }
    } else {
      const gfmToken = detectLoneGfmUrl(plain);
      if (gfmToken && tryBranchMarkdown(view, gfmToken, deps, 'url', source)) {
        logSourceDetected({ view: 'wysiwyg', branch: 'url', source });
        logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'url', source });
        return true;
      }
    }
  }

  const internal = dt.getData(OK_INTERNAL_CLIPBOARD_MIME);
  if (internal && tryBranchMarkdown(view, internal, deps, 'internal', source)) {
    logSourceDetected({ view: 'wysiwyg', branch: 'internal', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'internal', source });
    return true;
  }

  const vscodeData = dt.getData('vscode-editor-data');
  if (vscodeData && plain && tryBranchA(view, vscodeData, plain, source)) {
    logSourceDetected({ view: 'wysiwyg', branch: 'A', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'A', source });
    return true;
  }

  const gfm = dt.getData('text/x-gfm');
  if (gfm && tryBranchMarkdown(view, gfm, deps, 'B', source)) {
    logSourceDetected({ view: 'wysiwyg', branch: 'B', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'B', source });
    return true;
  }

  if (plain && html && isMarkdown(plain) && tryBranchMarkdown(view, plain, deps, 'B', source)) {
    logSourceDetected({ view: 'wysiwyg', branch: 'B', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'B', source });
    return true;
  }

  if (html && /data-pm-slice/i.test(html)) {
    logSourceDetected({
      view: 'wysiwyg',
      branch: 'C',
      source,
    });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'C', source });
    return false;
  }

  if (html && tryBranchHtml(view, html, deps, source)) {
    logSourceDetected({
      view: 'wysiwyg',
      branch: 'D',
      source,
    });
    logIfSlow(start, {
      op: surface,
      view: 'wysiwyg',
      branch: 'D',
      source,
      htmlBytes: html.length,
    });
    return true;
  }

  if (plain) {
    if (isMarkdown(plain) && tryBranchMarkdown(view, plain, deps, 'E', 'markdown-text')) {
      logSourceDetected({ view: 'wysiwyg', branch: 'E', source: 'markdown-text' });
      logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'E', source: 'markdown-text' });
      return true;
    }
    insertPlainText(view, plain);
    logSourceDetected({ view: 'wysiwyg', branch: 'E', source: 'plaintext' });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'E', source: 'plaintext' });
    return true;
  }

  return false;
}

function isShiftHeldForSurface(
  event: ClipboardEvent | DragEvent,
  surface: DispatchSurface,
): boolean {
  if (surface === 'paste') return pasteShiftHeld(event as ClipboardEvent);
  return (event as DragEvent).shiftKey === true;
}

function isCursorInCodeBlock(view: EditorView): boolean {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    if ($from.node(depth).type.name === 'codeBlock') return true;
  }
  return false;
}

function linkifySelection(view: EditorView, href: string, source: ClipboardSource): boolean {
  try {
    const { state } = view;
    const selection = state.selection;
    if (!(selection instanceof TextSelection)) return false;
    if (!selection.$from.sameParent(selection.$to)) return false;
    const linkType = state.schema.marks.link;
    if (!linkType) return false;
    const codeType = state.schema.marks.code;
    if (codeType && state.doc.rangeHasMark(selection.from, selection.to, codeType)) return false;
    view.dispatch(
      state.tr
        .addMark(selection.from, selection.to, linkType.create({ href }))
        .setMeta(PREVENT_AUTOLINK_META, true),
    );
    return true;
  } catch (err) {
    logConversionFail({
      view: 'wysiwyg',
      stage: 'linkifySelection',
      source,
      branch: 'url',
      reason: `${(err as Error)?.message ?? 'unknown'} (href=${href})`,
      errorClass: classifyError(err),
    });
    notifyPasteDegraded('wysiwyg', 'Pasted without linking — the link could not be applied.');
    return false;
  }
}

function insertPlainText(view: EditorView, text: string): void {
  const { schema, tr } = view.state;
  if (!text) return;
  view.dispatch(
    tr
      .replaceSelectionWith(schema.text(text))
      .setMeta(PREVENT_AUTOLINK_META, true)
      .scrollIntoView(),
  );
}

const LANG_IDENT = /^[A-Za-z0-9_+-]+$/;

function tryBranchA(
  view: EditorView,
  vscodeData: string,
  text: string,
  source: ClipboardSource,
): boolean {
  try {
    const meta = JSON.parse(vscodeData) as { mode?: string };
    const rawLang = typeof meta.mode === 'string' ? meta.mode : '';
    const lang = LANG_IDENT.test(rawLang) ? rawLang : '';
    const codeBlockType = view.state.schema.nodes.codeBlock;
    if (!codeBlockType) return false;
    const codeNode = codeBlockType.create(
      { language: lang },
      text ? view.state.schema.text(text) : null,
    );
    view.dispatch(
      view.state.tr
        .replaceSelectionWith(codeNode)
        .setMeta(PREVENT_AUTOLINK_META, true)
        .scrollIntoView(),
    );
    return true;
  } catch (err) {
    logConversionFail({
      view: 'wysiwyg',
      stage: 'branchA',
      source,
      branch: 'A',
      reason: (err as Error)?.message ?? 'unknown',
      errorClass: classifyError(err),
    });
    notifyPasteDegraded('wysiwyg');
    return false;
  }
}

function tryBranchMarkdown(
  view: EditorView,
  markdown: string,
  deps: PasteDispatcherDeps,
  branchLabel: 'B' | 'E' | 'url' | 'internal',
  source: ClipboardSource,
): boolean {
  let json: JSONContent;
  try {
    json = deps.mdManager.parse(markdown);
  } catch (err) {
    logConversionFail({
      view: 'wysiwyg',
      stage: 'mdManagerParse',
      source,
      branch: branchLabel,
      reason: (err as Error)?.message ?? 'unknown',
      errorClass: classifyError(err),
    });
    notifyPasteDegraded('wysiwyg');
    return false;
  }
  return applyJsonSlice(view, json, source, branchLabel);
}

function tryBranchHtml(
  view: EditorView,
  html: string,
  deps: PasteDispatcherDeps,
  source: ClipboardSource,
): boolean {
  let mdast: ReturnType<typeof htmlToMdast>;
  try {
    mdast = htmlToMdast(html);
  } catch (err) {
    logConversionFail({
      view: 'wysiwyg',
      stage: 'htmlToMdast',
      source,
      branch: 'D',
      reason: (err as Error)?.message ?? 'unknown',
      errorClass: classifyError(err),
      htmlBytes: html.length,
    });
    notifyPasteDegraded('wysiwyg');
    return false;
  }
  let markdown: string;
  try {
    markdown = mdastToMarkdown(mdast);
  } catch (err) {
    logConversionFail({
      view: 'wysiwyg',
      stage: 'mdastToMarkdown',
      source,
      branch: 'D',
      reason: (err as Error)?.message ?? 'unknown',
      errorClass: classifyError(err),
      htmlBytes: html.length,
    });
    notifyPasteDegraded('wysiwyg');
    return false;
  }
  let json: JSONContent;
  try {
    json = deps.mdManager.parse(markdown);
  } catch (err) {
    logConversionFail({
      view: 'wysiwyg',
      stage: 'mdManagerParse',
      source,
      branch: 'D',
      reason: (err as Error)?.message ?? 'unknown',
      errorClass: classifyError(err),
      htmlBytes: html.length,
    });
    notifyPasteDegraded('wysiwyg');
    return false;
  }
  return applyJsonSlice(view, json, source, 'D', html.length);
}

function isBlankListItem(item: ProseMirrorNode): boolean {
  if (item.textContent.length > 0) return false;
  let onlyEmptyParagraphs = true;
  item.forEach((child) => {
    if (child.type.name !== 'paragraph' || child.content.size > 0) onlyEmptyParagraphs = false;
  });
  return onlyEmptyParagraphs;
}

function buildListSiblingSpliceTr(
  state: EditorState,
  docNode: ProseMirrorNode,
): Transaction | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const pastedItems: ProseMirrorNode[] = [];
  let allLists = docNode.content.childCount > 0;
  docNode.content.forEach((child) => {
    if (child.type.name !== 'list') {
      allLists = false;
      return;
    }
    child.forEach((item) => {
      if (item.type.name === 'listItem') pastedItems.push(item);
    });
  });
  if (!allLists || pastedItems.length === 0) return null;

  const { $from } = selection;
  let itemDepth = -1;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === 'listItem') {
      itemDepth = depth;
      break;
    }
  }
  if (itemDepth < 0) return null;
  if (!$from.parent.isTextblock) return null;

  const targetItem = $from.node(itemDepth);
  const itemStart = $from.before(itemDepth);
  const itemEnd = $from.after(itemDepth);
  const caretOffset = $from.pos - $from.start(itemDepth);
  const beforeItem = targetItem.cut(0, caretOffset);
  const afterItem = targetItem.cut(caretOffset);

  const replacement: ProseMirrorNode[] = [];
  const keepBefore = !isBlankListItem(beforeItem);
  if (keepBefore) replacement.push(beforeItem);
  replacement.push(...pastedItems);
  if (!isBlankListItem(afterItem)) replacement.push(afterItem);

  const tr = state.tr.replaceWith(itemStart, itemEnd, Fragment.fromArray(replacement));
  let caretPos = itemStart + (keepBefore ? beforeItem.nodeSize : 0);
  for (const item of pastedItems) caretPos += item.nodeSize;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caretPos, tr.doc.content.size)), -1));
  return tr;
}

function listItemsOf(list: ProseMirrorNode): ProseMirrorNode[] {
  const items: ProseMirrorNode[] = [];
  list.forEach((item) => {
    if (item.type.name === 'listItem') items.push(item);
  });
  return items;
}

function pruneTrailingCutBlanks(node: ProseMirrorNode): ProseMirrorNode | null {
  if (node.type.name === 'list') {
    const items = listItemsOf(node);
    while (items.length > 0) {
      const pruned = pruneTrailingCutBlanks(items[items.length - 1]);
      if (pruned) {
        items[items.length - 1] = pruned;
        break;
      }
      items.pop();
    }
    return items.length > 0 ? node.copy(Fragment.fromArray(items)) : null;
  }
  if (node.type.name === 'listItem') {
    const children: ProseMirrorNode[] = [];
    node.forEach((child) => {
      children.push(child);
    });
    if (children.length > 0 && children[children.length - 1].type.name === 'list') {
      const pruned = pruneTrailingCutBlanks(children[children.length - 1]);
      if (pruned) children[children.length - 1] = pruned;
      else children.pop();
    }
    const rebuilt = node.copy(Fragment.fromArray(children));
    return isBlankListItem(rebuilt) ? null : rebuilt;
  }
  return node;
}

function normalizeLeadingCutItems(items: ProseMirrorNode[]): ProseMirrorNode[] {
  let normalized = items;
  while (normalized.length > 0) {
    const first = normalized[0];
    if (isBlankListItem(first)) {
      normalized = normalized.slice(1);
      continue;
    }
    const lifted = liftBlankWrapperItem(first);
    if (lifted) {
      normalized = [...lifted, ...normalized.slice(1)];
      continue;
    }
    break;
  }
  return normalized;
}

function liftBlankWrapperItem(item: ProseMirrorNode): ProseMirrorNode[] | null {
  if (item.childCount === 0) return null;
  const last = item.child(item.childCount - 1);
  if (last.type.name !== 'list') return null;
  for (let i = 0; i < item.childCount - 1; i++) {
    const child = item.child(i);
    if (child.type.name !== 'paragraph' || child.content.size > 0) return null;
  }
  return listItemsOf(last);
}

function buildMixedSiblingSpliceTr(
  state: EditorState,
  docNode: ProseMirrorNode,
): Transaction | null {
  const { selection } = state;
  if (!selection.empty) return null;
  if (docNode.content.childCount === 0) return null;

  let hasNonList = false;
  docNode.content.forEach((child) => {
    if (child.type.name !== 'list') hasNonList = true;
  });
  if (!hasNonList) return null;

  const { $from } = selection;
  if (!$from.parent.isTextblock) return null;

  let listDepth = -1;
  for (let depth = 1; depth <= $from.depth; depth++) {
    if ($from.node(depth).type.name === 'list') {
      listDepth = depth;
      break;
    }
  }
  if (listDepth < 0) return null;
  for (let depth = listDepth; depth < $from.depth; depth++) {
    const name = $from.node(depth).type.name;
    if (name !== 'list' && name !== 'listItem') return null;
  }
  if ($from.node($from.depth - 1)?.type.name !== 'listItem') return null;

  const listNode = $from.node(listDepth);
  const listStart = $from.before(listDepth);
  const listEnd = $from.after(listDepth);
  const offset = $from.pos - $from.start(listDepth);
  const beforeHalf = pruneTrailingCutBlanks(listNode.cut(0, offset));
  const beforeItems = beforeHalf ? listItemsOf(beforeHalf) : [];
  const afterItems = normalizeLeadingCutItems(listItemsOf(listNode.cut(offset)));

  const children: ProseMirrorNode[] = [];
  docNode.content.forEach((child) => {
    children.push(child);
  });
  let lead = 0;
  while (lead < children.length && children[lead].type.name === 'list') lead++;
  let trail = children.length;
  while (trail > lead && children[trail - 1].type.name === 'list') trail--;
  const leadingLists = children.slice(0, lead);
  const middle = children.slice(lead, trail);
  const trailingLists = children.slice(trail);

  const out: ProseMirrorNode[] = [];
  if (beforeItems.length > 0) {
    out.push(
      listNode.copy(Fragment.fromArray([...beforeItems, ...leadingLists.flatMap(listItemsOf)])),
    );
  } else {
    out.push(...leadingLists);
  }
  out.push(...middle);
  if (afterItems.length > 0) {
    out.push(
      listNode.copy(Fragment.fromArray([...trailingLists.flatMap(listItemsOf), ...afterItems])),
    );
  } else {
    out.push(...trailingLists);
  }

  const tr = state.tr.replaceWith(listStart, listEnd, Fragment.fromArray(out));

  let caretPos = listStart;
  if (trailingLists.length > 0 && afterItems.length > 0) {
    for (let i = 0; i < out.length - 1; i++) caretPos += out[i].nodeSize;
    caretPos += 1;
    for (const list of trailingLists) {
      for (const item of listItemsOf(list)) caretPos += item.nodeSize;
    }
  } else {
    const lastPayloadIndex = out.length - 1 - (afterItems.length > 0 ? 1 : 0);
    for (let i = 0; i <= lastPayloadIndex; i++) caretPos += out[i].nodeSize;
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caretPos, tr.doc.content.size)), -1));
  return tr;
}

function applyJsonSlice(
  view: EditorView,
  json: JSONContent,
  source: ClipboardSource,
  branchLabel: ClipboardBranch,
  htmlBytes?: number,
): boolean {
  try {
    const node = view.state.schema.nodeFromJSON(json);
    let spliceTr: Transaction | null = null;
    try {
      spliceTr =
        buildListSiblingSpliceTr(view.state, node) ?? buildMixedSiblingSpliceTr(view.state, node);
    } catch {
      spliceTr = null;
    }
    const tr = spliceTr ?? view.state.tr.replaceSelection(node.slice(0, node.content.size));
    view.dispatch(tr.setMeta(PREVENT_AUTOLINK_META, true).scrollIntoView());
    return true;
  } catch (err) {
    logConversionFail({
      view: 'wysiwyg',
      stage: 'applyJsonSlice',
      source,
      branch: branchLabel,
      reason: (err as Error)?.message ?? 'unknown',
      errorClass: classifyError(err),
      ...(htmlBytes != null ? { htmlBytes } : {}),
    });
    notifyPasteDegraded('wysiwyg');
    return false;
  }
}
