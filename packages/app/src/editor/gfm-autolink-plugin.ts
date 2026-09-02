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
import { isUserIntentOrigin } from './extensions/autonomous-fragment-edit';
import { detectGfmLinkToken } from './gfm-link-detector';
import { isCodeTextblock, rangeHasCodeMark } from './literal-text-context';
import { dispatchAsOwnUndoStep } from './undo-isolation';

const WHITESPACE_CLASS = '\\u0000-\\u0020\\u00A0\\u1680\\u180E\\u2000-\\u2029\\u205F\\u3000';
const WHITESPACE_SPLIT = new RegExp(`[${WHITESPACE_CLASS}]`);
const TRAILING_WHITESPACE = new RegExp(`[${WHITESPACE_CLASS}]$`);

const LINK_MARK = 'link';
const GFM_AUTOLINK_STYLE: LinkStyle = 'gfm-autolink';

export const PREVENT_AUTOLINK_META = 'preventAutolink';

const gfmAutolinkPluginKey = new PluginKey('gfmAutolink');

interface LinkifyCandidate {
  from: number;
  to: number;
  href: string;
  text: string;
}

interface GfmAutolinkPluginOptions {
  isActiveEditor?: (view: EditorView) => boolean;
}

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
      textBlock = nodesInChangedRanges[0];
      textBeforeWhitespace = newState.doc.textBetween(
        textBlock.pos,
        textBlock.pos + textBlock.node.nodeSize,
        undefined,
        ' ',
      );
    } else if (nodesInChangedRanges.length === 1) {
      const endText = newState.doc.textBetween(newRange.from, newRange.to, ' ', ' ');
      if (!TRAILING_WHITESPACE.test(endText)) continue;
      textBlock = nodesInChangedRanges[0];
      textBeforeWhitespace = newState.doc.textBetween(textBlock.pos, newRange.to, undefined, ' ');
    }

    if (!textBlock || !textBeforeWhitespace) continue;
    if (isCodeTextblock(textBlock.node)) continue;

    const words = textBeforeWhitespace.split(WHITESPACE_SPLIT).filter(Boolean);
    const lastWord = words[words.length - 1];
    if (!lastWord) continue;

    const detected = detectGfmLinkToken(lastWord);
    if (!detected) continue;

    const from = textBlock.pos + textBeforeWhitespace.lastIndexOf(lastWord) + 1;
    const to = from + detected.text.length;
    results.push({ from, to, href: detected.href, text: detected.text });
  }

  return results;
}

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
    if (view.composing) return;
    if (!isActiveEditor(view)) return;

    const markType = view.state.schema.marks[LINK_MARK];
    if (!markType) return;

    let tr = view.state.tr;
    let changed = false;
    const docSize = view.state.doc.content.size;

    for (const candidate of candidates) {
      const { from, to, href, text } = candidate;
      if (from < 0 || to > docSize || from >= to) continue;
      if (view.state.doc.textBetween(from, to) !== text) continue;
      if (getMarksBetween(from, to, view.state.doc).some((m) => m.mark.type === markType)) continue;
      if (rangeHasCodeMark(view.state, from, to)) continue;

      tr = tr.addMark(from, to, markType.create({ href, linkStyle: GFM_AUTOLINK_STYLE }));
      changed = true;
    }

    if (!changed) return;
    tr = tr.setMeta(PREVENT_AUTOLINK_META, true);

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
      if (!transactions.every(isUserIntentOrigin)) return null;
      if (transactions.some((tr) => tr.getMeta(PREVENT_AUTOLINK_META))) return null;

      const docChanged = transactions.some((tr) => tr.docChanged) && !oldState.doc.eq(newState.doc);
      if (!docChanged) return null;

      if (!boundView || !isActiveEditor(boundView)) return null;

      const candidates = detectCandidates(oldState, newState, transactions);
      if (candidates.length === 0) return null;

      pending.push(...candidates);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
      return null;
    },
  });
}

export interface GfmAutolinkOptions {
  isActiveEditor?: (view: EditorView) => boolean;
}

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
