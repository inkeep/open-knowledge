const GROUP_SELECTOR = ':scope > [data-group]';
const PANEL_SELECTOR = ':scope > [data-panel]';

export function findRailPanelGroup(container: Element | null | undefined): HTMLElement | null {
  const group = container?.querySelector(GROUP_SELECTOR);
  return group instanceof HTMLElement ? group : null;
}

function readRailPanelElements(group: HTMLElement): HTMLElement[] | null {
  const panels: HTMLElement[] = [];
  for (const panel of group.querySelectorAll(PANEL_SELECTOR)) {
    if (!(panel instanceof HTMLElement)) return null;
    panels.push(panel);
  }
  return panels.length === 0 ? null : panels;
}

function readPanelWidthPx(panel: HTMLElement): number | null {
  const { width } = panel.getBoundingClientRect();
  return Number.isFinite(width) && width >= 0 ? width : null;
}

export type RailPanelSpaceRefusal =
  | 'group-element-missing'
  | 'panels-unreadable'
  | 'panel-space-empty';

export type RailPanelSpaceResult =
  | { readonly ok: true; readonly panelSpacePx: number }
  | { readonly ok: false; readonly refusal: RailPanelSpaceRefusal };

/*
 * UPSTREAM(react-resizable-panels@4.9.0): this sum stands in for the library's own
 * `calculateAvailableGroupSize`, which `GroupImperativeHandle` exposes no accessor
 * for. That function never runs a selector; it reduces its own `group.panels`
 * registry over each registered panel's `element.offsetWidth`, and that total stays
 * authoritative for the clamp it feeds: the divisor turning the doc panel's px
 * `minSize`/`maxSize` into the percentages `setLayout` validates against. The two
 * totals are not equal. `offsetWidth` rounds per panel, and keeping that rounding
 * out of the rail arithmetic is why this file exists, so what must keep holding is
 * the element set rather than the total. The library requires panel elements to be
 * direct DOM children of their group (`react-resizable-panels.d.ts:212`), which is
 * what lets this selector stand in for its registry, so putting a wrapper between
 * the two drops a panel from this sum.
 */
export function resolveRailPanelSpace(container: Element | null | undefined): RailPanelSpaceResult {
  const group = findRailPanelGroup(container);
  if (group == null) return { ok: false, refusal: 'group-element-missing' };
  const panels = readRailPanelElements(group);
  if (panels == null) return { ok: false, refusal: 'panels-unreadable' };
  let panelSpacePx = 0;
  for (const panel of panels) {
    const widthPx = readPanelWidthPx(panel);
    if (widthPx == null) return { ok: false, refusal: 'panel-space-empty' };
    panelSpacePx += widthPx;
  }
  return panelSpacePx > 0
    ? { ok: true, panelSpacePx }
    : { ok: false, refusal: 'panel-space-empty' };
}

export function resolveRailPanelSpacePx(container: Element | null | undefined): number | null {
  const result = resolveRailPanelSpace(container);
  return result.ok ? result.panelSpacePx : null;
}

export interface RailWidthShortfall {
  readonly targetPx: number;
  readonly renderedPx: number | null;
}

function missesExactTarget(renderedPx: number, targetPx: number): boolean {
  return Math.abs(renderedPx - targetPx) > 1;
}

function collectShortfall(
  targetsPx: Readonly<Record<string, number>>,
  renderedWidths: ReadonlyMap<string, number>,
  isShort: (renderedPx: number, targetPx: number) => boolean,
): Record<string, RailWidthShortfall> {
  const shortfall: Record<string, RailWidthShortfall> = {};
  for (const [id, targetPx] of Object.entries(targetsPx)) {
    const renderedPx = renderedWidths.get(id);
    if (renderedPx == null) {
      shortfall[id] = { targetPx, renderedPx: null };
      continue;
    }
    if (!isShort(renderedPx, targetPx)) continue;
    shortfall[id] = { targetPx, renderedPx };
  }
  return shortfall;
}

export function describeRailWidthShortfall(
  pinnedPx: Readonly<Record<string, number>>,
  renderedWidths: ReadonlyMap<string, number>,
): Record<string, RailWidthShortfall> {
  return collectShortfall(pinnedPx, renderedWidths, missesExactTarget);
}

export function describeRailFloorShortfall(
  floorPx: Readonly<Record<string, number>>,
  renderedWidths: ReadonlyMap<string, number>,
): Record<string, RailWidthShortfall> {
  return collectShortfall(floorPx, renderedWidths, (renderedPx, targetPx) =>
    targetPx === 0 ? missesExactTarget(renderedPx, targetPx) : renderedPx < targetPx - 1,
  );
}
