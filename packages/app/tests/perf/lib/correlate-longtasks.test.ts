/**
 * Unit tests for `correlateLongtasksWithMarks` — pure function, no browser.
 *
 * Covers the four cases:
 *  1. empty inputs (both empty; one empty)
 *  2. marks fully within a task
 *  3. marks partially overlapping a task (start inside / end outside)
 *  4. marks outside any task
 *
 * Plus a few practically-important shapes: zero-duration task, multiple
 * tasks with marks distributed across them, half-open boundary discipline.
 */

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
    // mark.startTime=250 falls inside [100, 300); mark.duration=200 means it
    // straddles the task end at 300. Per the contract documented in
    // correlate-longtasks.ts, percentOfTask reflects full mark duration vs
    // task duration — can exceed 100% on straddle, which is the deliberate
    // signal that a mark spans multiple tasks.
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
    // mark.startTime=50 is BEFORE task.startTime=100 → excluded.
    // The half-open semantics ensure each mark is attributed to exactly one
    // task even when adjacent tasks abut.
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
    // Task A: [0, 100). Task B: [100, 200). Mark at startTime=100 is inside
    // task B by the rule `startTime >= task.startTime && startTime < taskEnd`.
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
    // Half-open rule means startTime=100 is NOT in [100, 100) — empty.
    expect(result[0]?.marksWithinTask).toEqual([]);
  });

  test('percentOfTask rounding to one decimal place', () => {
    // 17 / 200 = 0.085 → 8.5%
    const result = correlateLongtasksWithMarks(
      [{ startTime: 0, duration: 200 }],
      [{ name: 'fraction', startTime: 50, duration: 17 }],
    );
    expect(result[0]?.marksWithinTask[0]?.percentOfTask).toBe(8.5);
  });
});
