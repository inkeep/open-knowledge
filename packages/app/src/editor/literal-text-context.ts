import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

/**
 * Single source of truth for "is this position/range a literal-text region" —
 * somewhere the characters on screen ARE the source, so the editor must never
 * convert what the user typed there.
 *
 * Two kinds of region qualify. Code is the familiar one: a `codeBlock` node or
 * an inline `code` mark. The other is raw MDX source: `jsxInline` (zero attrs,
 * no NodeView) and `rawMdxFallback` (carries `reason` / `originalSpan` attrs,
 * and a NodeView that sets `contenteditable: false`) both declare
 * `content: 'text*'` and hold their markdown source as plain text, so deleting
 * a character out of one edits the document's bytes directly.
 *
 * That `contenteditable: false` is why `rawMdxFallback` has no known path to a
 * picker today — keystrokes never reach it. It is covered here anyway, because
 * the predicate should follow the region's nature rather than the current
 * reachability of one route into it.
 *
 * `@tiptap/core`'s input-rule runner refuses inside code before any rule sees
 * the text, so every `addInputRules` surface inherits the code half for free.
 * Bare ProseMirror plugins (the GFM autolinker, the three `@tiptap/suggestion`
 * pickers) bypass that runner and must ask here instead. Keeping the clauses in
 * one place is what stops the surfaces from drifting apart — the pickers
 * shipped without any of it, and converted inside fences and inside inline JSX
 * by deleting the typed bytes out of them.
 *
 * Known gap, deliberately not papered over here: the upstream input-rule runner
 * tests `spec.code` only, so it is blind to the raw-source nodes. Closing that
 * belongs at the rule-runner seam, not in another consumer-side guard.
 */

/**
 * Nodes whose text content is its own markdown source.
 *
 * Structurally these are the nodes declaring `content: 'text*'` without
 * `spec.code`. They are listed by name rather than sniffed from that shape at
 * runtime, because the shape alone is too broad to be a safe predicate — a
 * future `content: 'text*'` node that is NOT raw source would be silently
 * opted in. A test enumerates the schema and fails if this list drifts.
 */
export const RAW_SOURCE_NODE_TYPES: readonly string[] = ['jsxInline', 'rawMdxFallback'];

/** A textblock whose content is plain text — `codeBlock` and friends. */
export function isCodeTextblock(node: PMNode): boolean {
  return node.type.spec.code === true;
}

/** Whether any part of `[from, to)` carries the inline `code` mark. */
export function rangeHasCodeMark(state: EditorState, from: number, to: number): boolean {
  const codeMark = state.schema.marks.code;
  if (!codeMark) return false;
  return state.doc.rangeHasMark(from, to, codeMark);
}

/** A node holding raw markdown source as its text content. */
function isRawSourceNode(node: PMNode): boolean {
  return RAW_SOURCE_NODE_TYPES.includes(node.type.name);
}

/**
 * Whether `[from, to)` sits in a literal-text region, by any clause: the
 * range's parent is a code textblock or a raw-source node, or the range
 * carries the inline `code` mark.
 */
export function isInLiteralTextContext(state: EditorState, from: number, to: number): boolean {
  const parent = state.doc.resolve(from).parent;
  if (isCodeTextblock(parent) || isRawSourceNode(parent)) return true;
  return rangeHasCodeMark(state, from, to);
}
