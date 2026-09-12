export const PROPERTY_CHANGE_ANCHOR_SELECTOR = '[data-property-change]';

const PIERRE_CHANGE_ROW_SELECTOR =
  '[data-content] > [data-line-type="change-addition"], [data-content] > [data-line-type="change-deletion"]';

function collectPierreChangeRows(container: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const host of container.querySelectorAll('diffs-container')) {
    const root = (host as HTMLElement).shadowRoot;
    if (!root) continue;
    rows.push(...root.querySelectorAll<HTMLElement>(PIERRE_CHANGE_ROW_SELECTOR));
  }
  return rows;
}

export interface PierreShadowWatcher {
  sync(): void;
  disconnect(): void;
}

export function watchPierreShadowRoots(
  container: HTMLElement,
  onMutation: () => void,
): PierreShadowWatcher {
  const observers = new Map<ShadowRoot, MutationObserver>();
  return {
    sync(): void {
      for (const host of container.querySelectorAll('diffs-container')) {
        const root = (host as HTMLElement).shadowRoot;
        if (root === null || observers.has(root)) continue;
        const observer = new MutationObserver(onMutation);
        observer.observe(root, { childList: true, subtree: true });
        observers.set(root, observer);
      }
    },
    disconnect(): void {
      for (const observer of observers.values()) observer.disconnect();
      observers.clear();
    },
  };
}

export function collectChangeAnchors(container: HTMLElement): Element[] {
  const rows = collectPierreChangeRows(container);
  const anchors: Element[] = [];
  let prevRow: Element | null = null;
  for (const row of rows) {
    if (prevRow === null || row.previousElementSibling !== prevRow) anchors.push(row);
    prevRow = row;
  }
  return anchors;
}
