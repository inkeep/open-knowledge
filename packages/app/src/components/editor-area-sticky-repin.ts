import type { Layout } from 'react-resizable-panels';

interface StickyRepinParams {
  /** The group's current layout: panel id -> percentage (0..100), from `getLayout()`. */
  currentLayout: Layout;
  /** The group's pixel width (the px→% conversion basis). */
  containerPx: number;
  /** Panels to hold at a fixed pixel width: panel id -> pixels (0 pins a collapse). */
  pinnedPx: Record<string, number>;
  /** The panel that absorbs whatever is left after the pins (the editor column). */
  residualId: string;
}

/**
 * Compute a pinned-widths layout for the horizontal editor group.
 *
 * react-resizable-panels stores each panel as a percentage of the group, and
 * its per-panel imperative APIs (`resize`/`collapse`/`expand`) rebalance
 * against the panel's flex NEIGHBOR. In the EDITOR | doc-panel |
 * terminal-column order that neighbor is never the editor, so any per-panel
 * correction moves a boundary between the two right-side panels: a container
 * widening grows the terminal instead of the editor, a doc-panel collapse
 * dumps its width into the terminal, and re-pinning one panel knocks the
 * other off its pin. Computing the whole layout once and applying it
 * atomically via the group's `setLayout` removes that ambiguity: the residual
 * (editor) panel takes exactly what the pins leave, whatever the topology.
 *
 * Returns a new `panelId -> percentage` map summing to 100. Pinned panels take
 * `px / containerPx`; other panels (e.g. the folder view's agent panel) keep
 * their current percentage; the residual panel takes the rest. Falls back to
 * the input layout — same reference, so callers can skip `setLayout` on
 * identity — when it can't compute a valid result: a non-positive container,
 * an absent residual panel, or pins that don't fit (a negative residual).
 */
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
