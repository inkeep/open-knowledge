
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
