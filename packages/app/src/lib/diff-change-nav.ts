export const PROPERTY_CHANGE_ANCHOR_SELECTOR = '[data-property-change]';

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
