import { MIN_TERMINAL_RIGHT_WIDTH } from '@inkeep/open-knowledge-core/terminal-layout';
import {
  type DockDirection,
  type DockPath,
  isVisibleDockLeaf,
  type VisibleDockGroup,
  type VisibleDockNode,
} from './dock-tree';
import type { PaneId } from './pane-visibility-store';

export interface DockRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DockExtent {
  readonly width: number;
  readonly height: number;
}

export interface DockSeam {
  readonly path: DockPath;
  readonly direction: DockDirection;
  readonly index: number;
  readonly rect: DockRect;
  readonly slots: readonly number[];
  readonly lengths: readonly number[];
  readonly minLengths: readonly number[];
  readonly after: readonly PaneId[];
}

export interface DockLayout {
  readonly panes: ReadonlyMap<PaneId, DockRect>;
  readonly seams: readonly DockSeam[];
}

export const EMPTY_DOCK_LAYOUT: DockLayout = { panes: new Map(), seams: [] };

const DOCK_PANE_MIN_EXTENT: Readonly<Record<PaneId, DockExtent>> = {
  editor: { width: 340, height: 180 },
  agents: { width: 290, height: 170 },
  terminal: { width: MIN_TERMINAL_RIGHT_WIDTH, height: 120 },
};

export function dockPaneMinExtent(pane: PaneId): DockExtent {
  return DOCK_PANE_MIN_EXTENT[pane];
}

type MinExtentOf = (pane: PaneId) => DockExtent;

function axisLength(extent: DockExtent, direction: DockDirection): number {
  return direction === 'row' ? extent.width : extent.height;
}

export function minDockExtent(node: VisibleDockNode, minOf: MinExtentOf, gap: number): DockExtent {
  if (isVisibleDockLeaf(node)) return minOf(node.pane);
  const children = node.items.map((item) => minDockExtent(item.node, minOf, gap));
  const gaps = gap * (children.length - 1);
  const along = children.reduce((sum, child) => sum + axisLength(child, node.direction), 0) + gaps;
  const across = Math.max(
    ...children.map((child) => axisLength(child, node.direction === 'row' ? 'column' : 'row')),
  );
  return node.direction === 'row'
    ? { width: along, height: across }
    : { width: across, height: along };
}

export function fitDockLengths(
  desired: readonly number[],
  mins: readonly number[],
  total: number,
): number[] {
  const room = Math.max(total, 0);
  const minTotal = mins.reduce((sum, min) => sum + min, 0);
  if (minTotal >= room) {
    return minTotal === 0 ? desired.map(() => 0) : mins.map((min) => (min / minTotal) * room);
  }
  const fixed = new Set<number>();
  let lengths = [...desired];
  for (let round = 0; round <= desired.length; round += 1) {
    const fixedLength = [...fixed].reduce((sum, index) => sum + (mins[index] ?? 0), 0);
    const freeDesired = desired.reduce(
      (sum, length, index) => (fixed.has(index) ? sum : sum + length),
      0,
    );
    const freeRoom = room - fixedLength;
    lengths = desired.map((length, index) => {
      if (fixed.has(index)) return mins[index] ?? 0;
      return freeDesired > 0
        ? (length / freeDesired) * freeRoom
        : freeRoom / (desired.length - fixed.size);
    });
    const short = lengths.findIndex(
      (length, index) => !fixed.has(index) && length < (mins[index] ?? 0),
    );
    if (short < 0) break;
    lengths.forEach((length, index) => {
      if (!fixed.has(index) && length < (mins[index] ?? 0)) fixed.add(index);
    });
  }
  return lengths;
}

function panesOf(node: VisibleDockNode): PaneId[] {
  if (isVisibleDockLeaf(node)) return [node.pane];
  return node.items.flatMap((item) => panesOf(item.node));
}

function layoutGroup(
  group: VisibleDockGroup,
  bounds: DockRect,
  gap: number,
  minOf: MinExtentOf,
  panes: Map<PaneId, DockRect>,
  seams: DockSeam[],
) {
  const row = group.direction === 'row';
  const along = row ? bounds.width : bounds.height;
  const room = along - gap * (group.items.length - 1);
  const mins = group.items.map((item) =>
    axisLength(minDockExtent(item.node, minOf, gap), group.direction),
  );
  const lengths = fitDockLengths(
    group.items.map((item) => item.share * Math.max(room, 0)),
    mins,
    room,
  );
  let cursor = row ? bounds.x : bounds.y;
  const starts: number[] = [];
  const ends: number[] = [];
  group.items.forEach((item, index) => {
    const start = Math.round(cursor);
    const end = Math.round(cursor + (lengths[index] ?? 0));
    const rect: DockRect = row
      ? { x: start, y: bounds.y, width: end - start, height: bounds.height }
      : { x: bounds.x, y: start, width: bounds.width, height: end - start };
    layoutNode(item.node, rect, gap, minOf, panes, seams);
    starts.push(start);
    ends.push(end);
    cursor += (lengths[index] ?? 0) + gap;
  });
  const roundedLengths = ends.map((end, index) => end - (starts[index] ?? end));
  for (let index = 0; index < group.items.length - 1; index += 1) {
    const seamStart = ends[index] ?? 0;
    const after = group.items[index + 1];
    if (after === undefined) continue;
    seams.push({
      path: group.path,
      direction: group.direction,
      index,
      rect: row
        ? { x: seamStart, y: bounds.y, width: gap, height: bounds.height }
        : { x: bounds.x, y: seamStart, width: bounds.width, height: gap },
      slots: group.items.map((item) => item.slot),
      lengths: roundedLengths,
      minLengths: mins,
      after: panesOf(after.node),
    });
  }
}

function layoutNode(
  node: VisibleDockNode,
  bounds: DockRect,
  gap: number,
  minOf: MinExtentOf,
  panes: Map<PaneId, DockRect>,
  seams: DockSeam[],
) {
  if (isVisibleDockLeaf(node)) {
    panes.set(node.pane, bounds);
    return;
  }
  layoutGroup(node, bounds, gap, minOf, panes, seams);
}

export function layoutDock(
  node: VisibleDockNode | null,
  bounds: DockRect,
  gap: number,
  minOf: MinExtentOf,
): DockLayout {
  if (node === null || bounds.width <= 0 || bounds.height <= 0) return EMPTY_DOCK_LAYOUT;
  const panes = new Map<PaneId, DockRect>();
  const seams: DockSeam[] = [];
  layoutNode(node, bounds, gap, minOf, panes, seams);
  return { panes, seams };
}

export function clampDockSeam(seam: DockSeam, beforeLength: number): number {
  const before = seam.lengths[seam.index] ?? 0;
  const after = seam.lengths[seam.index + 1] ?? 0;
  const pair = before + after;
  const minBefore = seam.minLengths[seam.index] ?? 0;
  const minAfter = seam.minLengths[seam.index + 1] ?? 0;
  if (minBefore + minAfter >= pair) return before;
  return Math.min(Math.max(beforeLength, minBefore), pair - minAfter);
}

export function dockSeamShares(seam: DockSeam, beforeLength: number): Map<number, number> {
  const clamped = clampDockSeam(seam, beforeLength);
  const lengths = [...seam.lengths];
  const pair = (lengths[seam.index] ?? 0) + (lengths[seam.index + 1] ?? 0);
  lengths[seam.index] = clamped;
  lengths[seam.index + 1] = pair - clamped;
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const shares = new Map<number, number>();
  seam.slots.forEach((slot, index) => {
    shares.set(slot, total > 0 ? (lengths[index] ?? 0) / total : 1 / seam.slots.length);
  });
  return shares;
}

export function dockSeamPercent(seam: DockSeam): { now: number; min: number; max: number } {
  const before = seam.lengths[seam.index] ?? 0;
  const after = seam.lengths[seam.index + 1] ?? 0;
  const pair = before + after;
  if (pair <= 0) return { now: 50, min: 0, max: 100 };
  const minBefore = seam.minLengths[seam.index] ?? 0;
  const minAfter = seam.minLengths[seam.index + 1] ?? 0;
  const percent = (value: number) => Math.round((value / pair) * 100);
  return {
    now: percent(after),
    min: Math.min(percent(minAfter), percent(after)),
    max: Math.max(100 - percent(minBefore), percent(after)),
  };
}
