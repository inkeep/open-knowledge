/**
 * Source-view clipboard extension — `EditorView.domEventHandlers` for copy,
 * cut, and paste per precedent #19(c).
 *
 * CodeMirror 6 has no equivalent to PM's `clipboardTextSerializer` /
 * `clipboardSerializer` hooks, so we override the DOM events directly.
 * This is the only view where DOM-level override is acceptable (WYSIWYG
 * uses PM's hooks instead per precedent #19(b)). User-facing behavior is
 * symmetric across both views:
 *
 *   - Copy/cut write text/plain = markdown source AND text/html =
 *     source-shaped HTML wrapper (via `buildSourceModeHtml` — a
 *     `<pre class="mdx-component"><code>` envelope, NOT rendered output).
 *
 *   - Paste routes through a branch dispatcher parallel to WYSIWYG paste,
 *     except source-mode never upgrades editor-origin text into a fenced code
 *     block. Source's insertion IS markdown text, so the
 *     source-wrapper tiebreak (Branch B-wrapper), the markdown-first
 *     tiebreak (Branch B), the Branch C `data-pm-slice` check, and Branch E
 *     all resolve to "let CM6 default text/plain verbatim insert run";
 *     Branch D remains the converter for generic HTML.
 *     The dispatcher's value here is structural, not behavioral. The
 *     tiebreak fires AHEAD of Branch C and Branch D for the narrow case
 *     where external markdown carries a rich-HTML preview; without it
 *     Branch D's `htmlToMdast` would normalize bytes that the user pasted
 *     as canonical markdown.
 *
 *   - Cmd+Shift+V detected via `pasteShiftHeld(event)` (keyboard-event
 *     tracker — ClipboardEvent does not expose shiftKey natively).
 *
 *   - Large-paste chunked insert: payloads >500KB bypass the CM6 dispatch
 *     and land via `chunkedYTextInsert` directly. A Y.RelativePosition is
 *     pinned before the first chunk so concurrent peers writing at offsets
 *     ≤ writeIndex during rAF yields do not shift the target. Mid-stream
 *     failure surfaces as a structured `clipboard-chunked-insert-failed`
 *     event with partial-progress fields.
 */

import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  ChunkedInsertError,
  chunkedYTextInsert,
  htmlToMdast,
  mdastToMarkdown,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import * as Y from 'yjs';
import { type ClipboardSource, detectSource } from './detect-source.ts';
import {
  classifyError,
  logChunkedInsertFail,
  logConversionFail,
  logIfSlow,
  logSerializeFail,
  logSourceDetected,
} from './instrument.ts';
import { isMarkdown } from './is-markdown.ts';
import { installShiftTracker, pasteShiftHeld } from './shift-tracker.ts';

export interface SourceClipboardDeps {
  ydoc: Y.Doc;
  ytext: Y.Text;
}

/**
 * Build the CM6 extension wiring copy/cut/paste DOM handlers.
 *
 * Each handler returns `true` when it has fully handled the event
 * (preventing CM6's default), or `false` to let CM6's built-in run.
 */
export function createSourceClipboardExtension(deps: SourceClipboardDeps): Extension {
  // Attach the shift-key tracker so Cmd+Shift+V detection works. Calling
  // this eagerly ensures the listener is already in place when the first
  // paste event arrives.
  installShiftTracker();
  return EditorView.domEventHandlers({
    copy: (event: ClipboardEvent, view: EditorView) => handleCopyOrCut(event, view, 'copy'),
    cut: (event: ClipboardEvent, view: EditorView) => handleCopyOrCut(event, view, 'cut'),
    paste: (event: ClipboardEvent, view: EditorView) => handlePaste(event, view, deps),
  });
}

/**
 * Build the source-mode `text/html` payload — a single
 * `<pre class="mdx-component"><code>{markdown}</code></pre>` wrapper around
 * the raw markdown bytes. Source-mode never emits rendered-output HTML;
 * cross-app destinations always see the source the user is viewing,
 * consistent with VS Code, Obsidian source mode, GitHub textarea, and
 * CM6's default copy behavior.
 *
 * DOM-construction with `code.textContent = markdown` produces a textNode
 * child rather than parsed HTML — so the bytes that matter for HTML
 * injection (`<` / `>` / `&`) are auto-escaped on serialization, and
 * quote characters (`"` / `'`) survive verbatim because they're not
 * special inside textNode content. The markdown source therefore lands
 * in the destination clipboard without HTML-injection risk. Mirrors the
 * same safety pattern used by the live walker and the fallback palette
 * for non-portable-URL source-fallback shapes, so all three paths share
 * one escape mechanism (no manual escapeHtml).
 *
 * Exported for the unit tests in `source-clipboard.test.ts` — the
 * wrapper output is asserted against a fake `globalThis.document` that
 * replicates HTML5 textContent escape semantics.
 */
export function buildSourceModeHtml(markdown: string): string {
  const pre = document.createElement('pre');
  pre.className = 'mdx-component';
  const code = document.createElement('code');
  code.textContent = markdown;
  pre.appendChild(code);
  return pre.outerHTML;
}

/**
 * Source-view copy/cut handler. Empty-selection branch suppresses CM6's
 * default line-copy behavior without writing anything to the clipboard —
 * preserves "clipboard unchanged" semantics. Non-empty branch writes
 * `text/plain` (raw markdown bytes) AND `text/html` (source-shaped
 * wrapper); the wrapper builder runs inside a try/catch so a failure in
 * the wrapper doesn't block the `text/plain` write the user actually
 * depends on.
 *
 * Exported for the unit tests in `source-clipboard.test.ts` — the
 * empty-selection no-op and the wrapper integration with `dt.setData`
 * are asserted against fake EditorView + DataTransfer surfaces.
 */
export function handleCopyOrCut(
  event: ClipboardEvent,
  view: EditorView,
  kind: 'copy' | 'cut',
): boolean {
  const { from, to } = view.state.selection.main;
  if (from === to) {
    // Empty-selection copy/cut is a no-op (no MIME mutation). Without
    // preventDefault(), CM6's built-in copy handler falls back to copying the
    // ENTIRE current line — user-visible clipboard mutation that breaks the
    // "clipboard unchanged when nothing is selected" expectation. Claim the
    // event to suppress CM6's line-copy behavior without writing anything
    // ourselves.
    event.preventDefault();
    return true;
  }

  const dt = event.clipboardData;
  if (!dt) return false;

  const start = performance.now();
  try {
    const markdown = view.state.sliceDoc(from, to);
    dt.setData('text/plain', markdown);
    try {
      dt.setData('text/html', buildSourceModeHtml(markdown));
    } catch (err) {
      logSerializeFail({
        view: 'source',
        kind: 'html',
        reason: (err as Error)?.message ?? 'unknown',
      });
    }
    event.preventDefault();
    if (kind === 'cut') {
      view.dispatch({ changes: { from, to, insert: '' } });
    }
    logIfSlow(start, { op: kind, view: 'source', branch: 'serialize', source: 'local' });
    return true;
  } catch (err) {
    logSerializeFail({
      view: 'source',
      kind: 'text',
      reason: (err as Error)?.message ?? 'unknown',
    });
    return false;
  }
}

/**
 * Source-view paste handler. Exported for `source-clipboard.test.ts` so the
 * branch-return contract can be covered without constructing a full CM6 view.
 */
export function handlePaste(
  event: ClipboardEvent,
  view: EditorView,
  deps: SourceClipboardDeps,
): boolean {
  const dt = event.clipboardData;
  if (!dt || dt.types.length === 0) return false;

  const start = performance.now();
  const source = detectSource(dt);
  const plain = dt.getData('text/plain');
  const html = dt.getData('text/html');
  const vscodeData = dt.getData('vscode-editor-data');

  // Cmd+Shift+V → let CM6 default text/plain verbatim insert run.
  if (pasteShiftHeld(event)) {
    logSourceDetected({ view: 'source', branch: 'shift', source });
    logIfSlow(start, { op: 'paste', view: 'source', branch: 'shift', source });
    return false;
  }

  // Source-mode paste is already markdown/source text. Editor-origin
  // clipboards use `vscode-editor-data` to describe syntax, but converting
  // that payload into a fenced block would mutate the bytes the user sees.
  if (vscodeData && plain) {
    logSourceDetected({ view: 'source', branch: 'A', source });
    logIfSlow(start, { op: 'paste', view: 'source', branch: 'A', source });
    return false;
  }

  // Source-mode and source-fallback copy paths encode the user's markdown
  // bytes in text/plain and mirror them into a <pre><code> HTML wrapper for
  // cross-app interoperability. In source mode, converting that wrapper
  // through Branch D would reinterpret plain prose as a fenced code block.
  if (plain && html && isSourceModeHtmlWrapper(html)) {
    logSourceDetected({ view: 'source', branch: 'B-wrapper', source });
    logIfSlow(start, { op: 'paste', view: 'source', branch: 'B-wrapper', source });
    return false;
  }

  // Markdown-first tiebreak: both text/plain (markdown-shaped) AND text/html
  // present. Source's insertion IS markdown, so let CM6 default text/plain
  // verbatim insert run. Runs ahead of Branch C (data-pm-slice) and Branch
  // D (htmlToMdast) so external markdown-with-rich-HTML-preview pastes
  // preserve the canonical text/plain bytes instead of being normalized
  // through the htmlToMdast cleanup pipeline.
  if (plain && html && isMarkdown(plain)) {
    logSourceDetected({ view: 'source', branch: 'B', source });
    logIfSlow(start, { op: 'paste', view: 'source', branch: 'B', source });
    return false;
  }

  // Branch C: PM-origin slice — the data-pm-slice wrapper's inner content
  // is the canonical markdown (because our copy path wrote HTML from the
  // same markdown the text/plain carries). Let CM6 default insert the
  // text/plain verbatim.
  if (html && /data-pm-slice/i.test(html)) {
    logSourceDetected({
      view: 'source',
      branch: 'C',
      source,
    });
    logIfSlow(start, { op: 'paste', view: 'source', branch: 'C', source });
    return false;
  }

  // Branch D: generic HTML → htmlToMdast → markdown string → Y.Text insert.
  if (html) {
    const handled = tryBranchDHtml(view, html, deps, source);
    if (handled) {
      event.preventDefault();
      logSourceDetected({
        view: 'source',
        branch: 'D',
        source,
      });
      logIfSlow(start, {
        op: 'paste',
        view: 'source',
        branch: 'D',
        source,
        htmlBytes: html.length,
      });
      return true;
    }
  }

  // Branch E: text/plain only — CM6 default insert. Source's insertion IS
  // markdown, so no conversion needed.
  logSourceDetected({ view: 'source', branch: 'E', source });
  logIfSlow(start, { op: 'paste', view: 'source', branch: 'E', source });
  return false;
}

const SOURCE_MODE_HTML_WRAPPER_RE =
  /<pre\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bmdx-component\b[^"']*["'])[^>]*>\s*<code\b/i;

function isSourceModeHtmlWrapper(html: string): boolean {
  return SOURCE_MODE_HTML_WRAPPER_RE.test(html);
}

function tryBranchDHtml(
  view: EditorView,
  html: string,
  deps: SourceClipboardDeps,
  source: ClipboardSource,
): boolean {
  let mdast: ReturnType<typeof htmlToMdast>;
  try {
    mdast = htmlToMdast(html);
  } catch (err) {
    logConversionFail({
      view: 'source',
      stage: 'htmlToMdast',
      source,
      branch: 'D',
      reason: (err as Error)?.message ?? 'unknown',
      errorClass: classifyError(err),
      htmlBytes: html.length,
    });
    return false;
  }
  let markdown: string;
  try {
    markdown = mdastToMarkdown(mdast);
  } catch (err) {
    logConversionFail({
      view: 'source',
      stage: 'mdastToMarkdown',
      source,
      branch: 'D',
      reason: (err as Error)?.message ?? 'unknown',
      errorClass: classifyError(err),
      htmlBytes: html.length,
    });
    return false;
  }
  const { from, to } = view.state.selection.main;
  // For small inserts, let CM6's dispatch handle the Y.Text mutation via
  // the yCollab binding. Above the chunk threshold below, bypass the CM6
  // path and chunk directly into Y.Text — yCollab observes Y.Text changes
  // and mirrors them into CM6, so the view catches up.
  const shouldChunk = markdown.length > 500 * 1024;
  if (!shouldChunk) {
    view.dispatch({
      changes: { from, to, insert: markdown },
      selection: { anchor: from + markdown.length },
    });
    return true;
  }

  // Chunked path: delete the selection first (single CM6 dispatch) then
  // append via chunked Y.Text insertion. rAF yields keep the UI 60fps.
  // Y.RelativePosition tracks the intended write anchor so a concurrent
  // peer inserting before the anchor during a yield does not shift us.
  //
  // Recovery discipline: capture the original selection text BEFORE the
  // delete dispatch so `handleChunkedInsertFailure` can restore it if the
  // chunked insertion throws mid-stream. Without this, chunk-0 failure
  // would leave the user's selection vanished with only a DevTools log.
  // The captured `relPos` also bounds the partial-chunk rollback range so a
  // mid-stream throw after N chunks wrote doesn't leave truncated content
  // behind — see `handleChunkedInsertFailure` below.
  const restoreText = from === to ? '' : view.state.sliceDoc(from, to);
  if (from !== to) {
    view.dispatch({ changes: { from, to, insert: '' } });
  }
  const anchorIndex = from;
  // `assoc = 0` (default) is left-binding: concurrent inserts AT anchorIndex
  // leave our anchor at the original spot, so their content lands AFTER our
  // chunks. This matches the intuitive "my paste goes where my cursor was,
  // their concurrent edits follow" semantic. Right-binding (`assoc = 1`)
  // would flip this — revisit only with explicit product direction.
  const relPos = Y.createRelativePositionFromTypeIndex(deps.ytext, anchorIndex);

  const resolveOffset = (logical: number): number => {
    // `logical` is the monotonic chunk writeIndex counted from anchorIndex.
    // Resolve anchorIndex against current Y.Text state, then add the local
    // offset within our insert sequence.
    const abs = Y.createAbsolutePositionFromRelativePosition(relPos, deps.ydoc);
    if (abs == null) return logical; // fall back to the monotonic index.
    return abs.index + (logical - anchorIndex);
  };

  // Fire-and-forget — the Promise resolves as chunks land, but paste
  // event handler must return synchronously. yCollab surfaces the
  // inserts incrementally.
  void chunkedYTextInsert(deps.ydoc, deps.ytext, anchorIndex, markdown, {
    resolveOffset,
  }).catch((err) => {
    handleChunkedInsertFailure({
      view,
      source,
      html,
      restoreText,
      anchorIndex,
      anchorRelPos: relPos,
      ydoc: deps.ydoc,
      err,
    });
  });
  return true;
}

/**
 * Recovery for a mid-stream chunked-insert failure. Three concerns:
 *
 * 1. Rollback partial chunks + restore selection: chunked insertion writes
 *    N of M chunks before throwing, leaving `bytesWritten` bytes in Y.Text
 *    at `[anchor, anchor+bytesWritten)`. Without cleanup, the user's selection
 *    is gone AND truncated paste content is in the doc. We resolve the
 *    captured `anchorRelPos` (pinned before chunk-0 so concurrent peers
 *    between paste-start and failure-time don't shift the range) and replace
 *    `[absStart, absStart+bytesWritten)` with `restoreText` in a single
 *    `view.dispatch` — atomic from yCollab's observer perspective.
 * 2. Telemetry: emit a structured event (typed `ChunkedInsertError` variant
 *    with partial-progress fields; fallback to `clipboard-html-conversion-failed`
 *    for non-chunked errors).
 * 3. User-visible signal: a sonner toast so the user knows the paste failed
 *    rather than relying on DevTools to spot the console.warn.
 *
 * Non-typed errors (not `ChunkedInsertError`) can't know `bytesWritten`, so
 * we fall back to the simpler selection-restore path — same behavior as
 * before this fix for those exotic failure modes.
 *
 * Exported for the unit test (`source-clipboard-recovery.test.ts`) so the
 * recovery contract is mechanically covered even though the full CM6 paste
 * integration is out of reach for bun-test.
 */
export interface ChunkedInsertFailureContext {
  view: EditorView;
  source: ClipboardSource;
  html: string;
  /** Original selection text, or '' if the selection was empty. */
  restoreText: string;
  /** CM6/Y.Text offset where the first chunk was written. */
  anchorIndex: number;
  /**
   * Y.RelativePosition captured pre-chunk-0. Used at recovery time to resolve
   * the partial-paste start position through concurrent peer activity so the
   * delete range targets the right bytes. Optional for legacy tests that
   * predate the rollback discipline.
   */
  anchorRelPos?: Y.RelativePosition;
  /** Y.Doc for resolving the relative position. Optional for the same reason. */
  ydoc?: Y.Doc;
  err: unknown;
}

export function handleChunkedInsertFailure(ctx: ChunkedInsertFailureContext): void {
  const { view, source, html, restoreText, anchorIndex, anchorRelPos, ydoc, err } = ctx;

  // 1. Rollback + restore. If we know bytesWritten (ChunkedInsertError) we
  //    delete the partial range; otherwise we restore the selection at the
  //    anchor (best effort). Track the outcome so the user-visible toast
  //    reflects whether restoration actually succeeded — claiming "selection
  //    restored" when the dispatch threw (view destroyed by Activity-hidden
  //    unmount, Y.Doc GC'd) silently masks user-visible data loss.
  type RestoreOutcome = 'restored' | 'restore-failed' | 'no-restore-needed';
  let restoreOutcome: RestoreOutcome = 'no-restore-needed';
  if (err instanceof ChunkedInsertError && err.bytesWritten > 0) {
    const absStart =
      anchorRelPos && ydoc
        ? (Y.createAbsolutePositionFromRelativePosition(anchorRelPos, ydoc)?.index ?? anchorIndex)
        : anchorIndex;
    // Clamp end to current doc length — concurrent peers may have deleted
    // some of our partial content before we recovered.
    const deleteEnd = Math.min(absStart + err.bytesWritten, view.state.doc.length);
    try {
      view.dispatch({
        changes: { from: absStart, to: deleteEnd, insert: restoreText },
      });
      restoreOutcome = restoreText.length > 0 ? 'restored' : 'no-restore-needed';
    } catch (restoreErr) {
      console.warn('[clipboard] partial-chunk rollback dispatch failed', restoreErr);
      restoreOutcome = restoreText.length > 0 ? 'restore-failed' : 'no-restore-needed';
    }
  } else if (restoreText.length > 0) {
    // Non-typed error or zero bytes written — restore the user's selection
    // at the anchor. No partial range to delete.
    try {
      view.dispatch({ changes: { from: anchorIndex, to: anchorIndex, insert: restoreText } });
      restoreOutcome = 'restored';
    } catch (restoreErr) {
      // Restoration is best-effort — the view may be destroyed by the time
      // the promise settles. Log, then continue emitting the telemetry /
      // toast paths.
      console.warn('[clipboard] selection-restore dispatch failed', restoreErr);
      restoreOutcome = 'restore-failed';
    }
  }

  // Toast suffix mirrors the actual outcome of the restoration attempt.
  const restoreSuffix =
    restoreOutcome === 'restored'
      ? t` Your selection has been restored.`
      : restoreOutcome === 'restore-failed'
        ? t` Your selection could not be restored.`
        : '';

  // 2. Emit structured telemetry.
  if (err instanceof ChunkedInsertError) {
    logChunkedInsertFail({
      view: 'source',
      chunksCompleted: err.chunksCompleted,
      totalChunks: err.totalChunks,
      bytesWritten: err.bytesWritten,
      bytesRemaining: err.bytesRemaining,
      reason: err.message,
    });
    // 3. User-visible signal with partial-progress info.
    const chunksCompleted = err.chunksCompleted;
    const totalChunks = err.totalChunks;
    toast.error(
      t`Paste was incomplete — ${chunksCompleted} of ${totalChunks} chunks landed.${restoreSuffix}`,
    );
    return;
  }
  logConversionFail({
    view: 'source',
    stage: 'chunkedYTextInsert',
    source,
    branch: 'D',
    reason: (err as Error)?.message ?? 'unknown',
    errorClass: classifyError(err),
    htmlBytes: html.length,
  });
  toast.error(t`Paste failed.${restoreSuffix}`);
}
