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

/**
 * Surface that triggered the dispatcher. `paste` reads `clipboardData` and
 * `pasteShiftHeld()`; `drop` reads `dataTransfer` and the DragEvent's own
 * `shiftKey`. Both run the same branch tree.
 */
type DispatchSurface = 'paste' | 'drop';

export function createHandlePaste(deps: PasteDispatcherDeps) {
  return (view: EditorView, event: ClipboardEvent): boolean =>
    handleDropOrPaste(view, event, 'paste', deps);
}

/**
 * Drop-side mirror of {@link createHandlePaste}. Same branch tree, same
 * telemetry, same shift-key behavior, with two surface-specific
 * differences:
 *
 *   1. Data lives on `event.dataTransfer`, not `event.clipboardData`.
 *   2. Shift state comes from the DragEvent itself (drag has explicit
 *      modifier flags via MouseEvent, unlike paste's keydown latch).
 *
 * Drag-from-Finder of files routes through FileHandler's `onDrop`
 * (`extensions/shared.ts`) — when `dataTransfer.files` is populated, the
 * dispatcher returns false so the file-upload path runs.
 */
export function createHandleDrop(deps: PasteDispatcherDeps) {
  return (view: EditorView, event: DragEvent): boolean => {
    // Drag-from-Finder / file-system drag: defer to FileHandler. PM calls
    // multiple handleDrop hooks in registration order; returning false
    // lets the next handler claim the event.
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

  // Cmd+Shift+V (paste) or shift-held drop → verbatim plain-text insert.
  // Replaces the dispatcher's auto-markdown routing so users can opt out
  // of source-form parsing on demand.
  if (isShiftHeldForSurface(event, surface)) {
    if (plain) insertPlainText(view, plain);
    logSourceDetected({ view: 'wysiwyg', branch: 'shift', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'shift', source });
    return true;
  }

  // Inside a codeBlock — plain-text verbatim.
  if (isCursorInCodeBlock(view)) {
    if (plain) insertPlainText(view, plain);
    logSourceDetected({ view: 'wysiwyg', branch: 'codeblock', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'codeblock', source });
    return true;
  }

  // Lone-URL step (see file header). Non-matching payloads fall through.
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

  // Private OK flavor: an OK-origin copy whose slice contained
  // clipboard-omitted content (comment annotations) carries the full
  // slice markdown here, because every public flavor ships scrubbed (see
  // comment-scrub.ts). Prefer it over the public flavors so OK→OK paste
  // restores the annotation regardless of which branch shape the public
  // payload would have taken. Runs after the shift/codeblock/lone-URL
  // gates so those explicit gestures keep their meaning.
  const internal = dt.getData(OK_INTERNAL_CLIPBOARD_MIME);
  if (internal && tryBranchMarkdown(view, internal, deps, 'internal', source)) {
    logSourceDetected({ view: 'wysiwyg', branch: 'internal', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'internal', source });
    return true;
  }

  // Branch A: VS Code with language metadata.
  const vscodeData = dt.getData('vscode-editor-data');
  if (vscodeData && plain && tryBranchA(view, vscodeData, plain, source)) {
    logSourceDetected({ view: 'wysiwyg', branch: 'A', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'A', source });
    return true;
  }

  // Branch B: explicit text/x-gfm MIME.
  const gfm = dt.getData('text/x-gfm');
  if (gfm && tryBranchMarkdown(view, gfm, deps, 'B', source)) {
    logSourceDetected({ view: 'wysiwyg', branch: 'B', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'B', source });
    return true;
  }

  // Markdown-first tiebreak: both text/plain (markdown-shaped) AND
  // text/html present. Runs ahead of Branch C so OK→OK and cross-PM-editor
  // paste preserves the canonical text/plain markdown bytes.
  if (plain && html && isMarkdown(plain) && tryBranchMarkdown(view, plain, deps, 'B', source)) {
    logSourceDetected({ view: 'wysiwyg', branch: 'B', source });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'B', source });
    return true;
  }

  // Branch C: PM-origin slice → let PM handle natively. Reached only when
  // the markdown-first tiebreak above did not fire (text/plain absent or
  // not markdown-shaped).
  if (html && /data-pm-slice/i.test(html)) {
    logSourceDetected({
      view: 'wysiwyg',
      branch: 'C',
      source,
    });
    logIfSlow(start, { op: surface, view: 'wysiwyg', branch: 'C', source });
    return false;
  }

  // Branch D: generic HTML → shared htmlToMdast pipeline.
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

  // Branch E: text/plain only — markdown-first if threshold hit, else
  // plain-text insert.
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
  // DragEvent extends MouseEvent so `shiftKey` is a real DOM property here
  // — no keydown-latch dance needed (in contrast to ClipboardEvent which
  // doesn't surface modifier flags at all in real browsers).
  return (event as DragEvent).shiftKey === true;
}

function isCursorInCodeBlock(view: EditorView): boolean {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    if ($from.node(depth).type.name === 'codeBlock') return true;
  }
  return false;
}

/**
 * Add a link mark across the current selection, keeping the selected text
 * (default `linkStyle` — serializes as `[selected text](url)`). Returns
 * false — fall through to the normal branch tree, i.e. plain replace — when
 * the selection isn't a single-textblock text selection, any of it carries
 * an inline code mark, or the schema has no link mark. A selection that
 * already carries a link keeps its text and gets the new href: pasting a
 * URL onto linked text means "re-point this link" everywhere else, and the
 * fall-through alternative would destroy the text outright.
 */
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
    // Same degradation contract as Branch D: tell the user, then fall through
    // (return false) so the normal branch tree delivers the clipboard content
    // as a standard paste. Claiming the paste here would drop the content
    // entirely — the one outcome the file header forbids.
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

// Narrow allowlist for fenced-code language idents so an attacker-controlled
// `vscode-editor-data.mode` cannot break out of the fence. Matches every
// language ident in our `codeLanguages` allowlist and then some.
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
  // Each stage has its own try block so the structured telemetry pinpoints
  // the failing pipeline component. A failure at any stage falls through
  // to the dispatcher's later branches (PM default text/plain parse via
  // clipboardTextParser) — user content is preserved but the rich-HTML
  // fidelity is lost. We emit a throttled user-visible toast so the
  // degradation is not silent.
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

/**
 * A list item is "blank" when it holds only empty paragraphs — no text, no
 * nested list, no other block. Splitting a target item at a caret sitting at
 * its very start or end yields one such blank half; the splice drops those so
 * no empty item is minted.
 */
function isBlankListItem(item: ProseMirrorNode): boolean {
  if (item.textContent.length > 0) return false;
  let onlyEmptyParagraphs = true;
  item.forEach((child) => {
    if (child.type.name !== 'paragraph' || child.content.size > 0) onlyEmptyParagraphs = false;
  });
  return onlyEmptyParagraphs;
}

/**
 * List-aware placement for OK→OK paste (#609 cause 1).
 *
 * `applyJsonSlice` normally inserts the re-parsed markdown as a CLOSED slice.
 * When the caret sits inside a list item and the pasted content is entirely
 * lists, that closed slice makes ProseMirror's fitter nest the pasted list as
 * a child of the target item (caret at item end) or mint a degenerate
 * empty-leading-paragraph + nested-list shape (caret at item start) — the
 * mis-placement users see as orphaned todo rows.
 *
 * Instead, split the target item at the caret and splice the pasted items in
 * between as SIBLINGS at the target item's own list level:
 * `[before-caret item if non-empty] + pasted items + [after-caret item if
 * non-empty]`. Whole list items are moved verbatim, so a pasted item's own
 * nested list rides along as its child and any container it holds (component,
 * table) is never opened.
 *
 * Returns a built transaction, or null to fall back to the closed-slice path:
 * a ranged (non-collapsed) selection, a caret not inside a list-item textblock,
 * or pasted content that is not purely lists all keep current behavior.
 */
function buildListSiblingSpliceTr(
  state: EditorState,
  docNode: ProseMirrorNode,
): Transaction | null {
  const { selection } = state;
  if (!selection.empty) return null;

  // Payload gate first (reads only the pasted doc): every top-level node must
  // be a list, else this is not the list-splice case.
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
  // A gap cursor (also "empty") can sit between blocks where the parent is the
  // list itself; the split math below assumes a caret inside the item's text.
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

/**
 * Drop blank items minted at the trailing cut edge, recursing into a
 * trailing nested list so a caret at the start of a nested item doesn't
 * leave an empty nested bullet behind. Returns null when the node empties
 * out entirely.
 */
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

/**
 * A leading cut edge can mint a wrapper item whose own text sits entirely
 * before the caret: empty paragraphs followed by a single nested list. Lift
 * that nested list's items up a level (no empty parent bullet) and drop
 * items the cut left fully blank.
 */
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

/**
 * List-aware placement for MIXED payloads — the issue #609 sibling-splice
 * intent extended beyond all-list payloads.
 *
 * A pasted doc holding at least one non-list top-level block, at a caret
 * inside a list item, must not be nested into that item (schema-legal for
 * the closed-slice fallback because `listItem` is `paragraph block*`, but a
 * structural demotion users read as the paste being swallowed). Instead the
 * OUTERMOST ancestor list splits at the caret and the payload lands where
 * typing it at top level would:
 *
 *   [before-half + leading payload list run] non-list blocks (and interior
 *   lists) verbatim [trailing payload list run + after-half]
 *
 * Leading/trailing payload list runs continue the list (item siblings,
 * keeping the original list node) exactly like the all-list splice; payload
 * lists with no original items to merge with are kept verbatim. Blank cut
 * halves are dropped per the all-list path's blank-item rule, and a nested
 * caret's remainder lifts to the top list level rather than minting an
 * empty parent bullet.
 *
 * Returns a built transaction, or null to fall back: ranged selection,
 * all-list payload (the item-level splice owns it), caret not inside a
 * plain list/listItem chain (tables etc. keep the closed-slice behavior).
 */
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

  // Outermost ancestor list: mixed payloads split the whole nesting stack so
  // non-list blocks escape to the list's own sibling level.
  let listDepth = -1;
  for (let depth = 1; depth <= $from.depth; depth++) {
    if ($from.node(depth).type.name === 'list') {
      listDepth = depth;
      break;
    }
  }
  if (listDepth < 0) return null;
  // Only split through plain list/listItem nesting; a caret inside another
  // container (table cell, blockquote) within an item keeps current behavior.
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

  // Caret lands at the end of the pasted content, mirroring the all-list
  // splice: after the last pasted item inside a merged trailing list, else
  // at the end of the last payload-derived node.
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
    // Scope the splice attempt so a throw in its position math degrades to the
    // proven closed-slice path below, not to the outer catch — which would
    // toast a degradation and hand the paste to PM's native fallthrough even
    // though the closed slice could have delivered it.
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
