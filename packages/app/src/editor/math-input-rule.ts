import { Extension, InputRule } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { dispatchAsOwnUndoStep } from './undo-isolation';

const MATH_INLINE = 'mathInline';

const DOUBLE_DOLLAR_RE = /\$\$([^$\n]+)\$\$$/;

const SINGLE_DOLLAR_RE = /(?<![\w$])\$([^\s$\n](?:[^$\n]*[^\s$\n])?)\$$/;

type MatchedDelimiter = '$' | '$$';

interface MatchedMath {
  readonly formula: string;
  readonly delimiter: MatchedDelimiter;
  readonly literalLength: number;
}

function tryMatch(text: string, re: RegExp, delimiter: MatchedDelimiter): MatchedMath | null {
  const m = re.exec(text);
  if (!m) return null;
  const formula = m[1];
  if (!formula) return null;
  return {
    formula,
    delimiter,
    literalLength: m[0].length,
  };
}

function collapseToMath(view: EditorView, from: number, match: MatchedMath): void {
  if (view.isDestroyed || view.composing) return;
  const { state } = view;
  const nodeType = state.schema.nodes[MATH_INLINE];
  if (!nodeType) return;

  const to = from + match.literalLength;
  if (from < 0 || to > state.doc.content.size) return;
  const literal = `${match.delimiter}${match.formula}${match.delimiter}`;
  if (state.doc.textBetween(from, to) !== literal) return;

  let hasNonText = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !node.isText) hasNonText = true;
    return !hasNonText;
  });
  if (hasNonText) return;

  const atom = nodeType.create({
    formula: match.formula,
    sourceDelimiter: match.delimiter,
  });

  try {
    dispatchAsOwnUndoStep(view, state.tr.replaceRangeWith(from, to, atom));
  } catch (err) {
    console.warn(
      '[math-input-rule] collapse dispatch failed',
      { from, formula: match.formula, delimiter: match.delimiter },
      err,
    );
  }
}

function makeInputRule(editor: { view: EditorView }, re: RegExp, delimiter: MatchedDelimiter) {
  return new InputRule({
    find: re,
    handler: ({ state, range, match }) => {
      const parsed = tryMatch(match[0], re, delimiter);
      if (!parsed) return null;
      if (!state.schema.nodes[MATH_INLINE]) return null;

      const from = range.from;
      const view = editor.view;
      queueMicrotask(() => collapseToMath(view, from, parsed));
      return null;
    },
  });
}

export const MathInputRule = Extension.create({
  name: 'mathInputRule',

  addInputRules() {
    return [
      makeInputRule(this.editor, DOUBLE_DOLLAR_RE, '$$'),
      makeInputRule(this.editor, SINGLE_DOLLAR_RE, '$'),
    ];
  },
});
