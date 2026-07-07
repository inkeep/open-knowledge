/**
 * Accounting contract of the fuzz harness's oracle (e) expectation walk
 * (`buildOracleEExpectations`, consumed by bridge-convergence.fuzz.test.ts).
 *
 * Invariant: an op the main loop recorded as NOT APPLIED (`applyOp` returned
 * false — e.g. an agent write the server legitimately refused with 409
 * doc-in-conflict) never touched the doc, so oracle (e) must not demand its
 * marker in the final client states. The main loop's `if (!applied)` skip
 * already excludes such ops from oracle (d)'s `livePrefixes` and from the
 * expected-body tracker; the oracle (e) walk re-iterates the generated op
 * list and must honor the same exclusions — otherwise any legitimate refusal
 * in any seed fails oracle (e) with a misleading "tail corruption" message
 * (the markers are absent because the writes were refused, not because
 * content was corrupted).
 */
import { describe, expect, test } from 'bun:test';
import {
  buildOracleEExpectations,
  markerPrefixOf,
  type OracleEOp,
} from './oracle-e-expectations.test-helper';

describe('oracle (e) expectation walk — refused-op accounting', () => {
  test('a refused (never-applied) agent write does not contribute its marker to the expectations', () => {
    // Minimal deterministic shape of the failing fuzz seed:
    // applied writes M0-anchor/M1-typed, then an agent write the server refused (409).
    const ops: OracleEOp[] = [
      { kind: 'agent-write', position: 'replace', marker: 'M0-anchor words' },
      { kind: 'source-type', marker: 'M1-typed line' },
      { kind: 'agent-write', position: 'append', marker: 'M4-foxtrot bravo' },
    ];
    const notAppliedOpIndices = new Set([2]); // the M4-foxtrot write was refused

    const { preMarkerLines } = buildOracleEExpectations(ops, notAppliedOpIndices);

    // Applied content is still demanded…
    expect(preMarkerLines.get(markerPrefixOf('M0-anchor words'))).toBe('M0-anchor words');
    expect(preMarkerLines.get(markerPrefixOf('M1-typed line'))).toBe('M1-typed line');
    // …but the refused write's marker must not be: it was never applied, so
    // demanding it asserts the presence of content the server never wrote.
    expect(preMarkerLines.has(markerPrefixOf('M4-foxtrot bravo'))).toBe(false);
  });

  test('a chunked-source-paste op is intentionally excluded from the walk', () => {
    // Chunked pastes are verified by the harness's chunk-glue relaxation,
    // not by oracle (e)'s line-form demands — the walk must not register
    // their markers even when the op applied.
    const ops: OracleEOp[] = [
      { kind: 'agent-write', position: 'replace', marker: 'M0-anchor words' },
      { kind: 'chunked-source-paste', marker: 'M2-pasted chunk' },
    ];

    const { preMarkerLines } = buildOracleEExpectations(ops, new Set());

    expect(preMarkerLines.get(markerPrefixOf('M0-anchor words'))).toBe('M0-anchor words');
    expect(preMarkerLines.has(markerPrefixOf('M2-pasted chunk'))).toBe(false);
  });

  test('a refused replace-position agent write does not clear previously applied markers', () => {
    // The walk's `position: 'replace'` arm wipes all prior expectations.
    // When the replace itself was refused, nothing was wiped on the server —
    // clearing here would silently drop oracle (e) coverage of all earlier
    // applied content (the inverse accounting error: under-demanding).
    const ops: OracleEOp[] = [
      { kind: 'agent-write', position: 'replace', marker: 'M0-anchor words' },
      { kind: 'agent-write', position: 'replace', marker: 'M9-delta' },
    ];
    const notAppliedOpIndices = new Set([1]); // the M9-delta replace was refused

    const { preMarkerLines } = buildOracleEExpectations(ops, notAppliedOpIndices);

    expect(preMarkerLines.get(markerPrefixOf('M0-anchor words'))).toBe('M0-anchor words');
    expect(preMarkerLines.has(markerPrefixOf('M9-delta'))).toBe(false);
  });

  test('a refused agent-undo does not clear previously applied markers', () => {
    // The walk's `agent-undo` arm conservatively clears all expectations
    // (an applied undo may remove any prior agent-write). When the undo was
    // refused (404 — no session / empty undo stack), nothing was undone on
    // the server, so clearing here would stop demanding markers for content
    // the server still holds — a false-negative that masks content loss.
    const ops: OracleEOp[] = [
      { kind: 'agent-write', position: 'replace', marker: 'M0-anchor words' },
      { kind: 'agent-undo' },
    ];
    const notAppliedOpIndices = new Set([1]); // the undo was refused

    const { preMarkerLines } = buildOracleEExpectations(ops, notAppliedOpIndices);

    expect(preMarkerLines.get(markerPrefixOf('M0-anchor words'))).toBe('M0-anchor words');
  });
});
