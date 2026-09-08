// FIXTURE — drives `microcopy-ellipsis.test.ts` via shell-out to `pnpm exec oxlint`. Not part
// of the main lint: `__fixtures__/` is in `oxlint.config.ts#ignorePatterns`,
// and `__fixtures__/oxlint.fixtures.json` re-enables the rules for the test.
//
// Two positive cases (deliberate `…` in customer-facing strings — rule
// must fire) and three negative cases (no `…`, or `…` in a non-UI
// attribute — rule must NOT fire).
//
// If you add a new pattern to `rules/microcopy-ellipsis.mjs`, add a matching
// positive case here and raise the test's exact count.

export function PositiveJsxText() {
  return <span>Loading…</span>;
}

export function PositiveJsxAttributePlaceholder() {
  return <input placeholder="Search files…" />;
}

export function NegativeCleanText() {
  return <span>Loading</span>;
}

export function NegativeCleanAttribute() {
  return <input placeholder="Search files" />;
}

// Boundary negative — `data-raw` is NOT in the rule's UI-attribute filter
// list (placeholder | label | title | aria-label | description | tooltip).
// The rule must NOT fire even though the value contains …. If a future change
// removes the attribute-name filter, this case raises the count above 2 and
// `toBe(2)` catches the regression.
export function NegativeNonUiAttribute() {
  return <div data-raw="Loading…" />;
}
