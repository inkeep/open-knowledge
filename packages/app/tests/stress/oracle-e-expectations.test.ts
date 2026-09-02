import { describe, expect, test } from 'vitest';
import {
  buildOracleEExpectations,
  markerPrefixOf,
  type OracleEOp,
} from './oracle-e-expectations.test-helper';

describe('oracle (e) expectation walk — refused-op accounting', () => {
  test('a refused (never-applied) agent write does not contribute its marker to the expectations', () => {
    const ops: OracleEOp[] = [
      { kind: 'agent-write', position: 'replace', marker: 'M0-anchor words' },
      { kind: 'source-type', marker: 'M1-typed line' },
      { kind: 'agent-write', position: 'append', marker: 'M4-foxtrot bravo' },
    ];
    const notAppliedOpIndices = new Set([2]);

    const { preMarkerLines } = buildOracleEExpectations(ops, notAppliedOpIndices);

    expect(preMarkerLines.get(markerPrefixOf('M0-anchor words'))).toBe('M0-anchor words');
    expect(preMarkerLines.get(markerPrefixOf('M1-typed line'))).toBe('M1-typed line');
    expect(preMarkerLines.has(markerPrefixOf('M4-foxtrot bravo'))).toBe(false);
  });

  test('a chunked-source-paste op is intentionally excluded from the walk', () => {
    const ops: OracleEOp[] = [
      { kind: 'agent-write', position: 'replace', marker: 'M0-anchor words' },
      { kind: 'chunked-source-paste', marker: 'M2-pasted chunk' },
    ];

    const { preMarkerLines } = buildOracleEExpectations(ops, new Set());

    expect(preMarkerLines.get(markerPrefixOf('M0-anchor words'))).toBe('M0-anchor words');
    expect(preMarkerLines.has(markerPrefixOf('M2-pasted chunk'))).toBe(false);
  });

  test('a refused replace-position agent write does not clear previously applied markers', () => {
    const ops: OracleEOp[] = [
      { kind: 'agent-write', position: 'replace', marker: 'M0-anchor words' },
      { kind: 'agent-write', position: 'replace', marker: 'M9-delta' },
    ];
    const notAppliedOpIndices = new Set([1]);

    const { preMarkerLines } = buildOracleEExpectations(ops, notAppliedOpIndices);

    expect(preMarkerLines.get(markerPrefixOf('M0-anchor words'))).toBe('M0-anchor words');
    expect(preMarkerLines.has(markerPrefixOf('M9-delta'))).toBe(false);
  });

  test('a refused agent-undo does not clear previously applied markers', () => {
    const ops: OracleEOp[] = [
      { kind: 'agent-write', position: 'replace', marker: 'M0-anchor words' },
      { kind: 'agent-undo' },
    ];
    const notAppliedOpIndices = new Set([1]);

    const { preMarkerLines } = buildOracleEExpectations(ops, notAppliedOpIndices);

    expect(preMarkerLines.get(markerPrefixOf('M0-anchor words'))).toBe('M0-anchor words');
  });
});
