/**
 * Typed-URL autolink for the WYSIWYG editor.
 *
 * When a local user finishes a GFM-shape URL token and types a word boundary
 * (space or Enter), the token becomes a link mark carrying
 * `linkStyle: 'gfm-autolink'` so it serializes as a bare literal rather than
 * `[url](url)`. Detection reuses stock TipTap's changed-range / last-word scan
 * but swaps linkify's tokenizer for the GFM-parity recognizer, so only what the
 * markdown pipeline itself would linkify ever converts.
 *
 * Two properties keep this safe in OK's multi-writer CRDT, and both are
 * structural rather than conventional:
 *
 *  - Origin guard. Peer, agent, disk-load, and observer-echo edits re-enter the
 *    editor as ProseMirror transactions tagged with `ySyncPluginKey` meta.
 *    Linkifying any of those would rewrite another writer's text across every
 *    connected client. The plugin skips the whole batch the moment any member
 *    carries that meta (fail-closed). A pooled, backgrounded editor also
 *    receives those updates and its provider is live even while hidden, so
 *    detection additionally requires the bound view to be the active/focused
 *    one — a stray local write into a hidden editor can never convert. This is
 *    the same `ySyncPluginKey` origin discipline as source-dirty-observer.ts.
 *
 *  - Undo isolation. The mark is added as its OWN ProseMirror dispatch a
 *    microtask after the typing flush, never returned from `appendTransaction`.
 *    Returning it would weld the mark and the keystroke into a single Yjs
 *    transaction — inseparable by any undo-manager setting — and Y.UndoManager
 *    would still merge separate transactions landing within its default
 *    `captureTimeout` (500 ms — Y.js's default, not OK config) into one
 *    stack item. The separate dispatch undoes the first
 *    weld; `stopCapturing()` immediately before AND after the dispatch undoes
 *    the second, so one Cmd+Z removes just the link (typed text intact) and
 *    the user's next keystrokes never merge into the mark's step. The deferral
 *    also lets the flush read `view.composing` (unreachable inside
 *    appendTransaction) and re-validate the target range, which may have moved
 *    or vanished in the gap.
 */

import type { LinkStyle } from '@inkeep/open-knowledge-core';
import {
  combineTransactionSteps,
  Extension,
  findChildrenInRange,
  getChangedRanges,
  getMarksBetween,
  type NodeWithPos,
} from '@tiptap/core';
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { detectGfmLinkToken } from './gfm-link-detector';
import { dispatchAsOwnUndoStep } from './undo-isolation';

// TipTap's UNICODE_WHITESPACE_PATTERN (@tiptap/extension-link), the class
// stock autolink word-splits on, so the boundary notion here agrees with the
// tokenizer this plugin descends from rather than JS `\s`, which omits some
// of these code points.
const WHITESPACE_CLASS = '\\u0000-\\u0020\\u00A0\\u1680\\u180E\\u2000-\\u2029\\u205F\\u3000';
const WHITESPACE_SPLIT = new RegExp(`[${WHITESPACE_CLASS}]`);
const TRAILING_WHITESPACE = new RegExp(`[${WHITESPACE_CLASS}]$`);

/** The mark this plugin creates and the fidelity attr that makes it serialize
 *  to a bare literal. Kept as constants so the flush and its tests agree. */
const LINK_MARK = 'link';
const GFM_AUTOLINK_STYLE: LinkStyle = 'gfm-autolink';

/** Meta key for suppressing autolink on a transaction (same string value
 *  TipTap's Link extension uses internally, but defined and exported HERE) —
 *  set by the Link mark's setLink/unsetLink commands and by the clipboard
 *  dispatcher, both of which manage their own link bytes. */
export const PREVENT_AUTOLINK_META = 'preventAutolink';

const gfmAutolinkPluginKey = new PluginKey('gfmAutolink');

interface LinkifyCandidate {
  from: number;
  to: number;
  href: string;
  /** The exact literal expected at [from, to] at dispatch time; a mismatch
   *  means the doc changed under us and the conversion is abandoned. */
  text: string;
}

interface GfmAutolinkPluginOptions {
  /**
   * Whether the bound editor is the one that should linkify. Defaults to DOM
   * focus, which is false for every pooled/background editor and true for the
   * foreground editor a user is typing into. Overridable so headless tests can
   * exercise the local-write path without driving real focus.
   */
  isActiveEditor?: (view: EditorView) => boolean;
}

function rangeHasCodeMark(view: EditorView, from: number, to: number): boolean {
  const codeMark = view.state.schema.marks.code;
  if (!codeMark) return false;
  return view.state.doc.rangeHasMark(from, to, codeMark);
}

/**
 * Scan the batch's changed ranges for a GFM-shape token that a just-typed word
 * boundary completed. Pure with respect to the document — it only reads state
 * and returns ranges; the caller performs the (deferred) mutation.
 */
function detectCandidates(
  oldState: EditorState,
  newState: EditorState,
  transactions: readonly Transaction[],
): LinkifyCandidate[] {
  const results: LinkifyCandidate[] = [];
  const transform = combineTransactionSteps(oldState.doc, [...transactions]);
  const changes = getChangedRanges(transform);

  for (const { newRange } of changes) {
    const nodesInChangedRanges = findChildrenInRange(
      newState.doc,
      newRange,
      (node) => node.isTextblock,
    );

    let textBlock: NodeWithPos | undefined;
    let textBeforeWhitespace: string | undefined;

    if (nodesInChangedRanges.length > 1) {
      // Enter split a block: scan the first block's whole text (the trailing
      // token now sits at its end). Stock takes this same ungated path.
      textBlock = nodesInChangedRanges[0];
      textBeforeWhitespace = newState.doc.textBetween(
        textBlock.pos,
        textBlock.pos + textBlock.node.nodeSize,
        undefined,
        ' ',
      );
    } else if (nodesInChangedRanges.length === 1) {
      // Single block: only fire when the change ends in whitespace — the "a
      // boundary key was just typed" signal.
      const endText = newState.doc.textBetween(newRange.from, newRange.to, ' ', ' ');
      if (!TRAILING_WHITESPACE.test(endText)) continue;
      textBlock = nodesInChangedRanges[0];
      textBeforeWhitespace = newState.doc.textBetween(textBlock.pos, newRange.to, undefined, ' ');
    }

    if (!textBlock || !textBeforeWhitespace) continue;
    // Code blocks are plain-text-only; never linkify inside one.
    if (textBlock.node.type.spec.code) continue;

    const words = textBeforeWhitespace.split(WHITESPACE_SPLIT).filter(Boolean);
    const lastWord = words[words.length - 1];
    if (!lastWord) continue;

    const detected = detectGfmLinkToken(lastWord);
    if (!detected) continue;

    // The recognizer head-anchors the linkified literal to the start of the
    // word, so the span is [wordStart, wordStart + text.length]. +1 crosses the
    // textblock's opening boundary into its content (stock's `link.start + 1`).
    const from = textBlock.pos + textBeforeWhitespace.lastIndexOf(lastWord) + 1;
    const to = from + detected.text.length;
    results.push({ from, to, href: detected.href, text: detected.text });
  }

  return results;
}

/**
 * The ProseMirror plugin, as a factory so `isActiveEditor` can be injected.
 * Tests drive it through the `GfmAutolink` extension (which threads
 * `isActiveEditor` via its options), so the factory stays module-private.
 */
function gfmAutolinkPlugin(options: GfmAutolinkPluginOptions = {}): Plugin {
  const isActiveEditor = options.isActiveEditor ?? ((view: EditorView) => view.hasFocus());

  let boundView: EditorView | null = null;
  let scheduled = false;
  const pending: LinkifyCandidate[] = [];

  const flush = (): void => {
    scheduled = false;
    const view = boundView;
    const candidates = pending.splice(0, pending.length);
    if (!view || view.isDestroyed) return;
    // No conversion mid-IME-composition, and never in a view that lost focus
    // between detection and this microtask.
    if (view.composing) return;
    if (!isActiveEditor(view)) return;

    const markType = view.state.schema.marks[LINK_MARK];
    if (!markType) return;

    let tr = view.state.tr;
    let changed = false;
    const docSize = view.state.doc.content.size;

    for (const candidate of candidates) {
      const { from, to, href, text } = candidate;
      // Re-validate: the doc may have shifted, shrunk, or been rewritten in the
      // gap. A range that no longer holds the exact detected literal is stale.
      if (from < 0 || to > docSize || from >= to) continue;
      if (view.state.doc.textBetween(from, to) !== text) continue;
      // Skip if the span is already linked or lives inside inline code.
      if (getMarksBetween(from, to, view.state.doc).some((m) => m.mark.type === markType)) continue;
      if (rangeHasCodeMark(view, from, to)) continue;

      tr = tr.addMark(from, to, markType.create({ href, linkStyle: GFM_AUTOLINK_STYLE }));
      changed = true;
    }

    if (!changed) return;
    // Tag our own mark-add so re-entering appendTransaction skips it.
    tr = tr.setMeta(PREVENT_AUTOLINK_META, true);

    // The typing that triggered detection is < captureTimeout old, so the
    // mark-add must land as its own undo stack item (see undo-isolation.ts
    // for the split-before/close-after contract). flush() runs as a bare
    // microtask — an escaping throw would be an uncaught async error and the
    // conversion would just vanish, so degrade like the clipboard dispatcher:
    // log and drop this batch (the typed text itself is untouched).
    try {
      dispatchAsOwnUndoStep(view, tr);
    } catch (err) {
      console.warn(
        '[gfm-autolink] linkify dispatch failed',
        { candidates: candidates.map((c) => ({ from: c.from, to: c.to, href: c.href })) },
        err,
      );
    }
  };

  return new Plugin({
    key: gfmAutolinkPluginKey,
    view(editorView) {
      boundView = editorView;
      return {
        destroy() {
          boundView = null;
          pending.length = 0;
          scheduled = false;
        },
      };
    },
    appendTransaction(transactions, oldState, newState) {
      // Fail-closed origin guard: any CRDT-sync-tagged transaction in the batch
      // (remote peer, agent, disk load, observer echo) disqualifies the whole
      // batch. Also honour explicit autolink suppression.
      if (transactions.some((tr) => tr.getMeta(ySyncPluginKey))) return null;
      if (transactions.some((tr) => tr.getMeta(PREVENT_AUTOLINK_META))) return null;

      const docChanged = transactions.some((tr) => tr.docChanged) && !oldState.doc.eq(newState.doc);
      if (!docChanged) return null;

      // Only the active/focused editor linkifies — closes the pooled-hidden-
      // editor local-write vector the origin guard alone can't see.
      if (!boundView || !isActiveEditor(boundView)) return null;

      const candidates = detectCandidates(oldState, newState, transactions);
      if (candidates.length === 0) return null;

      pending.push(...candidates);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
      // Never return the mark-add here — it must land as its own dispatch.
      return null;
    },
  });
}

export interface GfmAutolinkOptions {
  isActiveEditor?: (view: EditorView) => boolean;
}

/**
 * App editor extension wrapper. Registered only in the app's editor extension
 * list, never in the core/persistence set, so linkification stays a client-side
 * behavior of the interactive editor.
 */
export const GfmAutolink = Extension.create<GfmAutolinkOptions>({
  name: 'gfmAutolink',

  addOptions() {
    return {
      isActiveEditor: undefined,
    };
  },

  addProseMirrorPlugins() {
    return [gfmAutolinkPlugin({ isActiveEditor: this.options.isActiveEditor })];
  },
});
