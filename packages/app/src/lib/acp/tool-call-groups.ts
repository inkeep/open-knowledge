export interface ToolRun {
  readonly start: number;
  readonly size: number;
}

const MIN_GROUPED_RUN = 3;

export function adjacentToolRuns<T>(
  items: readonly T[],
  keyOf: (item: T) => string | null,
  minSize: number = MIN_GROUPED_RUN,
): ToolRun[] {
  const runs: ToolRun[] = [];
  let start = 0;
  while (start < items.length) {
    const head = items[start];
    const headKey = head === undefined ? null : keyOf(head);
    if (headKey === null) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < items.length) {
      const next = items[end];
      if (next === undefined || keyOf(next) !== headKey) break;
      end += 1;
    }
    const size = end - start;
    if (size >= minSize) runs.push({ start, size });
    start = end;
  }
  return runs;
}
