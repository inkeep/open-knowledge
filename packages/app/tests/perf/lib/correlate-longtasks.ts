/**
 * Long-task ↔ user-mark correlator.
 *
 * The 2.7 s "freeze-halting" longest-task that motivates this perf work shows
 * up as a single PerformanceObserver entry — opaque on its own. By joining
 * each long-task entry with the `ok/*` user marks whose start time falls
 * within the task's `[startTime, startTime+duration]` window, we turn the
 * lump into a per-span breakdown ("decoration plugin: 540 ms / 22%, NodeView
 * factories: 1100 ms / 41%, ...").
 *
 * "Within" semantics: a mark is considered to land within a task if its
 * `startTime >= task.startTime` and `startTime < task.startTime + task.duration`.
 * Half-open by design — a mark whose startTime equals the task's end is
 * counted as the next task, not the current one. Marks that straddle the
 * end-boundary are still recorded (their start falls inside) and their
 * `percentOfTask` reflects the full mark duration relative to the task,
 * which can exceed 100% — that's a deliberate signal that the mark spans
 * multiple long-tasks.
 *
 * Both inputs are expected to share the `performance.now()` timeline (the
 * default for both `PerformanceObserver` long-task entries and `mark()`/
 * `measure()` calls), so no clock alignment is needed.
 */

export interface LongTaskInput {
  startTime: number;
  duration: number;
  name?: string;
}

export interface MarkInput {
  name: string;
  startTime: number;
  duration: number;
}

export interface MarkWithinTask {
  name: string;
  durationMs: number;
  percentOfTask: number;
}

export interface CorrelatedLongTask {
  taskMs: number;
  taskStartMs: number;
  marksWithinTask: MarkWithinTask[];
}

/**
 * Join long tasks with marks by timestamp range.
 *
 * Returns one entry per long task, with `marksWithinTask` listing every
 * mark whose `startTime` falls inside `[task.startTime, task.startTime +
 * task.duration)`. `percentOfTask` is `100 * mark.duration / task.duration`,
 * rounded to one decimal. Tasks of zero duration produce a `percentOfTask`
 * of 0 to avoid division by zero (the entry is still emitted so the caller
 * can see which marks landed at that instant).
 */
export function correlateLongtasksWithMarks(
  longtasks: readonly LongTaskInput[],
  marks: readonly MarkInput[],
): CorrelatedLongTask[] {
  return longtasks.map((task) => {
    const taskEnd = task.startTime + task.duration;
    const marksWithinTask: MarkWithinTask[] = [];
    for (const mark of marks) {
      if (mark.startTime >= task.startTime && mark.startTime < taskEnd) {
        const percentOfTask =
          task.duration > 0 ? Math.round((mark.duration / task.duration) * 1000) / 10 : 0;
        marksWithinTask.push({
          name: mark.name,
          durationMs: mark.duration,
          percentOfTask,
        });
      }
    }
    return {
      taskMs: task.duration,
      taskStartMs: task.startTime,
      marksWithinTask,
    };
  });
}
