import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCalibrationReport,
  classifyContentBytes,
  computeMedianRotationDistance,
  computeSizeDistributionPct,
  loadTraces,
} from './calibrate';
import { tightFixture } from './tight';
import { SIZE_ENVELOPES } from './types';

describe('classifyContentBytes', () => {
  test('places envelope boundaries in the expected class', () => {
    expect(classifyContentBytes(SIZE_ENVELOPES.small.minBytes)).toBe('small');
    expect(classifyContentBytes(SIZE_ENVELOPES.small.maxBytes - 1)).toBe('small');
    expect(classifyContentBytes(SIZE_ENVELOPES.medium.minBytes)).toBe('medium');
    expect(classifyContentBytes(SIZE_ENVELOPES.medium.maxBytes - 1)).toBe('medium');
    expect(classifyContentBytes(SIZE_ENVELOPES.large.minBytes)).toBe('large');
    expect(classifyContentBytes(SIZE_ENVELOPES.large.maxBytes - 1)).toBe('large');
  });

  test('clamps oversized docs to large', () => {
    expect(classifyContentBytes(SIZE_ENVELOPES.large.maxBytes * 10)).toBe('large');
  });
});

describe('computeSizeDistributionPct', () => {
  test('empty input returns zeros (no NaN)', () => {
    const dist = computeSizeDistributionPct([]);
    expect(dist).toEqual({ small: 0, medium: 0, large: 0 });
  });

  test('uniform input produces uniform percentage', () => {
    const dist = computeSizeDistributionPct(['small', 'medium', 'large', 'small']);
    expect(dist.small).toBe(50);
    expect(dist.medium).toBe(25);
    expect(dist.large).toBe(25);
  });
});

describe('computeMedianRotationDistance', () => {
  test('returns null when no repeat visits are observed', () => {
    const events = [
      { docName: 'a', contentBytes: 1000, openedAt: 1 },
      { docName: 'b', contentBytes: 1000, openedAt: 2 },
      { docName: 'c', contentBytes: 1000, openedAt: 3 },
    ];
    expect(computeMedianRotationDistance(events)).toBeNull();
  });

  test('measures distinct docs between repeat visits', () => {
    // a → b → c → a   distance between a-visits = 2 distinct ('b' and 'c')
    const events = [
      { docName: 'a', contentBytes: 1000, openedAt: 1 },
      { docName: 'b', contentBytes: 1000, openedAt: 2 },
      { docName: 'c', contentBytes: 1000, openedAt: 3 },
      { docName: 'a', contentBytes: 1000, openedAt: 4 },
    ];
    expect(computeMedianRotationDistance(events)).toBe(2);
  });

  test('median of multiple repeat distances', () => {
    // distances: a@4→a@1 = 2, b@5→b@2 = 2, c@6→c@3 = 2 (all 2)
    const events = [
      { docName: 'a', contentBytes: 1000, openedAt: 1 },
      { docName: 'b', contentBytes: 1000, openedAt: 2 },
      { docName: 'c', contentBytes: 1000, openedAt: 3 },
      { docName: 'a', contentBytes: 1000, openedAt: 4 },
      { docName: 'b', contentBytes: 1000, openedAt: 5 },
      { docName: 'c', contentBytes: 1000, openedAt: 6 },
    ];
    expect(computeMedianRotationDistance(events)).toBe(2);
  });
});

describe('loadTraces', () => {
  test('missing trace dir returns []', () => {
    const empty = loadTraces('/this/path/should/not/exist/at/all');
    expect(empty).toEqual([]);
  });

  test('reads JSONL files and sorts by openedAt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-regime-rotation-calibrate-'));
    try {
      writeFileSync(
        join(dir, 'sample.jsonl'),
        [
          JSON.stringify({ docName: 'late', contentBytes: 1000, openedAt: 100 }),
          JSON.stringify({ docName: 'early', contentBytes: 1000, openedAt: 1 }),
          '',
          JSON.stringify({ docName: 'middle', contentBytes: 1000, openedAt: 50 }),
        ].join('\n'),
      );
      const events = loadTraces(dir);
      expect(events.map((e) => e.docName)).toEqual(['early', 'middle', 'late']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips entries with missing required fields silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-regime-rotation-calibrate-bad-'));
    try {
      writeFileSync(
        join(dir, 'bad.jsonl'),
        [
          JSON.stringify({ docName: 'ok', contentBytes: 500, openedAt: 1 }),
          JSON.stringify({ docName: 'missing-bytes', openedAt: 2 }),
          JSON.stringify({ contentBytes: 999, openedAt: 3 }),
        ].join('\n'),
      );
      const events = loadTraces(dir);
      expect(events.length).toBe(1);
      expect(events[0]?.docName).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips truly malformed (unparseable) JSONL lines silently', () => {
    // Interrupted dogfood-trace captures can truncate the final line
    // mid-write. The loader must tolerate that without throwing — the
    // JSDoc contract is silent-skip for both missing-field AND
    // parse-failure shapes.
    const dir = mkdtempSync(join(tmpdir(), 'cache-regime-rotation-calibrate-truncated-'));
    try {
      writeFileSync(
        join(dir, 'truncated.jsonl'),
        [
          JSON.stringify({ docName: 'first', contentBytes: 500, openedAt: 1 }),
          '{"docName":"second","contentBytes":600,"opene', // truncated mid-key
          JSON.stringify({ docName: 'third', contentBytes: 700, openedAt: 3 }),
          '{broken json[', // unrelated garbage
          'totally not json',
        ].join('\n'),
      );
      const events = loadTraces(dir);
      expect(events.length).toBe(2);
      expect(events.map((e) => e.docName).sort()).toEqual(['first', 'third']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildCalibrationReport', () => {
  test('aggregates events into per-fixture drift lines without mutating inputs', () => {
    const events = [
      { docName: 'a', contentBytes: 1000, openedAt: 1 },
      { docName: 'b', contentBytes: 20_000, openedAt: 2 },
      { docName: 'c', contentBytes: 200_000, openedAt: 3 },
      { docName: 'a', contentBytes: 1000, openedAt: 4 },
    ];
    const report = buildCalibrationReport(events, [tightFixture], '/dev/null');
    expect(report.traceDir).toBe('/dev/null');
    expect(report.traceTotalEvents).toBe(4);
    expect(report.traceDistinctDocs).toBe(3);
    expect(report.fixtures).toHaveLength(1);
    expect(report.fixtures[0]?.ref).toBe('tight');
    expect(report.fixtures[0]?.lines.length).toBeGreaterThan(0);
    for (const line of report.fixtures[0]?.lines ?? []) {
      expect(['OK', 'DRIFT']).toContain(line.drift);
    }
  });

  test('handles a trace with no repeats — distance line stays OK (drift unknown)', () => {
    const events = [
      { docName: 'a', contentBytes: 1000, openedAt: 1 },
      { docName: 'b', contentBytes: 20_000, openedAt: 2 },
    ];
    const report = buildCalibrationReport(events, [tightFixture], '/dev/null');
    const distanceLine = report.fixtures[0]?.lines.find((l) => l.label === 'rotation distance');
    expect(distanceLine?.drift).toBe('OK');
    expect(distanceLine?.trace).toBe('(no repeats)');
  });
});
