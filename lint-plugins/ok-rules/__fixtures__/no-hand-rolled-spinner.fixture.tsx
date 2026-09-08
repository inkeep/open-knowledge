// FIXTURE — drives `no-hand-rolled-spinner.test.ts` via shell-out to
// `pnpm exec oxlint`. Not part of the main lint: `__fixtures__/` is in
// `oxlint.config.ts#ignorePatterns`, and `__fixtures__/oxlint.fixtures.json`
// re-enables the rules for the test.
//
// 5 positive cases (hand-rolled spins — rule MUST fire) paired with 5 negative
// cases (rule must NOT fire). The test asserts exact equality (`toBe(5)`) so a
// weakened predicate drops below 5 and a widened one rises above it.
//
// The boundary cases are the point. `animate-spinner` does NOT fire because the
// trailing `\b` fails against a word character, but `animate-spin-slow` DOES:
// `-` is a word boundary, so the delimiter admits suffixed variants. That is the
// retired GritQL pattern's behaviour too, carried over deliberately — a slowed
// spin is still a hand-rolled one — and it is pinned here because the two look
// symmetric and are not. `data-anim` pins that the attribute-name filter is
// load-bearing: the rule keys on `className` and every `*ClassName` prop, not on
// any attribute containing the token.

declare const cn: (...parts: unknown[]) => string;
declare const isBusy: boolean;
declare const Spinner: (props: Record<string, unknown>) => unknown;
declare const RefreshCw: (props: Record<string, unknown>) => unknown;

// === Positive cases — must fire ===

// (1) Plain string className.
export function PositiveBareClass() {
  return <div className="size-4 animate-spin" />;
}

// (2) Inside a cn() call — the whole initializer is the matched node.
export function PositiveInCn() {
  return <div className={cn('size-4', isBusy && 'animate-spin')} />;
}

// (3) A `*ClassName` prop, not just `className`.
export function PositiveSuffixedProp() {
  return <Spinner iconClassName="animate-spin text-muted-foreground" />;
}

// (4) A suffixed variant: `-` is a word boundary, so this fires like the bare
//     utility does. Slowing a hand-rolled spin does not make it a `Spinner`.
export function PositiveSuffixedVariant() {
  return <div className="animate-spin-slow" />;
}

// (5) The wrapped authoring shape as it appears in production. It is NOT a
//     boundary pin: it shares case (2)'s AST shape (a JSXExpressionContainer
//     wrapping `cn()`), the token sits entirely on one physical line, and the
//     predicate reads `sourceCode.getText` of the whole value node, so no
//     mutation of the rule separates the two. It is here as a realism sample
//     -- the shape a reader will actually meet -- and it costs `toBe(5)`
//     nothing.
export function PositiveMultiline() {
  return (
    <RefreshCw
      className={cn(
        'size-3.5 shrink-0',
        isBusy && 'animate-spin',
      )}
    />
  );
}

// === Negative cases — must NOT fire ===

// (1) The sanctioned primitive, which owns the spin internally.
export function NegativeSpinnerPrimitive() {
  return <Spinner icon={RefreshCw} aria-hidden="true" />;
}

// (2) A longer token that starts with the same prefix.
export function NegativeLongerToken() {
  return <div className="animate-spinner" />;
}

// (3) A non-class attribute carrying the token: the attribute-name filter holds.
export function NegativeNonClassAttribute() {
  return <div data-anim="animate-spin" />;
}

// (4) An unrelated animation utility.
export function NegativeOtherAnimation() {
  return <div className="animate-pulse rounded-md" />;
}

// (5) The token in prose, not in a class position.
export function NegativeProseMention() {
  return <span title="uses animate-spin under the hood">docs</span>;
}
