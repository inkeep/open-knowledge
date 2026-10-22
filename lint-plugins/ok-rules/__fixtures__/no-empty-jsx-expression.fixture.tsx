// FIXTURE: drives `no-empty-jsx-expression.uncached.test.ts` via shell-out to
// oxlint. Not part of the main lint: `__fixtures__/` is in
// `oxlint.config.ts#ignorePatterns`, and `__fixtures__/oxlint.fixtures.json`
// re-enables the rules for the test.
//
// 6 positive cases (rule MUST fire): 3 empty braces and 3 comment braces.
// 6 negative cases (rule must NOT fire). The boundary negatives are the two
// directives with no other place: a single biome-ignore, and a single
// oxlint-disable-next-line directly before JSX text.

declare const label: string;

// === Positive cases: must fire ===

// (1) Empty braces alone on their line.
export function PositiveOwnLine() {
  return (
    <div>
      {}
      <span />
    </div>
  );
}

// (2) Empty braces sharing a line with siblings.
export function PositiveSharedLine() {
  return (
    <p>
      <b>x</b>{}<i>y</i>
    </p>
  );
}

// (3) Braces holding only whitespace are still empty.
export function PositiveWhitespaceOnly() {
  return <div>{ }</div>;
}

// (4) A prose comment goes between props instead.
export function PositiveProseComment() {
  return <div>{/* prose */}</div>;
}

// (5) An oxlint directive before an element with no text child goes after
// the tag name instead.
export function PositiveOxlintBeforeElement() {
  return (
    <div>
      {/* oxlint-disable-next-line ok/no-physical-direction-utility -- fixture */}
      <section className="pr-6">
        <span />
      </section>
    </div>
  );
}

// (6) A directive with a second comment is not a single directive.
export function PositiveDirectiveAndProse() {
  return (
    <div>
      {/* biome-ignore lint/a11y/useSemanticElements: fixture */ /* and prose */}
      <div role="group" />
    </div>
  );
}

// === Negative cases: must NOT fire ===

// (7) Boundary: a single biome-ignore keeps its braces.
export function NegativeBiomeIgnore() {
  return (
    <div>
      {/* biome-ignore lint/a11y/useSemanticElements: a fixture group, not a form */}
      <div role="group" />
    </div>
  );
}

// (8) Boundary: a single oxlint directive before an element whose first
// child is text keeps its braces.
export function NegativeOxlintBeforeTextElement() {
  return (
    <p>
      {/* oxlint-disable-next-line ok/microcopy-ellipsis -- quoting a menu label */}
      <strong>Open…</strong>
    </p>
  );
}

// (9) Boundary: a single oxlint directive before bare text keeps its braces.
export function NegativeOxlintBeforeText() {
  return (
    <p>
      {/* oxlint-disable-next-line ok/microcopy-ellipsis -- quoting a menu label */}
      Open…
    </p>
  );
}

// (10) A real expression.
export function NegativeExpression() {
  return <div>{label}</div>;
}

// (11) An empty object literal in an attribute is an expression, not an empty container.
export function NegativeEmptyObjectAttribute() {
  return <div style={{}} />;
}

// (12) An empty string child is an expression.
export function NegativeEmptyString() {
  return <div>{''}</div>;
}
