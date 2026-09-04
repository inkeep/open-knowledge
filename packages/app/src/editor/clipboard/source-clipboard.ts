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
import { requestPreviewTabPromotion } from '../preview-tab-promotion.ts';
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

const SOURCE_PASTE_ORIGIN = Object.freeze({
  source: 'local' as const,
  skipStoreHooks: false,
  context: Object.freeze({ origin: 'source-paste' as const }),
});

export interface SourceClipboardDeps {
  ydoc: Y.Doc;
  ytext: Y.Text;
  docName: string;
}

export function createSourceClipboardExtension(deps: SourceClipboardDeps): Extension {
  installShiftTracker();
  return EditorView.domEventHandlers({
    copy: (event: ClipboardEvent, view: EditorView) => handleCopyOrCut(event, view, 'copy'),
    cut: (event: ClipboardEvent, view: EditorView) => handleCopyOrCut(event, view, 'cut'),
    paste: (event: ClipboardEvent, view: EditorView) => handlePaste(event, view, deps),
  });
}

export function buildSourceModeHtml(markdown: string): string {
  const pre = document.createElement('pre');
  pre.className = 'mdx-component';
  const code = document.createElement('code');
  code.textContent = markdown;
  pre.appendChild(code);
  return pre.outerHTML;
}

export function handleCopyOrCut(
  event: ClipboardEvent,
  view: EditorView,
  kind: 'copy' | 'cut',
): boolean {
  const { from, to } = view.state.selection.main;
  if (from === to) {
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
      view.dispatch({ changes: { from, to, insert: '' }, userEvent: 'delete.cut' });
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

  if (pasteShiftHeld(event)) {
    logSourceDetected({ view: 'source', branch: 'shift', source });
    logIfSlow(start, { op: 'paste', view: 'source', branch: 'shift', source });
    return false;
  }

  if (vscodeData && plain) {
    logSourceDetected({ view: 'source', branch: 'A', source });
    logIfSlow(start, { op: 'paste', view: 'source', branch: 'A', source });
    return false;
  }

  if (plain && html && isSourceModeHtmlWrapper(html)) {
    logSourceDetected({ view: 'source', branch: 'B-wrapper', source });
    logIfSlow(start, { op: 'paste', view: 'source', branch: 'B-wrapper', source });
    return false;
  }

  if (plain && html && isMarkdown(plain)) {
    logSourceDetected({ view: 'source', branch: 'B', source });
    logIfSlow(start, { op: 'paste', view: 'source', branch: 'B', source });
    return false;
  }

  if (html && /data-pm-slice/i.test(html)) {
    logSourceDetected({
      view: 'source',
      branch: 'C',
      source,
    });
    logIfSlow(start, { op: 'paste', view: 'source', branch: 'C', source });
    return false;
  }

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
  const shouldChunk = markdown.length > 500 * 1024;
  if (!shouldChunk) {
    view.dispatch({
      changes: { from, to, insert: markdown },
      selection: { anchor: from + markdown.length },
      userEvent: 'input.paste',
    });
    return true;
  }

  const restoreText = from === to ? '' : view.state.sliceDoc(from, to);
  if (from !== to) {
    view.dispatch({ changes: { from, to, insert: '' }, userEvent: 'input.paste' });
  }
  requestPreviewTabPromotion(deps.docName);
  const anchorIndex = from;
  const relPos = Y.createRelativePositionFromTypeIndex(deps.ytext, anchorIndex);

  const resolveOffset = (logical: number): number => {
    const abs = Y.createAbsolutePositionFromRelativePosition(relPos, deps.ydoc);
    if (abs == null) return logical;
    return abs.index + (logical - anchorIndex);
  };

  void chunkedYTextInsert(deps.ydoc, deps.ytext, anchorIndex, markdown, {
    resolveOffset,
    origin: SOURCE_PASTE_ORIGIN,
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

export interface ChunkedInsertFailureContext {
  view: EditorView;
  source: ClipboardSource;
  html: string;
  restoreText: string;
  anchorIndex: number;
  anchorRelPos?: Y.RelativePosition;
  ydoc?: Y.Doc;
  err: unknown;
}

export function handleChunkedInsertFailure(ctx: ChunkedInsertFailureContext): void {
  const { view, source, html, restoreText, anchorIndex, anchorRelPos, ydoc, err } = ctx;

  type RestoreOutcome = 'restored' | 'restore-failed' | 'no-restore-needed';
  let restoreOutcome: RestoreOutcome = 'no-restore-needed';
  if (err instanceof ChunkedInsertError && err.bytesWritten > 0) {
    const absStart =
      anchorRelPos && ydoc
        ? (Y.createAbsolutePositionFromRelativePosition(anchorRelPos, ydoc)?.index ?? anchorIndex)
        : anchorIndex;
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
    try {
      view.dispatch({ changes: { from: anchorIndex, to: anchorIndex, insert: restoreText } });
      restoreOutcome = 'restored';
    } catch (restoreErr) {
      console.warn('[clipboard] selection-restore dispatch failed', restoreErr);
      restoreOutcome = 'restore-failed';
    }
  }

  const restoreSuffix =
    restoreOutcome === 'restored'
      ? t` Your selection has been restored.`
      : restoreOutcome === 'restore-failed'
        ? t` Your selection could not be restored.`
        : '';

  if (err instanceof ChunkedInsertError) {
    logChunkedInsertFail({
      view: 'source',
      chunksCompleted: err.chunksCompleted,
      totalChunks: err.totalChunks,
      bytesWritten: err.bytesWritten,
      bytesRemaining: err.bytesRemaining,
      reason: err.message,
    });
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
