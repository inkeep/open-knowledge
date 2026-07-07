/**
 * Fixture for `no-roundtrip-identity-oracle.grit`.
 *
 * Pairs 10 positive cases (the byte-fidelity round-trip identity oracle —
 * plugin MUST fire) with 7 negative cases (contract assertions, the
 * Bridge-invariant comparator, the `!==` normalizing-construct detector, the
 * helper-wrapped and two-statement round-trip forms — plugin must NOT fire).
 * The fixture-file test asserts the diagnostic count with exact equality
 * (`toBe(10)`) so both a weakened pattern (drops below 10) and a widened
 * pattern that catches a negative (rises above 10) fail the gate.
 *
 * Deliberately NOT linted by the main `bun run lint` pass (biome-plugins/ is
 * outside the lint paths); only the scoped override in biome.jsonc reaches it,
 * via the fixture-file test.
 */

declare const expect: (v: unknown) => {
  toBe: (v: unknown) => void;
  toEqual: (v: unknown) => void;
  toStrictEqual: (v: unknown) => void;
};
declare function serialize(node: unknown): string;
declare function parse(src: string): unknown;
declare function normalize(src: string): string;
declare function mdRoundTrip(src: string): string;
declare function normalizeBridge(src: string): string;
declare const mgr: { serialize: (n: unknown) => string; parse: (s: string) => unknown };
declare const m1: typeof mgr;
declare const m2: typeof mgr;
declare const md: string;
declare const a: string;
declare const b: string;
declare const input: string;
declare const expected: string;

function positives() {
  // expect(serialize(parse(x))) against the SAME x, three equality
  // matchers — the canonical byte-identity oracle.
  expect(serialize(parse(md))).toBe(md);
  expect(serialize(parse(md))).toEqual(md);
  expect(serialize(parse(md))).toStrictEqual(md);
  // the MarkdownManager method equivalent, same three matchers.
  expect(mgr.serialize(mgr.parse(md))).toBe(md);
  expect(mgr.serialize(mgr.parse(md))).toEqual(md);
  expect(mgr.serialize(mgr.parse(md))).toStrictEqual(md);
  // the `===` identity comparison, both operand orders.
  const idA = serialize(parse(md)) === md;
  const idB = md === serialize(parse(md));
  // the MarkdownManager `===` identity comparison, both orders.
  const idC = mgr.serialize(mgr.parse(md)) === md;
  const idD = md === mgr.serialize(mgr.parse(md));
  return { idA, idB, idC, idD };
}

function negatives() {
  // contract assertion — expected is a FIXED literal that differs from the
  // parse input (the serializer normalizes `# H` to `# H\n`). Different
  // expected than input, so it is not an identity oracle.
  expect(serialize(parse('# H'))).toBe('# H\n');
  // the Bridge-invariant comparator (precedent #38) — the documented public
  // contract, NOT a leak. No `serialize(parse(...))`, two different inputs.
  expect(normalizeBridge(a)).toBe(normalizeBridge(b));
  // the normalizing-construct DETECTOR — `!==`, the opposite assertion,
  // used to find constructs the serializer rewrites. Different operator.
  const normalizes = serialize(parse(md)) !== md;
  // two-statement round-trip — the round-trip flows through an intermediate
  // variable; GritQL cannot correlate the parse input with the matcher value
  // across statements.
  const out = serialize(parse(md));
  expect(out).toBe(md);
  // helper-wrapped round-trip identity (the real fidelity-suite shape) —
  // the inline call is `normalize(mdRoundTrip(...))`, not `serialize(parse(...))`.
  expect(normalize(mdRoundTrip(md))).toBe(normalize(md));
  // MarkdownManager contract — expected differs from the parse input.
  expect(mgr.serialize(mgr.parse(input))).toBe(expected);
  // two DIFFERENT managers — not a single round trip, so the manager
  // metavariable reuse rejects it.
  expect(m1.serialize(m2.parse(md))).toBe(md);
  return { normalizes, out };
}

export { negatives, positives };
