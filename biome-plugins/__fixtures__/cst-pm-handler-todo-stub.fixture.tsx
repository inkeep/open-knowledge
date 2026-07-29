// FIXTURE - drives `cst-pm-handler-todo-stub.test.ts` via shell-out
// to `pnpm exec biome check`. Not part of the main lint (override scope keeps
// the rule off this fixture's path under normal `pnpm run lint`; the test
// explicitly invokes biome on this file path).
//
// 4 positive cases (deliberate codemod-stub bodies — plugin must fire) +
// 4 negative cases (filled-in bodies + non-handler error throws that must
// NOT fire). Exact-equality (`toBe(4)`) in the test catches both
// false-negative regressions (drop below 4) and false-positive widenings
// (above 4).
//
// Parameters are prefixed with `_` per the TS / biome convention for
// intentionally unused — the rule scopes to the throw-statement shape,
// not parameter usage. The codemod's emitted stubs name params `node`
// without the underscore; in real substrate adapters those names will
// be referenced once the body is filled in.

// === Positive cases — codemod-emitted stubs that must fire ===

// (1) Single-quoted message - the codemod's `JSON.stringify(...)` output
//     renders as a double-quoted literal in TS source. Single-quoted here
//     covers the prettier-rewritten / hand-edited variant.
export function handleParagraph(_node: unknown): unknown {
  throw new Error('TODO: implement micromark-event-fold:mdast-to-pm/paragraph');
}

// (2) Double-quoted message — the codemod's emitted shape verbatim.
// biome-ignore lint/style/useSingleQuote: fixture covers both quote styles
export function handleHeading(_node: unknown): unknown {
  throw new Error("TODO: implement micromark-event-fold:mdast-to-pm/heading");
}

// (3) Template-literal message — the third quote style; still a TODO stub.
export function handleStrong(_node: unknown): unknown {
  throw new Error(`TODO: implement micromark-event-fold:pm-to-mdast-mark/strong`);
}

// (4) Stub for a different substrate id — pattern is substrate-agnostic.
export function handleEmphasis(_node: unknown): unknown {
  throw new Error('TODO: implement lezer-markdown-derived:pm-to-mdast-mark/emphasis');
}

// === Negative cases — implemented handlers + unrelated throws ===

// (1) A filled-in handler that does real work — must NOT fire.
export function handleBlockquote(node: unknown): unknown {
  return { type: 'blockquote', content: [node] };
}

// (2) An error thrown for a legitimate runtime contract violation — must
//     NOT fire. Message doesn't start with the codemod's `TODO: implement`
//     marker.
export function handleCodeBlock(node: unknown): unknown {
  if (typeof node !== 'object' || node === null) {
    throw new Error('handleCodeBlock: expected mdast code node, got non-object');
  }
  return { type: 'codeBlock', content: [] };
}

// (3) An error thrown via a different constructor — must NOT fire.
//     The rule only matches `Error` (the JS built-in) by name.
class HandlerSubstrateError extends Error {}
export function handleListItem(_node: unknown): unknown {
  throw new HandlerSubstrateError('TODO: implement list item handler');
}

// (4) An error whose message MENTIONS "TODO" inline but doesn't start with
//     `TODO: implement` — the rule's regex is anchored. Must NOT fire.
export function handleTable(_node: unknown): unknown {
  throw new Error('Failed to handle table (TODO: revisit after column-align support lands)');
}
