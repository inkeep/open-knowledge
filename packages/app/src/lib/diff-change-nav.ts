/**
 * diff-change-nav — pure helpers for the full-pane diff "change stepper" shared
 * by `TimelineDiffPane` and `AgentDiffPane`. Both render a whole-file unified
 * diff and let the user jump between the contiguous changed-line runs.
 */

/** Count contiguous +/- runs in a unified-diff string — one per "change" for the stepper. */
export function countChangeGroups(diff: string): number {
  let count = 0;
  let inChange = false;
  for (const line of diff.split('\n')) {
    const isChange =
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'));
    if (isChange && !inChange) count += 1;
    inChange = isChange;
  }
  return count;
}

/**
 * First changed code cell of each consecutive changed-row run, in DOM order —
 * the scroll anchors for the change stepper. A new run starts whenever a changed
 * row is not the immediate sibling of the previous changed row (context between).
 */
export function collectChangeAnchors(container: HTMLElement): Element[] {
  const cells = Array.from(container.querySelectorAll('.diff-code-insert, .diff-code-delete'));
  const anchors: Element[] = [];
  let prevRow: Element | null = null;
  for (const cell of cells) {
    const row = cell.closest('tr');
    if (!row) continue;
    if (prevRow === null || row.previousElementSibling !== prevRow) anchors.push(cell);
    prevRow = row;
  }
  return anchors;
}
