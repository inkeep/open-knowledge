/**
 * Fixture for `no-inline-tolerance-class.grit`.
 *
 * Pairs 8 positive cases (a bridge normalization-class value
 * written inline as a string literal — plugin MUST fire) with negative cases
 * (the four universal text-encoding classes used as legitimate inline literals,
 * a class name appearing only as a SUBSTRING of test-title / docName prose, a
 * comment mention, a concatenation, and a non-catalog literal — plugin must NOT
 * fire). The fixture-file test asserts the diagnostic count with exact equality
 * (`toBe(8)`) so both a weakened pattern (drops below 8) and a widened pattern
 * that catches a negative (rises above 8) fail the gate.
 *
 * The universal-encoding negatives (`crlf`, `bom`, `trailing-whitespace`,
 * `trailing-newline`) are the load-bearing precision boundary: they are real
 * `BRIDGE_TOLERANCE_CLASSES` members, yet they are deliberately NOT flagged
 * because the public floor telemetry runtime surfaces them and public tests
 * legitimately assert that behavior. Flagging them would redden those floor
 * tests; the fixture pins that they stay silent.
 *
 * Deliberately NOT linted by the main `pnpm run lint` pass (biome-plugins/ is
 * outside the lint paths); only the scoped override in biome.jsonc reaches it,
 * via the fixture-file test.
 */

declare const expect: (v: unknown) => { toBe: (v: unknown) => void };
declare const applied: string;
declare const cls: string;

function positives() {
  // P1: a single distinctive fidelity class written inline.
  const single = 'emphasis-around-code';
  // P2-P5: four class labels written inline as an array.
  const reencoded = [
    'doc-start-thematic',
    'block-separator-collapse',
    'table-align-row-spacing',
    'row-no-trailing-pipe',
  ];
  // P6: asserting an observed class against an exact fidelity literal.
  expect(applied).toBe('jsx-container-boundary-blank');
  // P7: an equality comparison against an exact fidelity literal.
  const isCanonical = cls === 'list-indent-canonical';
  // P8: a fidelity class as an object property value.
  const record = { className: 'ordered-list-marker-number' };
  return { single, reencoded, isCanonical, record };
}

function negatives() {
  // N1-N4: the four universal text-encoding classes are real catalog members but
  // are deliberately not flagged — the public floor telemetry runtime emits
  // them and public tests assert that behavior. They must stay silent.
  const isCrlf = cls === 'crlf';
  const isBom = cls === 'bom';
  const fired = ['trailing-whitespace', 'trailing-newline'];
  // N5: a class name appearing only as a SUBSTRING of a test-title sentence —
  // the rule keys on the literal's whole value, not a substring.
  const title = 'watchdog tolerates a doc-start-thematic divergence at column 1';
  // N6: a class name embedded as a substring of a docName carrying a prefix.
  const docName = 'fr34-doc-start-thematic';
  // N7: a class name mentioned in a comment (emphasis-around-code) is trivia,
  // not a string-literal node; this assignment is an ordinary literal.
  const mode = 'replace';
  // N8: split across a concatenation — neither operand is the whole value.
  const split = `doc-start-${'thematic'}`;
  return { isCrlf, isBom, fired, title, docName, mode, split };
}

export { negatives, positives };
