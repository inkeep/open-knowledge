import { isPaneId, type PaneId } from './pane-visibility-store';

export type DockDirection = 'row' | 'column';

export type DockEdge = 'start' | 'end' | 'top' | 'bottom';

export interface DockLeaf {
  readonly pane: PaneId;
}

interface DockItem {
  readonly size: number;
  readonly node: DockNode;
  readonly alongEdge?: true;
}

export interface DockGroup {
  readonly direction: DockDirection;
  readonly items: readonly DockItem[];
}

export type DockNode = DockLeaf | DockGroup;

export type DockPath = readonly number[];

export interface VisibleDockLeaf {
  readonly pane: PaneId;
}

interface VisibleDockItem {
  readonly slot: number;
  readonly share: number;
  readonly node: VisibleDockNode;
}

export interface VisibleDockGroup {
  readonly path: DockPath;
  readonly direction: DockDirection;
  readonly items: readonly VisibleDockItem[];
}

export type VisibleDockNode = VisibleDockLeaf | VisibleDockGroup;

const DOCK_PANE_ORDER = { editor: true, terminal: true, agents: true } satisfies Record<
  PaneId,
  true
>;

export const DOCK_PANES = Object.keys(DOCK_PANE_ORDER) as readonly PaneId[];

const MAX_DOCK_DEPTH = DOCK_PANES.length;

export const DEFAULT_CHAT_SHARE = 1 / 3.5;
export const DEFAULT_BOTTOM_TERMINAL_SHARE = 1 / 3.3;

export const DOCK_EDGE_SHARE = {
  editor: 1 - DEFAULT_CHAT_SHARE,
  agents: DEFAULT_CHAT_SHARE,
} as const satisfies Record<Exclude<PaneId, 'terminal'>, number>;

export function bottomTerminalDockTree(chatShare: number, terminalShare: number): DockGroup {
  return {
    direction: 'row',
    items: [
      {
        size: 1 - chatShare,
        node: {
          direction: 'column',
          items: [
            { size: 1 - terminalShare, node: { pane: 'editor' } },
            { size: terminalShare, node: { pane: 'terminal' } },
          ],
        },
      },
      { size: chatShare, node: { pane: 'agents' } },
    ],
  };
}

export const DEFAULT_DOCK_TREE: DockGroup = bottomTerminalDockTree(
  DEFAULT_CHAT_SHARE,
  DEFAULT_BOTTOM_TERMINAL_SHARE,
);

export function isDockLeaf(node: DockNode): node is DockLeaf {
  return 'pane' in node;
}

export function isVisibleDockLeaf(node: VisibleDockNode): node is VisibleDockLeaf {
  return 'pane' in node;
}

export function dockEdgeDirection(edge: DockEdge): DockDirection {
  return edge === 'start' || edge === 'end' ? 'row' : 'column';
}

function edgeLeads(edge: DockEdge): boolean {
  return edge === 'start' || edge === 'top';
}

export function dockTreePanes(node: DockNode): PaneId[] {
  if (isDockLeaf(node)) return [node.pane];
  return node.items.flatMap((item) => dockTreePanes(item.node));
}

function parseDockNode(value: unknown, depth: number): DockNode | null {
  if (typeof value !== 'object' || value === null || depth > MAX_DOCK_DEPTH) return null;
  const record = value as Record<string, unknown>;
  if ('pane' in record) return isPaneId(record.pane) ? { pane: record.pane } : null;
  if (record.direction !== 'row' && record.direction !== 'column') return null;
  if (!Array.isArray(record.items) || record.items.length < 2) return null;
  const items: DockItem[] = [];
  for (const raw of record.items) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { size, node, alongEdge } = raw as Record<string, unknown>;
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null;
    const child = parseDockNode(node, depth + 1);
    if (child === null) return null;
    items.push(alongEdge === true ? { size, node: child, alongEdge } : { size, node: child });
  }
  return { direction: record.direction, items };
}

function hasUsableSizes(node: DockNode): boolean {
  return (
    isDockLeaf(node) ||
    node.items.every(
      (item) => Number.isFinite(item.size) && item.size > 0 && hasUsableSizes(item.node),
    )
  );
}

export function parseDockTree(value: unknown): DockNode | null {
  const node = parseDockNode(value, 0);
  if (node === null) return null;
  const panes = dockTreePanes(node);
  if (panes.length !== DOCK_PANES.length || new Set(panes).size !== panes.length) return null;
  const tree = normalizeDockTree(node);
  return hasUsableSizes(tree) ? tree : null;
}

function normalizedItems(items: readonly DockItem[]): DockItem[] {
  const total = items.reduce((sum, item) => sum + item.size, 0);
  return items.map((item) => ({ ...item, size: item.size / total }));
}

export function normalizeDockTree(node: DockNode): DockNode {
  if (isDockLeaf(node)) return node;
  const items: DockItem[] = [];
  for (const item of node.items) {
    const child = normalizeDockTree(item.node);
    if (!isDockLeaf(child) && child.direction === node.direction) {
      for (const nested of child.items) {
        items.push({ ...nested, size: item.size * nested.size });
      }
    } else {
      items.push({ ...item, node: child });
    }
  }
  const only = items[0];
  if (items.length === 1 && only !== undefined) return only.node;
  return { direction: node.direction, items: normalizedItems(items) };
}

function visibleDockNode(
  node: DockNode,
  path: DockPath,
  isVisible: (pane: PaneId) => boolean,
): VisibleDockNode | null {
  if (isDockLeaf(node)) return isVisible(node.pane) ? { pane: node.pane } : null;
  const kept: { slot: number; size: number; node: VisibleDockNode }[] = [];
  node.items.forEach((item, slot) => {
    const child = visibleDockNode(item.node, [...path, slot], isVisible);
    if (child !== null) kept.push({ slot, size: item.size, node: child });
  });
  const only = kept[0];
  if (kept.length === 1 && only !== undefined) return only.node;
  if (kept.length === 0) return null;
  const total = kept.reduce((sum, item) => sum + item.size, 0);
  return {
    path,
    direction: node.direction,
    items: kept.map((item) => ({ slot: item.slot, share: item.size / total, node: item.node })),
  };
}

export function visibleDockTree(
  tree: DockNode,
  isVisible: (pane: PaneId) => boolean,
): VisibleDockNode | null {
  return visibleDockNode(tree, [], isVisible);
}

function groupAt(tree: DockNode, path: DockPath): DockGroup | null {
  let node = tree;
  for (const slot of path) {
    if (isDockLeaf(node)) return null;
    const item = node.items[slot];
    if (item === undefined) return null;
    node = item.node;
  }
  return isDockLeaf(node) ? null : node;
}

function replaceAt(tree: DockNode, path: DockPath, next: DockNode): DockNode {
  const [slot, ...rest] = path;
  if (slot === undefined) return next;
  if (isDockLeaf(tree)) return tree;
  return {
    direction: tree.direction,
    items: tree.items.map((item, index) =>
      index === slot ? { ...item, node: replaceAt(item.node, rest, next) } : item,
    ),
  };
}

export function resizeDockGroup(
  tree: DockNode,
  path: DockPath,
  shares: ReadonlyMap<number, number>,
): DockNode {
  const group = groupAt(tree, path);
  if (group === null) return tree;
  let visibleTotal = 0;
  let shareTotal = 0;
  for (const [slot, share] of shares) {
    const item = group.items[slot];
    if (item === undefined || !Number.isFinite(share) || share <= 0) return tree;
    visibleTotal += item.size;
    shareTotal += share;
  }
  if (visibleTotal <= 0 || shareTotal <= 0) return tree;
  const items = group.items.map((item, slot) => {
    const share = shares.get(slot);
    return share === undefined ? item : { ...item, size: (share / shareTotal) * visibleTotal };
  });
  return replaceAt(tree, path, { direction: group.direction, items: normalizedItems(items) });
}

function heirIndex(index: number): number {
  return index > 0 ? index - 1 : index + 1;
}

export function withoutDockPane(node: DockNode, pane: PaneId): DockNode | null {
  if (isDockLeaf(node)) return node.pane === pane ? null : node;
  const kept = node.items.map((item) => ({ item, node: withoutDockPane(item.node, pane) }));
  const removed = kept.findIndex((entry) => entry.node === null);
  const gone = kept[removed]?.item;
  const heir = gone?.alongEdge ? undefined : kept[heirIndex(removed)];
  const items = kept.flatMap(({ item, node: child }) => {
    if (child === null) return [];
    const size = item.size + (gone !== undefined && heir?.item === item ? gone.size : 0);
    return [{ ...item, size, node: child }];
  });
  const only = items[0];
  if (items.length === 1 && only !== undefined) return only.node;
  if (items.length === 0) return null;
  return { direction: node.direction, items: gone?.alongEdge ? normalizedItems(items) : items };
}

export function dockPaneExtent(
  node: DockNode,
  pane: PaneId,
  direction: DockDirection,
): number | null {
  if (isDockLeaf(node)) return node.pane === pane ? 1 : null;
  for (const item of node.items) {
    const inner = dockPaneExtent(item.node, pane, direction);
    if (inner !== null) return node.direction === direction ? item.size * inner : inner;
  }
  return null;
}

function withPaneBeside(
  node: DockNode,
  target: PaneId,
  pane: PaneId,
  edge: DockEdge,
  share: number,
): DockNode {
  const direction = dockEdgeDirection(edge);
  if (isDockLeaf(node)) {
    if (node.pane !== target) return node;
    const inserted: DockItem = { size: share, node: { pane } };
    const kept: DockItem = { size: 1 - share, node };
    return { direction, items: edgeLeads(edge) ? [inserted, kept] : [kept, inserted] };
  }
  const index = node.items.findIndex((item) => isDockLeaf(item.node) && item.node.pane === target);
  const item = node.items[index];
  if (item !== undefined && node.direction === direction) {
    const kept: DockItem = { ...item, size: item.size * (1 - share) };
    const placed: DockItem = { size: item.size * share, node: { pane } };
    const items = [...node.items];
    items.splice(index, 1, ...(edgeLeads(edge) ? [placed, kept] : [kept, placed]));
    return { direction: node.direction, items };
  }
  return {
    direction: node.direction,
    items: node.items.map((child) => ({
      ...child,
      node: withPaneBeside(child.node, target, pane, edge, share),
    })),
  };
}

function clampDockShare(share: number): number {
  return Math.min(Math.max(share, 0.05), 0.95);
}

export function moveDockPane(
  tree: DockNode,
  pane: PaneId,
  target: PaneId,
  edge: DockEdge,
  share = 0.5,
): DockNode {
  if (pane === target) return tree;
  const rest = withoutDockPane(tree, pane);
  if (rest === null || !dockTreePanes(rest).includes(target)) return tree;
  return normalizeDockTree(withPaneBeside(rest, target, pane, edge, clampDockShare(share)));
}

function isAlongEdge(tree: DockNode, pane: PaneId, edge: DockEdge): boolean {
  if (isDockLeaf(tree) || tree.direction !== dockEdgeDirection(edge)) return false;
  const outer = edgeLeads(edge) ? tree.items[0] : tree.items.at(-1);
  return outer !== undefined && isDockLeaf(outer.node) && outer.node.pane === pane;
}

export function moveDockPaneToEdge(
  tree: DockNode,
  pane: PaneId,
  edge: DockEdge,
  share: number,
): DockNode {
  if (isAlongEdge(tree, pane, edge)) return tree;
  const rest = withoutDockPane(tree, pane);
  if (rest === null) return tree;
  const placed: DockItem = { size: clampDockShare(share), node: { pane }, alongEdge: true };
  const kept: DockItem = { size: 1 - placed.size, node: rest };
  return normalizeDockTree({
    direction: dockEdgeDirection(edge),
    items: edgeLeads(edge) ? [placed, kept] : [kept, placed],
  });
}

export function swapDockPanes(node: DockNode, a: PaneId, b: PaneId): DockNode {
  if (isDockLeaf(node)) {
    if (node.pane === a) return { pane: b };
    return node.pane === b ? { pane: a } : node;
  }
  return {
    direction: node.direction,
    items: node.items.map((item) => ({ ...item, node: swapDockPanes(item.node, a, b) })),
  };
}

export function dockPaneDirection(tree: DockNode, pane: PaneId): DockDirection | null {
  if (isDockLeaf(tree)) return null;
  for (const item of tree.items) {
    if (isDockLeaf(item.node) && item.node.pane === pane) return tree.direction;
    const nested = dockPaneDirection(item.node, pane);
    if (nested !== null) return nested;
  }
  return null;
}
