/**
 * Typed `$$…$$` / `$…$` input rule for the WYSIWYG editor.
 *
 * When a local user closes a well-formed math literal by typing the final
 * delimiter, the raw text collapses to a `mathInline` PM atom carrying the
 * inner LaTeX as its `formula` attr. The atom's `sourceDelimiter` records
 * which delimiter (`$` vs `$$`) the user typed, so serialization replays the
 * same shape.
 *
 * Two regexes, both currency-safe:
 *
 *   1. `$$formula$$` — the double-delimiter form. Its literal `$$` bookends
 *      preclude the pandoc-style single-dollar ambiguity, so no lookbehind
 *      is needed. Matches single-line math only (content excludes `\n` and
 *      `$`); multi-line block math continues to arrive through the parse-time
 *      remark-math `$$\n…\n$$` route.
 *   2. `$formula$` — the pandoc-style single-delimiter form. The opening `$`
 *      must NOT be preceded by a word char / digit / another `$` (so `$5.00`,
 *      `foo$bar$`, `$$$` all stay untouched); the inner content must not have
 *      leading or trailing whitespace (so `$ x $` stays a literal price
 *      range, matching the parse-time single-dollar promoter's stance).
 *
 * Same undo-isolation contract as `inline-link-input-rule.ts`: the rule does
 * NOT consume the closing delimiter; it lets that char land through normal
 * typing, then a microtask later collapses the completed literal to a math
 * atom via `dispatchAsOwnUndoStep`. One Cmd+Z reverts just the collapse and
 * restores the escaped literal — the user can keep editing the source text
 * or retype the closing delimiter to re-collapse.
 *
 * Origin safety is inherited from InputRule's `handleTextInput` gating —
 * remote-peer / agent / disk / observer-echo writes bypass it entirely.
 */

import { Extension, InputRule } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { dispatchAsOwnUndoStep } from './undo-isolation';

const MATH_INLINE = 'mathInline';

/** `$$formula$$` at the caret. Content: one+ non-`$` non-`\n`. */
const DOUBLE_DOLLAR_RE = /\$\$([^$\n]+)\$\$$/;

/** `$formula$` at the caret. Opening `$` must NOT be preceded by a word/digit/
 *  another `$` (currency-safe); content must not lead or trail with whitespace
 *  (pandoc-style — `$ foo $` isn't math). Enforces content length ≥ 1 via the
 *  `[^\s$\n]` core (with an optional inner span that may include internal
 *  whitespace like `$a + b$`). */
const SINGLE_DOLLAR_RE = /(?<![\w$])\$([^\s$\n](?:[^$\n]*[^\s$\n])?)\$$/;

type MatchedDelimiter = '$' | '$$';

interface MatchedMath {
  readonly formula: string;
  readonly delimiter: MatchedDelimiter;
  /** Full literal length INCLUDING both delimiters — `formula.length + 2 * delimiter.length`. */
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

/**
 * Collapse `<delim>formula<delim>` (already complete in the doc, including the
 * just-typed closing delimiter) at `[from, from+len]` down to a `mathInline`
 * atom. Runs a microtask after the closing char landed, so it re-validates the
 * span first — the doc may have shifted or been rewritten in the gap.
 */
function collapseToMath(view: EditorView, from: number, match: MatchedMath): void {
  if (view.isDestroyed || view.composing) return;
  const { state } = view;
  const nodeType = state.schema.nodes[MATH_INLINE];
  if (!nodeType) return;

  const to = from + match.literalLength;
  if (from < 0 || to > state.doc.content.size) return;
  const literal = `${match.delimiter}${match.formula}${match.delimiter}`;
  if (state.doc.textBetween(from, to) !== literal) return;

  // Refuse to collapse if the range contains a non-text inline child (a
  // sibling atom, image, etc.) — the regex only inspects textBetween's flat
  // string projection, so a mixed-content match would silently swallow the
  // sibling atom.
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

  // Own undo step so one Cmd+Z reverts JUST the collapse, restoring the raw
  // `$$…$$` literal. Only the dispatch is guarded — it crosses into third-
  // party plugin hooks; the guards above are internal-trusted and fail loud.
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
    // Returning null (no steps) means TipTap does not consume the match:
    // the closing delimiter char inserts through the normal path and the
    // deferred collapse below does the math-ification. Code-block / inline-
    // code contexts are already refused upstream by TipTap's input-rule
    // runner.
    handler: ({ state, range, match }) => {
      const parsed = tryMatch(match[0], re, delimiter);
      if (!parsed) return null;
      if (!state.schema.nodes[MATH_INLINE]) return null;

      // range.from is the start of the opening delimiter in the pre-close-
      // char doc; positions before the caret are stable across the closing
      // char's insertion, so the completed literal spans
      // [range.from, range.from + literalLength].
      const from = range.from;
      // Capture the view eagerly: input rules fire from handleTextInput (the
      // view is mounted here), while `editor.view` re-read inside the
      // microtask is a throwing proxy if a recycle starts in the gap.
      // collapseToMath's isDestroyed guard covers teardown after capture.
      const view = editor.view;
      queueMicrotask(() => collapseToMath(view, from, parsed));
      return null;
    },
  });
}

export const MathInputRule = Extension.create({
  name: 'mathInputRule',

  addInputRules() {
    // Order matters: the `$$…$$` rule runs FIRST because both regexes would
    // fire on `$$…$$` (the single-dollar rule sees the trailing `$…$` slice),
    // and TipTap runs input rules in declaration order until one matches.
    return [
      makeInputRule(this.editor, DOUBLE_DOLLAR_RE, '$$'),
      makeInputRule(this.editor, SINGLE_DOLLAR_RE, '$'),
    ];
  },
});
