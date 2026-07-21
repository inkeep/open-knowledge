import { hashFromDocName } from '@/lib/doc-hash';

interface DocGraphNode {
  kind: 'doc';
  id: string;
  label: string;
  docName: string;
  anchor: string | null;
  cluster?: string | null;
  category?: string | null;
  tags?: string[] | null;
  /** Wall-clock ms this node first entered the rendered graph (birth animation). */
  bornAt?: number;
}

interface ExternalGraphNode {
  kind: 'external';
  id: string;
  label: string;
  url: string;
  /** Wall-clock ms this node first entered the rendered graph (birth animation). */
  bornAt?: number;
}

export type GraphNode = DocGraphNode | ExternalGraphNode;

export interface GraphLink {
  source: string;
  target: string;
  /** Wall-clock ms this link first entered the rendered graph (fade-in). */
  bornAt?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

// Intentionally a separate type from `TargetDisplayState` in target-navigation-intent.ts,
// which is not exported. The two types are identical in shape but belong to different
// layers — keep them decoupled so graph-view-utils has no dependency on the navigation layer.
export type GraphDocDisplayState = 'doc' | 'folder' | 'missing';

type GraphNodePhysicsKey =
  | 'x'
  | 'y'
  | 'z'
  | 'vx'
  | 'vy'
  | 'vz'
  | 'fx'
  | 'fy'
  | 'fz'
  | 'index'
  | '__indexColor';

type MutableGraphNode = GraphNode & Partial<Record<GraphNodePhysicsKey, number | string | null>>;
type MutableGraphLink = GraphLink & {
  source: unknown;
  target: unknown;
  __indexColor?: string;
};

type GraphDocSelection = Pick<DocGraphNode, 'docName' | 'label' | 'anchor'>;
export type GraphNodeSelection =
  | ({
      kind: 'doc';
    } & Pick<DocGraphNode, 'id' | 'docName' | 'label' | 'anchor'>)
  | ({
      kind: 'external';
    } & Pick<ExternalGraphNode, 'id' | 'label' | 'url'>);

export type GraphDocClickBehavior = 'navigate' | 'select';
export type GraphNodeVisualState =
  | 'default'
  | 'active'
  | 'selected'
  | 'active-selected'
  | 'external-selected'
  | 'external';

const DEFAULT_GRAPH_NODE_RADIUS = 5;
const SELECTED_GRAPH_NODE_RADIUS = 7;
const ACTIVE_GRAPH_NODE_RADIUS = 8;
const GRAPH_NODE_PHYSICS_KEYS = [
  'x',
  'y',
  'z',
  'vx',
  'vy',
  'vz',
  'fx',
  'fy',
  'fz',
  'index',
  '__indexColor',
] as const satisfies readonly GraphNodePhysicsKey[];

type GraphNodeClickAction =
  | { kind: 'external'; url: string }
  | { kind: 'navigate'; hash: string }
  | { kind: 'select'; selection: GraphNodeSelection };

function copyGraphNodePhysics(nextNode: MutableGraphNode, prevNode: MutableGraphNode): void {
  for (const key of GRAPH_NODE_PHYSICS_KEYS) {
    const value = prevNode[key];
    if (value !== undefined) {
      nextNode[key] = value;
    }
  }
}

export function getGraphLinkEndpointId(endpoint: unknown): string {
  if (typeof endpoint === 'string') return endpoint;
  if (endpoint !== null && typeof endpoint === 'object' && 'id' in endpoint) {
    return String((endpoint as { id: unknown }).id);
  }
  return '';
}

export function buildGraphNodeSignature(nodes: GraphNode[]): string {
  return nodes.map((node) => `${node.id}:${node.label}`).join(',');
}

export function buildGraphLinkSignature(links: GraphLink[]): string {
  return links
    .map((link) => `${getGraphLinkEndpointId(link.source)}>${getGraphLinkEndpointId(link.target)}`)
    .join(',');
}

/**
 * Staged-entrance pacing for `reconcileGraphData`. Agents deliver a whole
 * page batch in one CC1 push, so every new node would otherwise stamp the
 * same `bornAt` and bloom simultaneously. With entrance options, the i-th
 * new node of an apply is born `i * nodeStepMs` later (a sequential pop-in
 * replay of the build), and each new link waits for BOTH endpoints plus
 * `linkExtraMs`, so edges draw between nodes that are already visible.
 */
export interface ReconcileEntranceOptions {
  nodeStepMs: number;
  linkExtraMs: number;
  /**
   * Pre-build content (the showcase's build-start baseline): these nodes and
   * links materialize INSTANTLY (`bornAt: 0`, no birth animation) even on a
   * fresh mount — the staged replay is for what the agent ADDED, not for
   * re-birthing everything that already existed.
   */
  instantNodeIds?: ReadonlySet<string>;
  instantLinkKeys?: ReadonlySet<string>;
}

/**
 * Merge a fresh API graph into the rendered one, preserving force-layout
 * physics for surviving nodes and stamping `bornAt` on first appearance so the
 * canvas can fade/scale new nodes and links in. `now` is injectable for tests.
 * `entrance` (showcase mode) staggers same-apply arrivals — see
 * {@link ReconcileEntranceOptions}.
 */
export function reconcileGraphData(
  previous: GraphData,
  next: GraphData,
  now: number = Date.now(),
  entrance?: ReconcileEntranceOptions,
): GraphData {
  const previousNodesById = new Map(
    (previous.nodes as MutableGraphNode[]).map((node) => [node.id, node] as const),
  );
  const newNodes: MutableGraphNode[] = [];
  const nextNodes = next.nodes.map((node) => {
    const mergedNode = { ...node } as MutableGraphNode;
    const previousNode = previousNodesById.get(node.id);
    if (previousNode) {
      copyGraphNodePhysics(mergedNode, previousNode);
      mergedNode.bornAt = previousNode.bornAt ?? now;
    } else if (entrance?.instantNodeIds?.has(node.id)) {
      // Pre-build content on a fresh mount — present, not born.
      mergedNode.bornAt = 0;
    } else {
      mergedNode.bornAt = now;
      newNodes.push(mergedNode);
    }
    return mergedNode as GraphNode;
  });
  // A lone arrival needs no pacing; a clump gets the sequential entrance.
  // API order approximates creation order (the write batch is ordered).
  if (entrance !== undefined && newNodes.length > 1) {
    newNodes.forEach((node, index) => {
      node.bornAt = now + index * entrance.nodeStepMs;
    });
  }
  const nodeBornById = new Map(nextNodes.map((node) => [node.id, node.bornAt] as const));

  const previousLinksByKey = new Map(
    (previous.links as MutableGraphLink[]).map((link) => [
      `${getGraphLinkEndpointId(link.source)}>${getGraphLinkEndpointId(link.target)}`,
      link,
    ]),
  );
  const nextLinks = next.links.map((link) => {
    const mergedLink = { ...link } as MutableGraphLink;
    const sourceId = getGraphLinkEndpointId(link.source);
    const targetId = getGraphLinkEndpointId(link.target);
    const previousLink = previousLinksByKey.get(`${sourceId}>${targetId}`);
    // __indexColor is force-graph's internal canvas hit-test identifier.
    // The map is keyed by source>target, so this only copies the color when
    // the exact same endpoint pair reappears — never leaks across different links.
    if (previousLink?.__indexColor) {
      mergedLink.__indexColor = previousLink.__indexColor;
    }
    if (previousLink?.bornAt !== undefined) {
      mergedLink.bornAt = previousLink.bornAt;
    } else if (entrance?.instantLinkKeys?.has(`${sourceId}>${targetId}`)) {
      // Pre-build link on a fresh mount — present, not born.
      mergedLink.bornAt = 0;
    } else if (entrance !== undefined) {
      mergedLink.bornAt =
        Math.max(now, nodeBornById.get(sourceId) ?? now, nodeBornById.get(targetId) ?? now) +
        entrance.linkExtraMs;
    } else {
      mergedLink.bornAt = now;
    }
    return mergedLink as GraphLink;
  });

  return {
    nodes: nextNodes,
    links: nextLinks,
  };
}

export function getGraphNodeTooltipLabel(
  node: GraphNode,
  options: {
    displayState?: GraphDocDisplayState;
  } = {},
): string {
  if (node.kind === 'external') return node.url;

  const title = node.label ?? node.id;
  const displayState = options.displayState ?? 'doc';
  const hasMetadata = node.cluster || node.category || (node.tags && node.tags.length > 0);
  if (displayState === 'doc' && !hasMetadata) return title;

  const lines: string[] = [
    ...getGraphNodeTooltipStatusLines(displayState),
    `<div style="font-weight:600;font-size:14px;color:#f1f5f9;margin-bottom:${hasMetadata ? 8 : 0}px;padding-bottom:${hasMetadata ? 6 : 0}px;border-bottom:${hasMetadata ? '1px solid rgba(148,163,184,0.3)' : 'none'}">${escapeHtml(title)}</div>`,
  ];

  if (node.cluster) {
    lines.push(
      `<div style="font-size:12.5px;color:#f1f5f9;margin-bottom:2px"><span style="color:#cbd5e1">cluster:</span> ${escapeHtml(node.cluster)}</div>`,
    );
  }
  if (node.category) {
    lines.push(
      `<div style="font-size:12.5px;color:#f1f5f9;margin-bottom:2px"><span style="color:#cbd5e1">category:</span> ${escapeHtml(node.category)}</div>`,
    );
  }
  if (node.tags && node.tags.length > 0) {
    lines.push(
      `<div style="font-size:12.5px;color:#f1f5f9"><span style="color:#cbd5e1">tags:</span> ${node.tags.map(escapeHtml).join(', ')}</div>`,
    );
  }

  return lines.join('');
}

function getGraphNodeTooltipStatusLines(displayState: GraphDocDisplayState): string[] {
  if (displayState === 'missing') {
    return [
      '<div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#fca5a5;margin-bottom:6px">Broken / uncreated link</div>',
      '<div style="font-size:12px;color:#fecaca;margin-bottom:8px">This page does not exist yet. Open it to create it.</div>',
    ];
  }
  if (displayState === 'folder') {
    return [
      '<div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#c4b5fd;margin-bottom:6px">Folder target</div>',
      '<div style="font-size:12px;color:#ddd6fe;margin-bottom:8px">This link resolves to a folder view rather than a standalone page.</div>',
    ];
  }
  return [];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getGraphNodeVisualState(
  node: GraphNode,
  {
    activeDocName,
    selectedNodeId,
  }: {
    activeDocName: string;
    selectedNodeId: string | null;
  },
): GraphNodeVisualState {
  const isSelected = selectedNodeId !== null && node.id === selectedNodeId;

  if (node.kind === 'external') {
    return isSelected ? 'external-selected' : 'external';
  }

  const isActive = node.docName === activeDocName;

  if (isActive && isSelected) {
    return 'active-selected';
  }
  if (isActive) {
    return 'active';
  }
  if (isSelected) {
    return 'selected';
  }
  return 'default';
}

export function getGraphNodeCanvasRadius(state: GraphNodeVisualState): number {
  if (state === 'active' || state === 'active-selected') {
    return ACTIVE_GRAPH_NODE_RADIUS;
  }
  if (state === 'selected' || state === 'external-selected') {
    return SELECTED_GRAPH_NODE_RADIUS;
  }
  return DEFAULT_GRAPH_NODE_RADIUS;
}

export function getGraphNodePointerRadius(
  state: GraphNodeVisualState,
  globalScale: number,
): number {
  const baseRadius = getGraphNodeCanvasRadius(state);
  if (
    state === 'active' ||
    state === 'selected' ||
    state === 'active-selected' ||
    state === 'external-selected'
  ) {
    return baseRadius + 2 / Math.max(globalScale, 0.01);
  }
  return baseRadius;
}

export function getHashForGraphDocSelection(selection: GraphDocSelection): string {
  return hashFromDocName(selection.docName, selection.anchor);
}

export function resolveGraphNodeClickAction(
  node: GraphNode,
  docClickBehavior: GraphDocClickBehavior,
): GraphNodeClickAction {
  if (node.kind === 'external') {
    if (docClickBehavior === 'select') {
      return {
        kind: 'select',
        selection: {
          kind: 'external',
          id: node.id,
          label: node.label,
          url: node.url,
        },
      };
    }
    return { kind: 'external', url: node.url };
  }

  if (docClickBehavior === 'select') {
    return {
      kind: 'select',
      selection: {
        kind: 'doc',
        id: node.id,
        docName: node.docName,
        label: node.label,
        anchor: node.anchor ?? null,
      },
    };
  }

  return {
    kind: 'navigate',
    hash: getHashForGraphDocSelection({
      docName: node.docName,
      label: node.label,
      anchor: node.anchor ?? null,
    }),
  };
}
