
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

function insertPlainText(view: EditorView, text: string): void {
  const { schema, tr } = view.state;
  if (!text) return;
  view.dispatch(tr.replaceSelectionWith(schema.text(text)).scrollIntoView());
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
