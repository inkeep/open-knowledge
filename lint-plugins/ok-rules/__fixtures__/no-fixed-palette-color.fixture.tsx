// FIXTURE — drives `no-fixed-palette-color.uncached.test.mjs` via shell-out to
// oxlint. Not part of the main lint: `__fixtures__/` is in
// `oxlint.config.ts#ignorePatterns`, and `__fixtures__/oxlint.fixtures.json`
// re-enables the rules for the test.
//
// Positive cases (deliberate violations — rule must fire) paired with
// negative cases: the theme tokens the rule asks for, plus hue-like strings
// that are not color utilities and must stay silent.

declare const cn: (...parts: unknown[]) => string;
declare const failed: boolean;

// === Positive cases — must fire ===

// (1) A fixed hue in a plain class attribute.
export function Positive1() {
  return <div className="text-emerald-700 text-xs" />;
}

// (2) A dark-mode variant reached through `cn()`.
export function Positive2() {
  return <div className={cn('flex', failed && 'dark:bg-amber-950')} />;
}

// (3) A status map outside any class prop.
export const DOT_CLASS = {
  ready: 'bg-green-500',
};

// (4) An opacity modifier and a hover variant in a template literal.
export function Positive4(tone: string) {
  return <div className={`${tone} hover:border-rose-500/40`} />;
}

// (5) A ring color in a module-level array.
export const RINGS = ['ring-violet-400/60'];

// (6) Compound color utilities whose prefix is itself hyphenated.
export const COMPOUND = ['inset-ring-emerald-500', 'drop-shadow-red-500/50'];

// === Negative cases — must stay silent ===

// (7) The theme tokens the rule asks for.
export function Negative7() {
  return (
    <div className="text-success bg-warning/10 border-destructive/40 text-info ring-chart-4/60" />
  );
}

// (8) Neutral grays and black/white are outside the rule.
export function Negative8() {
  return <div className="text-neutral-900 bg-white border-black" />;
}

// (9) Hue words that are not color utilities.
export const NOT_UTILITIES = ['--color-red-500', 'red-500', 'theme-green-700', 'green tea'];

// (10) A utility-shaped run inside a longer identifier, on either side.
export const EMBEDDED = ['legacy-text-red-500', 'text-red-500-legacy'];
