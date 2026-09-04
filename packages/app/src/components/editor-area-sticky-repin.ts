import type { Layout } from 'react-resizable-panels';

interface StickyRepinParams {
  currentLayout: Layout;
  containerPx: number;
  pinnedPx: Record<string, number>;
  residualId: string;
}

export function computeStickyRepinLayout(params: StickyRepinParams): Layout {
  const { currentLayout, containerPx, pinnedPx, residualId } = params;
  if (containerPx <= 0) return currentLayout;
  if (!(residualId in currentLayout)) return currentLayout;

  const next: Layout = { ...currentLayout };
  let pinnedPctSum = 0;
  for (const [id, px] of Object.entries(pinnedPx)) {
    if (!(id in currentLayout)) continue;
    const pct = (px / containerPx) * 100;
    next[id] = pct;
    pinnedPctSum += pct;
  }

  let otherPctSum = 0;
  for (const [id, pct] of Object.entries(currentLayout)) {
    if (id === residualId || id in pinnedPx) continue;
    otherPctSum += pct;
  }

  const residualPct = 100 - pinnedPctSum - otherPctSum;
  if (residualPct < 0) return currentLayout;
  next[residualId] = residualPct;
  return next;
}
