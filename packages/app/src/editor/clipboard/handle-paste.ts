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
 * codeBlock short-circuit: cursor inside a codeBlock → skip all branches,
 * insert text/plain verbatim.
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
import type { EditorView } from '@tiptap/pm/view';
import { type ClipboardSource, detectSource } from './detect-source.ts';
import {
  type ClipboardBranch,
  classifyError,
  logConversionFail,
  logIfSlow,
  logSourceDetected,
} from './instrument.ts';
import { isMarkdown } from './is-markdown.ts';
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

function insertPlainText(view: EditorView, text: string): void {
  const { schema, tr } = view.state;
  if (!text) return;
  view.dispatch(tr.replaceSelectionWith(schema.text(text)).scrollIntoView());
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
    view.dispatch(view.state.tr.replaceSelectionWith(codeNode).scrollIntoView());
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
    return false;
  }
}

function tryBranchMarkdown(
  view: EditorView,
  markdown: string,
  deps: PasteDispatcherDeps,
  branchLabel: 'B' | 'E',
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

function applyJsonSlice(
  view: EditorView,
  json: JSONContent,
  source: ClipboardSource,
  branchLabel: ClipboardBranch,
  htmlBytes?: number,
): boolean {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: schema.nodeFromJSON accepts loose JSONContent at runtime; the public type is narrower than what's actually valid
    const node = view.state.schema.nodeFromJSON(json as any);
    view.dispatch(
      view.state.tr.replaceSelection(node.slice(0, node.content.size)).scrollIntoView(),
    );
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
    return false;
  }
}
