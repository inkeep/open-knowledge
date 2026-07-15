/**
 * sourceLiteral — PM-level mark for text that must serialize verbatim.
 *
 * Used for markdown constructs that this editor cannot faithfully represent as
 * rich-text structure, or that the serializer would otherwise canonicalize to a
 * different byte form (for example, empty-label inline links like `[]()` or a
 * lone trailing backslash).
 * The marked text renders as ordinary text in the editor, but markdown
 * serialization reads `sourceRaw` and emits the exact source bytes.
 */

import { Mark } from '@tiptap/core';
import { decodeInlineWhitespaceNumericCharRefRun } from '../markdown/whitespace-char-ref.ts';

export const SourceLiteralMark = Mark.create({
  name: 'sourceLiteral',
  // Run after structural marks; this mark is a serialization hint and should
  // not win extension-order conflicts over user-visible formatting.
  priority: 10,
  excludes: '',
  inclusive: false,

  addAttributes() {
    return {
      sourceRaw: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-source-literal]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { 'data-source-literal': '', ...HTMLAttributes }, 0];
  },
});

/**
 * Verify that `sourceRaw` is a safe normalization of the mark's visible text.
 *
 * The sourceLiteral mark is a serialization hint: it lets the markdown writer
 * emit literal source bytes for constructs the editor cannot represent
 * losslessly (empty-label inline links, trailing backslash runs). Without a
 * consistency check, a caller that can mutate the PM document — agent API,
 * synced collaborator, clipboard paste of crafted `<span data-source-literal>`
 * — could store one byte sequence as the visible text and another, unrelated
 * sequence in `sourceRaw`. The user reviews / approves what the editor shows,
 * but the file persisted to disk is the attacker's bytes (HTML / scripts /
 * markdown that re-parses into different structure / prompt-injection content
 * for downstream LLMs).
 *
 * Legitimate divergence between visible text and raw is bounded to:
 *   - markdown backslash escapes (`\<punct>` in source → `<punct>` in value)
 *   - U+00A0 (NBSP) folded to U+0020 (SPACE) for comparison: a defensive
 *     acceptance of a benign NBSP-vs-space divergence (both are horizontal
 *     spacing). Parse no longer normalizes NBSP to space — a document NBSP now
 *     round-trips verbatim — so this fold only admits a benign paste/legacy
 *     divergence, never a structure-smuggling one.
 *   - an inline-whitespace numeric char-ref (`&#x20;` / `&#x9;` / `&#xA0;`) whose
 *     decoded codepoint IS the visible text: the byte-fidelity serializer mints
 *     these for a phrasing-boundary space/tab/NBSP, the editor shows the real
 *     whitespace char while `sourceRaw` keeps the exact bytes. Strictly scoped to
 *     inline whitespace — the decoded value can only ever be a single space, tab,
 *     or NBSP, so it cannot smuggle attacker-visible text (script, scheme,
 *     structure). This branch matches the decoded codepoint EXACTLY (unfolded),
 *     keeping it in lockstep with the mdast→PM decode.
 *
 * Newlines and other control characters are rejected outright: sourceLiteral
 * is an inline-only mark, so a control character in the raw bytes would by
 * definition smuggle structure the editor cannot have rendered.
 *
 * Callers that get `false` MUST fall back to the standard text-emission path
 * (which serializes the visible text with proper escaping). Round-trip
 * fidelity for that node is sacrificed; safety is not.
 */
export function isValidSourceLiteralRaw(sourceRaw: unknown, visibleText: unknown): boolean {
  if (typeof sourceRaw !== 'string' || typeof visibleText !== 'string') return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this is exactly the set we are rejecting.
  if (/[\x00-\x1F\x7F]/.test(sourceRaw)) return false;
  const normalizedRaw = sourceRaw.replaceAll(' ', ' ');
  const normalizedVisible = visibleText.replaceAll(' ', ' ');
  if (normalizedRaw === normalizedVisible) return true;
  if (stripMarkdownBackslashEscapes(normalizedRaw) === normalizedVisible) return true;
  // A run of inline-whitespace numeric char-refs displayed as its decoded
  // spaces/tabs/NBSPs. The decoded value is provably whitespace-only (each member
  // is a space, tab, or NBSP), so this divergence class cannot display innocuous
  // text while persisting attacker bytes. A run (not a single ref) is admitted
  // because the mdast→PM display decode coalesces contiguous boundary-whitespace
  // refs into one segment to dodge ProseMirror's equal-mark text-node merge.
  //
  // This branch compares the UNFOLDED bytes on both sides, unlike the two above:
  // the mdast→PM decode sets the display to exactly
  // decodeInlineWhitespaceNumericCharRefRun(raw) (an NBSP for `&#xA0;`, a space
  // for `&#x20;`), so the gate must match that same decoded codepoint. Folding
  // NBSP→space here would reject a legitimate `&#xA0;`/NBSP pair while the direct
  // branch above still admits the benign literal-NBSP↔space divergence.
  return decodeInlineWhitespaceNumericCharRefRun(sourceRaw) === visibleText;
}

/**
 * Collapse `\<punct>` escape pairs to `<punct>`, mirroring how the markdown
 * parser turns source bytes into mdast text values. A trailing lone backslash
 * (no following character) is preserved literally. Only ASCII punctuation is
 * recognized as the escapable set, matching CommonMark §2.4.
 */
function stripMarkdownBackslashEscapes(s: string): string {
  // ASCII punctuation: ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
  return s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}
