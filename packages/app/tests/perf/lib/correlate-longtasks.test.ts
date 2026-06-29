
import { describe, expect, test } from 'bun:test';
import { correlateLongtasksWithMarks } from './correlate-longtasks';

describe('correlateLongtasksWithMarks', () => {
  test('both inputs empty → returns empty array', () => {
    expect(correlateLongtasksWithMarks([], [])).toEqual([]);
  });

  test('empty marks → returns one entry per task with empty marksWithinTask', () => {
    const result = correlateLongtasksWithMarks([{ startTime: 0, duration: 100 }], []);
    expect(result).toEqual([{ taskMs: 100, taskStartMs: 0, marksWithinTask: [] }]);
  });

  test('empty tasks → returns empty array regardless of marks', () => {
    expect(correlateLongtasksWithMarks([], [{ name: 'a', startTime: 50, duration: 10 }])).toEqual(
      [],
    );
  });

  test('marks fully within task — included with correct percentOfTask', () => {
    const result = correlateLongtasksWithMarks(
      [{ startTime: 100, duration: 200 }],
      [{ name: 'a', startTime: 120, duration: 50 }],
    );
    expect(result).toEqual([
      {
        taskMs: 200,
        taskStartMs: 100,
        marksWithinTask: [{ name: 'a', durationMs: 50, percentOfTask: 25 }],
      },
    ]);
  });

  test('marks outside any task — emitted task entry has empty marksWithinTask', () => {
    const result = correlateLongtasksWithMarks(
      [{ startTime: 100, duration: 200 }],
      [{ name: 'b', startTime: 500, duration: 100 }],
    );
    expect(result).toEqual([{ taskMs: 200, taskStartMs: 100, marksWithinTask: [] }]);
  });

  test('marks partially overlapping (start inside, end outside) — included by start-time rule', () => {
    const result = correlateLongtasksWithMarks(
      [{ startTime: 100, duration: 200 }],
      [{ name: 'straddler', startTime: 250, duration: 200 }],
    );
    expect(result).toEqual([
      {
        taskMs: 200,
        taskStartMs: 100,
        marksWithinTask: [{ name: 'straddler', durationMs: 200, percentOfTask: 100 }],
      },
    ]);
  });

  test('marks partially overlapping (start before, end inside) — excluded by start-time rule', () => {
    const result = correlateLongtasksWithMarks(
      [{ startTime: 100, duration: 200 }],
      [{ name: 'pre', startTime: 50, duration: 100 }],
    );
    expect(result).toEqual([{ taskMs: 200, taskStartMs: 100, marksWithinTask: [] }]);
  });

  test('mixed marks — both inside and outside one task — only inside ones counted', () => {
    const result = correlateLongtasksWithMarks(
      [{ startTime: 100, duration: 200 }],
      [
        { name: 'a', startTime: 120, duration: 50 },
        { name: 'b', startTime: 300, duration: 100 },
      ],
    );
    expect(result).toEqual([
      {
        taskMs: 200,
        taskStartMs: 100,
        marksWithinTask: [{ name: 'a', durationMs: 50, percentOfTask: 25 }],
      },
    ]);
  });

  test('half-open boundary: mark at exact task end-time → assigned to next task, not current', () => {
    const result = correlateLongtasksWithMarks(
      [
        { startTime: 0, duration: 100 },
        { startTime: 100, duration: 100 },
      ],
      [{ name: 'boundary', startTime: 100, duration: 5 }],
    );
    expect(result[0]?.marksWithinTask).toEqual([]);
    expect(result[1]?.marksWithinTask).toEqual([
      { name: 'boundary', durationMs: 5, percentOfTask: 5 },
    ]);
  });

  test('multiple tasks each get their own marks', () => {
    const result = correlateLongtasksWithMarks(
      [
        { startTime: 0, duration: 100 },
        { startTime: 200, duration: 100 },
      ],
      [
        { name: 'a', startTime: 10, duration: 20 },
        { name: 'b', startTime: 220, duration: 30 },
      ],
    );
    expect(result).toEqual([
      {
        taskMs: 100,
        taskStartMs: 0,
        marksWithinTask: [{ name: 'a', durationMs: 20, percentOfTask: 20 }],
      },
      {
        taskMs: 100,
        taskStartMs: 200,
        marksWithinTask: [{ name: 'b', durationMs: 30, percentOfTask: 30 }],
      },
    ]);
  });

  test('zero-duration task → percentOfTask = 0 (no division by zero)', () => {
    const result = correlateLongtasksWithMarks(
      [{ startTime: 100, duration: 0 }],
      [{ name: 'instant', startTime: 100, duration: 5 }],
    );
    expect(result[0]?.marksWithinTask).toEqual([]);
  });

  test('percentOfTask rounding to one decimal place', () => {
    const result = correlateLongtasksWithMarks(
      [{ startTime: 0, duration: 200 }],
      [{ name: 'fraction', startTime: 50, duration: 17 }],
    );
    expect(result[0]?.marksWithinTask[0]?.percentOfTask).toBe(8.5);
  });
});
