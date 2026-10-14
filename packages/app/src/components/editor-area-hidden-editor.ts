import type { Layout } from 'react-resizable-panels';

const SETTLED_TOLERANCE_PCT = 0.5;

interface EditorHiddenLayoutParams {
  readonly currentLayout: Layout;
  readonly editorColumnId: string;
  readonly visibleColumnPx: Readonly<Record<string, number>>;
}

function visibleColumnIds({
  currentLayout,
  visibleColumnPx,
}: EditorHiddenLayoutParams): readonly string[] {
  return Object.entries(visibleColumnPx)
    .filter(([id, px]) => id in currentLayout && px > 0)
    .map(([id]) => id);
}

export function isEditorHiddenLayoutSettled(params: EditorHiddenLayoutParams): boolean {
  const { currentLayout, editorColumnId } = params;
  if (!(editorColumnId in currentLayout)) return false;
  const visible = new Set(visibleColumnIds(params));
  if (visible.size === 0) visible.add(editorColumnId);
  let visibleSum = 0;
  for (const [id, pct] of Object.entries(currentLayout)) {
    if (visible.has(id)) {
      if (pct <= SETTLED_TOLERANCE_PCT) return false;
      visibleSum += pct;
    } else if (pct > SETTLED_TOLERANCE_PCT) {
      return false;
    }
  }
  return Math.abs(visibleSum - 100) <= SETTLED_TOLERANCE_PCT;
}

export function computeEditorHiddenLayout(params: EditorHiddenLayoutParams): Layout {
  const { currentLayout, editorColumnId, visibleColumnPx } = params;
  if (!(editorColumnId in currentLayout)) return currentLayout;
  const visible = visibleColumnIds(params);
  const next: Layout = {};
  for (const id of Object.keys(currentLayout)) next[id] = 0;
  if (visible.length === 0) {
    next[editorColumnId] = 100;
    return next;
  }
  const totalPx = visible.reduce((sum, id) => sum + (visibleColumnPx[id] ?? 0), 0);
  for (const id of visible) next[id] = ((visibleColumnPx[id] ?? 0) / totalPx) * 100;
  return next;
}

export function editorHiddenLayoutLanded(target: Layout, readBack: Layout): boolean {
  return Object.entries(target).every(
    ([id, pct]) => Math.abs((readBack[id] ?? 0) - pct) <= SETTLED_TOLERANCE_PCT,
  );
}
