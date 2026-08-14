import { describe, expect, test } from 'vitest';
import {
  buildMeasurementResult,
  distributeDocuments,
  parseMeasurementArgs,
  summarizeDurations,
} from './measure-generated-index-sweep.ts';

describe('generated-index sweep measurement rig', () => {
  test('parses an explicit comparable campaign', () => {
    expect(
      parseMeasurementArgs([
        '--directories',
        '1,10,100',
        '--documents',
        '1000',
        '--repetitions',
        '5',
        '--warmups',
        '1',
      ]),
    ).toEqual({
      directoryCounts: [1, 10, 100],
      documentCount: 1000,
      repetitions: 5,
      warmupRuns: 1,
    });
  });

  test('accepts the argument separator forwarded through pnpm scripts', () => {
    expect(parseMeasurementArgs(['--', '--directories', '1'])).toMatchObject({
      directoryCounts: [1],
    });
  });

  test.each([
    [['--directories', ''], 'non-empty comma-separated list'],
    [['--directories', '0,10'], 'positive integers'],
    [['--directories', '10,10'], 'unique'],
    [['--documents', '3', '--directories', '1,4'], 'at least the largest directory count'],
    [['--repetitions', '0'], 'positive integer'],
    [['--warmups', '-1'], 'non-negative integer'],
    [['--unknown', '1'], 'unknown argument'],
  ])('rejects invalid arguments: %j', (argv, message) => {
    expect(() => parseMeasurementArgs(argv)).toThrow(message);
  });

  test('keeps document count fixed while distributing at least one document per directory', () => {
    const counts = distributeDocuments(10, 4);
    expect(counts).toEqual([3, 3, 2, 2]);
    expect(counts.reduce((total, count) => total + count, 0)).toBe(10);
    expect(counts.every((count) => count > 0)).toBe(true);
  });

  test('summarizes raw durations without hiding run-to-run spread', () => {
    expect(summarizeDurations([12.41, 11.98, 12.22, 12.08, 12.35])).toEqual({
      samples: [12.41, 11.98, 12.22, 12.08, 12.35],
      median: 12.22,
      min: 11.98,
      max: 12.41,
    });
    expect(summarizeDurations([4, 2])).toMatchObject({ median: 3 });
  });

  test('emits a schema-versioned result with index-count and duration cells', () => {
    const result = buildMeasurementResult({
      args: {
        directoryCounts: [1, 10],
        documentCount: 100,
        repetitions: 2,
        warmupRuns: 1,
      },
      capturedAt: '2026-08-06T12:00:00.000Z',
      commit: 'abc1234',
      runtime: {
        nodeVersion: 'v24.0.0',
        platform: 'darwin',
        arch: 'arm64',
        cpuModel: 'Test CPU',
      },
      samples: new Map([
        [
          1,
          [
            { durationMs: 2.25, indexCount: 2 },
            { durationMs: 2.75, indexCount: 2 },
          ],
        ],
        [
          10,
          [
            { durationMs: 8.5, indexCount: 11 },
            { durationMs: 9.5, indexCount: 11 },
          ],
        ],
      ]),
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      benchmark: 'generated-index-full-sweep',
      fixture: {
        topology: 'flat',
        documentCount: 100,
        directoryCounts: [1, 10],
        warmupRuns: 1,
        repetitions: 2,
      },
      cells: [
        {
          directoryCount: 1,
          expectedIndexCount: 2,
          indexCount: 2,
          sweepDurationMs: { samples: [2.25, 2.75], median: 2.5, min: 2.25, max: 2.75 },
        },
        {
          directoryCount: 10,
          expectedIndexCount: 11,
          indexCount: 11,
          sweepDurationMs: { samples: [8.5, 9.5], median: 9, min: 8.5, max: 9.5 },
        },
      ],
    });
  });
});
