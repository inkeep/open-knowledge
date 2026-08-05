// FIXTURE — drives `no-physical-direction-utility.test.ts` via shell-out to
// `biome check`. Not part of the main lint (lives outside the lint command's
// path list).
//
// Positive cases (deliberate violations — plugin must fire) paired with
// negative cases: the logical forms the rule asks for, plus the physical-looking
// shapes that are direction-correct already and must stay silent. Exact-equality
// `toBe(N)` in the test catches both a weakened pattern (count drops) and a
// widened one (a negative starts firing, count rises).

declare const cn: (...parts: unknown[]) => string;
declare const isCompact: boolean;
declare const Panel: (props: {
  containerClassName?: string;
  edge?: string;
  token?: string;
  className?: string;
}) => null;

// === Positive cases — must fire ===

// (1) A physical margin in a plain string.
export function Positive1() {
  return <div className="ml-2 flex items-center" />;
}

// (2) A physical padding reached through `cn()`. The rule spans the whole
//     attribute, so a token several lines down inside the call still counts.
export function Positive2() {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-md border bg-muted/60 py-0.5 text-xs',
        isCompact && 'pr-1.5',
      )}
    />
  );
}

// (3) A physical inset on an absolutely positioned element.
export function Positive3() {
  return <div className="absolute top-2 right-2 size-4" />;
}

// (4) An arbitrary value. The side is still baked into the utility even though
//     the length comes from a custom property.
export function Positive4() {
  return <div className="pl-[var(--ok-example-reserve,1rem)]" />;
}

// (5) The `auto` keyword — `ml-auto` is the flex end-push, and it pushes the
//     wrong way once the reading direction flips.
export function Positive5() {
  return <div className="ml-auto shrink-0" />;
}

// (6) A `*ClassName` prop, not just `className`. Component APIs that forward a
//     second class string are the same layout surface under a different name.
export function Positive6() {
  return <Panel containerClassName="bottom-3 left-3 gap-1" />;
}

// (7) A negative margin behind a responsive variant. Both the leading `-` and
//     the `sm:` prefix have to leave the token recognizable.
export function Positive7() {
  return <div className="sm:-mr-1" />;
}

// === Negative cases — must NOT fire ===

// (1) The logical forms the diagnostic asks for.
export function Negative1() {
  return (
    <div className="ms-2 me-1.5 ps-6 pe-2">
      <span className="start-0 end-2 absolute" />
      <span className="ms-auto" />
    </div>
  );
}

// (2) `inset-x-*` reads physical and is not: Tailwind v4 compiles it to
//     `inset-inline`, so it already follows the reading direction.
export function Negative2() {
  return <div className="fixed inset-x-0 top-0" />;
}

// (3) The centering anchor. `left-1/2` exists to be cancelled by the translate
//     beside it, and at 50% the offset is symmetric — swapping in `start-1/2`
//     would flip the anchor while the translate kept pulling the same way.
export function Negative3() {
  return <div className="-translate-x-1/2 absolute bottom-0 left-1/2" />;
}

// (4) Spacing with no side to get wrong: block-axis margins, symmetric padding,
//     gaps, and full insets.
export function Negative4() {
  return <div className="mt-2 mb-2 inset-0 gap-2 px-3 py-1" />;
}

// (5) A side named somewhere other than a utility — inside a variant selector,
//     and in a prop that carries a side rather than a class string. Neither is
//     layout the rule can fix.
export function Negative5() {
  return (
    <div className="has-[[data-side=left]]:ms-2" title="Right-click to open">
      <Panel edge="right" />
    </div>
  );
}

// (6) Well-formed utilities spelled inside attributes that are NOT class props.
//     All three below match the value pattern, so the name predicate is the only
//     thing keeping them quiet — drop it and every one of them fires. It has to
//     stay: these values are text the component renders or keys off, so the
//     logical form would change what the reader sees rather than how the row
//     lays out.
export function Negative6() {
  return (
    <div data-token="ml-4" title="Row indent is pl-2">
      <Panel token="pr-1.5" />
    </div>
  );
}
