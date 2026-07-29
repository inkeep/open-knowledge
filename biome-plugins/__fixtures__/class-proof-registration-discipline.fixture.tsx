// FIXTURE — drives `class-proof-registration-discipline.test.ts` via
// shell-out to `pnpm exec biome check`. Not part of the main lint (override
// scope keeps the rule off this fixture's path under normal `pnpm run lint`;
// the test explicitly invokes biome on this file path).
//
// GritQL's `or { ... }` is short-circuit: when a call matches the first
// branch (Pattern A: missing predicate/proof), the second branch (Pattern
// B: any defineClassProof) is NOT also considered. Missing-args calls
// therefore get the more-specific Pattern A diagnostic; well-formed calls
// outside the canonical dir get Pattern B's diagnostic.
//
// 3 expected diagnostic fires (one per violating call):
//   - Positive A1: missing predicate (1 fire — Pattern A diagnostic)
//   - Positive A2: missing proof     (1 fire — Pattern A diagnostic)
//   - Positive B1: well-formed but outside canonical dir
//                                    (1 fire — Pattern B diagnostic)
//   - Negative cases: 0 fires (must NOT fire)
//
// Exact-equality (`toBe(3)`) catches both false-negative regressions (drop
// below 3) and false-positive widenings (above 3).

// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const defineClassProof: any;
// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const enumerateThings: any;
// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const someOtherFunction: any;

// === Positive cases — must fire ===

// (A1) Missing `predicate` field — Pattern A's missing-args diagnostic
//      wins over Pattern B's outside-canonical diagnostic via `or`'s
//      short-circuit. Total: 1 diagnostic.
export const badProofMissingPredicate = defineClassProof('cp-bad-1', {
  enumerate: enumerateThings,
  proof: () => ({ pass: true }),
});

// (A2) Missing `proof` field — same as A1: Pattern A fires. 1 diagnostic.
export const badProofMissingProof = defineClassProof('cp-bad-2', {
  enumerate: enumerateThings,
  predicate: () => true,
});

// (B1) All three fields present, but the file is outside the canonical
//      dir — Pattern A doesn't match (args complete), so Pattern B fires.
//      Total: 1 diagnostic.
export const wellFormedButWrongLocation = defineClassProof('cp-bad-3', {
  enumerate: enumerateThings,
  predicate: () => true,
  proof: () => ({ pass: true }),
});

// === Negative cases — must NOT fire ===

// (1) An unrelated function call with the same arg shape — must NOT fire.
//     The rule's pattern matches the literal function name `defineClassProof`.
export const unrelated = someOtherFunction('cp-1', {
  enumerate: enumerateThings,
  predicate: () => true,
});

// (2) An identifier whose name contains `defineClassProof` substring but is
//     not exactly that — must NOT fire. The rule matches the bare
//     identifier, not arbitrary affixes.
export const customDef = (() => {
  const myDefineClassProofVariant = (_n: string, _o: unknown) => ({ ok: true });
  return myDefineClassProofVariant('cp-2', { enumerate: enumerateThings });
})();

// (3) A type reference that mentions `defineClassProof` (e.g. for an alias)
//     — must NOT fire. The rule scopes to call expressions.
export type DefineClassProofAlias = typeof defineClassProof;
