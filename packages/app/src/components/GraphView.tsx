import { LinkGraphSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d';
import { usePageList } from '@/components/PageListContext';
import { hashFromDocName } from '@/lib/doc-hash';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import { openExternalUrl } from '@/lib/external-link';
import { cn } from '@/lib/utils';
import { clusterColor } from './graph-colors';
import {
  type GraphLabelLayoutLink,
  type GraphLabelLayoutNode,
  type GraphLabelPlacement,
  planGraphLabels,
} from './graph-label-layout';
import { buildGraphLabelDescriptors } from './graph-label-utils';
import {
  buildGraphLinkSignature,
  buildGraphNodeSignature,
  type GraphData,
  type GraphDocClickBehavior,
  type GraphDocDisplayState,
  type GraphLink,
  type GraphNode,
  type GraphNodeSelection,
  type GraphNodeVisualState,
  getGraphLinkEndpointId,
  getGraphNodeCanvasRadius,
  getGraphNodePointerRadius,
  getGraphNodeTooltipLabel,
  getGraphNodeVisualState,
  reconcileGraphData,
  resolveGraphNodeClickAction,
} from './graph-view-utils';
import { resolveTargetNavigationIntent } from './target-navigation-intent';

const FOCUS_ANIMATION_MS = 350;
const FOCUS_RETRY_INTERVAL_MS = 120;
const FOCUS_RETRY_DISTANCE_PX = 18;
const FINAL_SETTLE_DRIFT_PX = 28;
const BACKGROUND_CLICK_TOLERANCE_PX = 5;

interface FocusState {
  key: string;
  lastX: number | null;
  lastY: number | null;
  lastAt: number;
}

interface GraphNodeHitbox {
  x: number;
  y: number;
  radiusPx: number;
  state: GraphNodeVisualState;
}

interface BackgroundPointerState {
  pointerId: number;
  clientX: number;
  clientY: number;
  target: GraphPointerTarget;
}

type GraphPointerTarget =
  | { kind: 'background' }
  | { kind: 'link' }
  | { kind: 'node'; node: GraphNode };

function getGraphNodeDisplayState({
  node,
  navigationIntentByNodeId,
}: {
  node: GraphNode;
  navigationIntentByNodeId: Map<string, { displayState: GraphDocDisplayState }>;
}): GraphDocDisplayState {
  if (node.kind !== 'doc') return 'doc';
  return navigationIntentByNodeId.get(node.id)?.displayState ?? 'doc';
}

function getGraphNodeInteractiveRadius({
  state,
  displayState,
  globalScale,
}: {
  state: GraphNodeVisualState;
  displayState: GraphDocDisplayState;
  globalScale: number;
}): number {
  const pointerRadius = getGraphNodePointerRadius(state, globalScale);
  if (displayState !== 'missing') return pointerRadius;
  return Math.max(pointerRadius, getGraphNodeCanvasRadius(state) + 2 / Math.max(globalScale, 0.01));
}

function getActiveGraphNodeCoords({
  nodes,
  activeDocName,
}: {
  nodes: GraphNode[];
  activeDocName: string;
}): { x: number; y: number } | null {
  const activeNode = nodes.find((node) => node.kind === 'doc' && node.docName === activeDocName) as
    | NodeObject<GraphNode>
    | undefined;
  if (typeof activeNode?.x !== 'number' || typeof activeNode?.y !== 'number') return null;
  return { x: activeNode.x, y: activeNode.y };
}

function shouldRunFinalSettle({
  fg,
  coords,
  dimensions,
}: {
  fg: ForceGraphMethods<NodeObject<GraphNode>> | undefined;
  coords: { x: number; y: number } | null;
  dimensions: { width: number; height: number };
}): boolean {
  if (!fg || !coords || dimensions.width <= 0 || dimensions.height <= 0) return false;

  const screen = fg.graph2ScreenCoords(coords.x, coords.y);
  const drift = Math.hypot(screen.x - dimensions.width / 2, screen.y - dimensions.height / 2);

  return drift >= FINAL_SETTLE_DRIFT_PX;
}

function maybeFocusActiveGraphNode({
  fg,
  nodes,
  activeDocName,
  zoom,
  focusKey,
  focusState,
  force = false,
  durationMs = FOCUS_ANIMATION_MS,
}: {
  fg: ForceGraphMethods<NodeObject<GraphNode>> | undefined;
  nodes: GraphNode[];
  activeDocName: string;
  zoom: number;
  focusKey: string;
  focusState: FocusState;
  force?: boolean;
  durationMs?: number;
}): FocusState {
  const now = Date.now();
  let nextState = focusState;

  if (nextState.key !== focusKey) {
    nextState = {
      key: focusKey,
      lastX: null,
      lastY: null,
      lastAt: 0,
    };
  } else if (!force && now - nextState.lastAt < FOCUS_RETRY_INTERVAL_MS) {
    return nextState;
  }

  const coords = getActiveGraphNodeCoords({
    nodes,
    activeDocName,
  });
  if (!coords) return nextState;

  const distance =
    nextState.lastX === null || nextState.lastY === null
      ? Number.POSITIVE_INFINITY
      : Math.hypot(coords.x - nextState.lastX, coords.y - nextState.lastY);

  if (!force && distance < FOCUS_RETRY_DISTANCE_PX && nextState.lastAt !== 0) {
    return {
      ...nextState,
      lastAt: now,
    };
  }

  if (!fg) return nextState;

  fg.centerAt(coords.x, coords.y, durationMs);
  if (Math.abs(fg.zoom() - zoom) > 0.01) {
    fg.zoom(zoom, durationMs);
  }

  return {
    key: focusKey,
    lastX: coords.x,
    lastY: coords.y,
    lastAt: now,
  };
}

function drawGraphLabelPlacements({
  ctx,
  placements,
  labelColor,
  chipColor,
  chipBorderColor,
}: {
  ctx: CanvasRenderingContext2D;
  placements: GraphLabelPlacement[];
  labelColor: string;
  chipColor: string;
  chipBorderColor: string;
}): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (const placement of placements) {
    const width = placement.rect.right - placement.rect.left;
    const height = placement.rect.bottom - placement.rect.top;

    ctx.fillStyle = chipColor;
    ctx.fillRect(placement.rect.left, placement.rect.top, width, height);

    ctx.strokeStyle = chipBorderColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(placement.rect.left, placement.rect.top, width, height);

    ctx.fillStyle = labelColor;
    ctx.fillText(placement.text, placement.textX, placement.textY);
  }
}

function getGraphNodeHitbox({
  node,
  fg,
  activeDocName,
  selectedNodeId,
  globalScale,
  displayState,
}: {
  node: NodeObject<GraphNode>;
  fg: ForceGraphMethods<NodeObject<GraphNode>>;
  activeDocName: string;
  selectedNodeId: string | null;
  globalScale: number;
  displayState: GraphDocDisplayState;
}): GraphNodeHitbox | null {
  if (typeof node.x !== 'number' || typeof node.y !== 'number') return null;

  const state = getGraphNodeVisualState(node, {
    activeDocName,
    selectedNodeId,
  });
  const screen = fg.graph2ScreenCoords(node.x, node.y);

  return {
    x: screen.x,
    y: screen.y,
    radiusPx: getGraphNodeInteractiveRadius({ state, displayState, globalScale }) * globalScale,
    state,
  };
}

function getLocalPointerPoint({
  clientX,
  clientY,
  container,
}: {
  clientX: number;
  clientY: number;
  container: HTMLElement;
}): { x: number; y: number } {
  const rect = container.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function getGraphNodeAtPoint({
  point,
  fg,
  nodes,
  activeDocName,
  selectedNodeId,
  navigationIntentByNodeId,
}: {
  point: { x: number; y: number };
  fg: ForceGraphMethods<NodeObject<GraphNode>>;
  nodes: GraphNode[];
  activeDocName: string;
  selectedNodeId: string | null;
  navigationIntentByNodeId: Map<string, { displayState: GraphDocDisplayState }>;
}): GraphNode | null {
  const globalScale = fg.zoom();
  let closestNode: { node: GraphNode; distance: number } | null = null;

  for (const node of nodes as NodeObject<GraphNode>[]) {
    const displayState = getGraphNodeDisplayState({
      node,
      navigationIntentByNodeId,
    });
    const hitbox = getGraphNodeHitbox({
      node,
      fg,
      activeDocName,
      selectedNodeId,
      globalScale,
      displayState,
    });
    if (!hitbox) continue;

    const distance = Math.hypot(point.x - hitbox.x, point.y - hitbox.y);
    if (distance > hitbox.radiusPx) continue;
    if (closestNode !== null && distance >= closestNode.distance) continue;

    closestNode = { node, distance };
  }

  return closestNode?.node ?? null;
}

function getLinkEndpointCoords(
  endpoint: string | number | NodeObject<GraphNode> | undefined,
  fg: ForceGraphMethods<NodeObject<GraphNode>>,
): { x: number; y: number } | null {
  if (
    endpoint === undefined ||
    typeof endpoint === 'string' ||
    typeof endpoint === 'number' ||
    typeof endpoint.x !== 'number' ||
    typeof endpoint.y !== 'number'
  ) {
    return null;
  }

  return fg.graph2ScreenCoords(endpoint.x, endpoint.y);
}

function getDistanceToSegmentPx({
  point,
  start,
  end,
}: {
  point: { x: number; y: number };
  start: { x: number; y: number };
  end: { x: number; y: number };
}): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  const projectedX = start.x + projection * dx;
  const projectedY = start.y + projection * dy;
  return Math.hypot(point.x - projectedX, point.y - projectedY);
}

function isGraphLinkAtPoint({
  point,
  fg,
  links,
}: {
  point: { x: number; y: number };
  fg: ForceGraphMethods<NodeObject<GraphNode>>;
  links: GraphLink[];
}): boolean {
  const LINK_HITBOX_PX = 6;

  return (links as LinkObject<GraphNode, GraphLink>[]).some((link) => {
    const start = getLinkEndpointCoords(link.source, fg);
    const end = getLinkEndpointCoords(link.target, fg);
    if (!start || !end) return false;
    return getDistanceToSegmentPx({ point, start, end }) <= LINK_HITBOX_PX;
  });
}

function getGraphLinkEndpointDocName({
  endpoint,
  nodes,
}: {
  endpoint: string | number | NodeObject<GraphNode> | undefined;
  nodes: GraphNode[];
}): string | null {
  if (endpoint === undefined || typeof endpoint === 'number') {
    return null;
  }

  if (typeof endpoint === 'string') {
    const node = nodes.find(
      (candidate): candidate is GraphNode & { kind: 'doc' } =>
        candidate.kind === 'doc' && candidate.id === endpoint,
    );
    return node?.docName ?? null;
  }

  if (endpoint.kind === 'doc') {
    return endpoint.docName;
  }

  return null;
}

function applyGraphNodeClick({
  node,
  docClickBehavior,
  onSelectNode,
}: {
  node: GraphNode;
  docClickBehavior: GraphDocClickBehavior;
  onSelectNode?: (selection: GraphNodeSelection) => void;
}): void {
  const action = resolveGraphNodeClickAction(node, docClickBehavior);

  if (action.kind === 'external') {
    openExternalUrl(action.url);
    return;
  }

  if (action.kind === 'navigate') {
    window.location.assign(action.hash);
    return;
  }

  onSelectNode?.(action.selection);
}

function handleGraphPointerTapTarget({
  target,
  docClickBehavior,
  selectedNodeId,
  onSelectNode,
  onBackgroundClick,
}: {
  target: GraphPointerTarget;
  docClickBehavior: GraphDocClickBehavior;
  selectedNodeId: string | null;
  onSelectNode?: (selection: GraphNodeSelection) => void;
  onBackgroundClick?: () => void;
}): void {
  if (target.kind === 'background' || target.kind === 'link') {
    onBackgroundClick?.();
    return;
  }

  if (
    docClickBehavior === 'select' &&
    selectedNodeId !== null &&
    target.node.id === selectedNodeId
  ) {
    onBackgroundClick?.();
    return;
  }

  applyGraphNodeClick({
    node: target.node,
    docClickBehavior,
    onSelectNode,
  });
}

export function GraphView({
  activeDocName,
  selectedNodeId = null,
  isExpanded = false,
  showUrlNodes = true,
  className = '',
  docClickBehavior = 'navigate',
  onSelectNode,
  onBackgroundClick,
  onStatsChange,
  onClustersChange,
}: {
  activeDocName: string;
  selectedNodeId?: string | null;
  isExpanded?: boolean;
  showUrlNodes?: boolean;
  className?: string;
  docClickBehavior?: GraphDocClickBehavior;
  onSelectNode?: (selection: GraphNodeSelection) => void;
  onBackgroundClick?: () => void;
  onStatsChange?: (nodes: number, links: number, loading: boolean) => void;
  onClustersChange?: (clusters: string[]) => void;
}) {
  // force-graph mutates the objects it receives in-place during layout, so we compare
  // incoming API payloads against separate signatures before replacing graphData.
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  // Signatures of the last-applied API response, stored separately from rendered graph data because
  // force-graph mutates link objects in-place (replacing string IDs with node object refs).
  const lastSigRef = useRef({ nodes: '', links: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<NodeObject<GraphNode>> | undefined>(undefined);
  const focusStateRef = useRef<FocusState>({ key: '', lastX: null, lastY: null, lastAt: 0 });
  const backgroundPointerRef = useRef<BackgroundPointerState | null>(null);
  const graphNodesRef = useRef<GraphNode[]>(graphData.nodes);
  // Tracks whether the force-layout simulation has reached its cooldown
  // terminus. Flipped true in `onEngineStop`, false on every `onEngineTick`
  // (engine re-runs whenever graphData mutates or an explicit reheat fires).
  // Consumed by the DEV-gated `__graphHarness.isSimulationSettled()` so
  // canvas-click-at-coord tests can gate on a real settlement signal instead
  // of racing the physics.
  const simulationSettledRef = useRef(false);
  const [dimensions, setDimensions] = useState({ width: 320, height: 400 });
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const {
    folderPaths,
    loading: pageListLoading,
    pages,
    pagesBySlug,
    pagesByBasename,
  } = usePageList();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const params = new URLSearchParams();
        if (!isExpanded && activeDocName) {
          params.set('docName', activeDocName);
          params.set('degrees', '2');
        }
        const url = params.size > 0 ? `/api/link-graph?${params.toString()}` : '/api/link-graph';
        const res = await fetch(url);
        const body = (await res.json().catch(() => null)) as unknown;
        if (cancelled) return;
        if (!res.ok) {
          const problem = ProblemDetailsSchema.safeParse(body);
          const status = res.status;
          setError(problem.success ? problem.data.title : t`Server error: ${status}`);
          setLoading(false);
          return;
        }
        const success = LinkGraphSuccessSchema.safeParse(body);
        if (!success.success) {
          setError(t`Link-graph response did not match expected shape.`);
          setLoading(false);
          return;
        }
        const nextNodes = success.data.nodes as GraphNode[];
        const nextLinks = success.data.links as GraphLink[];
        const nextNodeSig = buildGraphNodeSignature(nextNodes);
        const nextLinkSig = buildGraphLinkSignature(nextLinks);
        if (nextNodeSig !== lastSigRef.current.nodes || nextLinkSig !== lastSigRef.current.links) {
          lastSigRef.current = { nodes: nextNodeSig, links: nextLinkSig };
          setGraphData((previous) =>
            reconcileGraphData(previous, {
              nodes: nextNodes,
              links: nextLinks,
            }),
          );
        }
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t`Failed to load graph`);
        setLoading(false);
      }
    }

    setLoading(true);
    void load();
    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };
    window.addEventListener('focus', handleResume);
    window.addEventListener('visibilitychange', handleResume);
    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('files') || channels.includes('graph')) {
        void load();
      }
    });

    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleResume);
      window.removeEventListener('visibilitychange', handleResume);
      unsubscribe();
    };
  }, [activeDocName, isExpanded, t]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setDimensions({ width: Math.floor(width), height: Math.floor(height) });
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const isDark = resolvedTheme === 'dark';
  const bgColor = isDark ? 'hsl(0 0% 4%)' : 'hsl(0 0% 100%)';
  const defaultNodeColor = isDark ? '#6b7280' : '#9ca3af';
  const activeNodeColor = isDark ? '#69a3ff' : '#3784ff';
  const selectedNodeColor = isDark ? '#34d399' : '#059669';
  const activeSelectedNodeColor = isDark ? '#c084fc' : '#7c3aed';
  const externalNodeColor = isDark ? '#f59e0b' : '#c2410c';
  const folderNodeColor = isDark ? '#a78bfa' : '#7c3aed';
  const missingNodeColor = isDark ? '#f87171' : '#dc2626';
  const edgeColor = isDark ? 'rgba(75,85,99,0.6)' : 'rgba(209,213,219,0.8)';
  const labelColor = isDark ? '#f3f4f6' : '#111827';
  const activeNodeRingColor = isDark ? 'rgba(105,163,255,0.45)' : 'rgba(55,132,255,0.3)';
  const folderNodeRingColor = isDark ? 'rgba(167,139,250,0.38)' : 'rgba(124,58,237,0.22)';
  const missingNodeRingColor = isDark ? 'rgba(248,113,113,0.58)' : 'rgba(220,38,38,0.38)';
  const selectedNodeRingColor = isDark ? 'rgba(52,211,153,0.5)' : 'rgba(5,150,105,0.3)';
  const activeSelectedNodeRingColor = isDark ? 'rgba(192,132,252,0.5)' : 'rgba(124,58,237,0.35)';
  const labelChipColor = isDark ? 'rgba(3,7,18,0.92)' : 'rgba(255,255,255,0.94)';
  const labelChipBorderColor = isDark ? 'rgba(243,244,246,0.08)' : 'rgba(17,24,39,0.08)';
  const focusZoom = isExpanded ? 1.6 : 2.35;
  const maxLabelWidthPx = isExpanded ? 220 : 150;
  // Fullscreen shows the whole project graph, so it intentionally uses a tighter
  // label budget than the docked 2-hop neighborhood view to avoid flooding.
  const maxVisibleLabels = isExpanded ? 10 : 18;

  const displayData: GraphData = showUrlNodes
    ? graphData
    : (() => {
        const externalNodeIds = new Set(
          graphData.nodes.filter((n) => n.kind === 'external').map((n) => n.id),
        );
        return {
          nodes: graphData.nodes.filter((n) => n.kind !== 'external'),
          links: graphData.links.filter((link) => {
            const srcId = getGraphLinkEndpointId(link.source);
            const tgtId = getGraphLinkEndpointId(link.target);
            return !externalNodeIds.has(srcId) && !externalNodeIds.has(tgtId);
          }),
        };
      })();

  const layoutNodes = displayData.nodes as GraphLabelLayoutNode[];
  const layoutLinks = displayData.links as GraphLabelLayoutLink[];
  const labelDescriptors = buildGraphLabelDescriptors(displayData.nodes);
  const focusKey = `${activeDocName}|${focusZoom}`;
  const navigationIntentByNodeId = new Map(
    graphData.nodes.flatMap((node) => {
      if (node.kind !== 'doc') return [];
      const navigationIntent = pageListLoading
        ? {
            displayState: 'doc' as const,
            hashDocName: node.docName,
            hash: null,
          }
        : resolveTargetNavigationIntent(node.docName, {
            pages,
            folderPaths,
            pagesBySlug,
            pagesByBasename,
          });
      return [[node.id, navigationIntent] as const];
    }),
  );

  useEffect(() => {
    onStatsChange?.(displayData.nodes.length, displayData.links.length, loading);
  }, [displayData, loading, onStatsChange]);

  useEffect(() => {
    if (!onClustersChange) return;
    const seen = new Set<string>();
    for (const node of graphData.nodes) {
      if (node.kind === 'doc' && node.cluster) {
        seen.add(node.cluster);
      }
    }
    onClustersChange(Array.from(seen).sort());
  }, [graphData, onClustersChange]);

  useEffect(() => {
    graphNodesRef.current = graphData.nodes;
  }, [graphData.nodes]);

  useEffect(() => {
    focusStateRef.current = {
      key: focusKey,
      lastX: null,
      lastY: null,
      lastAt: 0,
    };
    const animationFrame = window.requestAnimationFrame(() => {
      focusStateRef.current = maybeFocusActiveGraphNode({
        fg: fgRef.current,
        nodes: graphNodesRef.current,
        activeDocName,
        zoom: focusZoom,
        focusKey,
        focusState: focusStateRef.current,
        force: true,
      });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [focusKey, activeDocName, focusZoom]);

  useEffect(() => {
    // DEV-gate guards all `window.__graphHarness` writes below; see
    // precedent #20. Vite statically replaces
    // `import.meta.env.DEV` at build time, so this entire effect body
    // is tree-shaken from production bundles.
    if (!import.meta.env.DEV) return;

    const harness = {
      clickDoc(docName: string) {
        const node = displayData.nodes.find(
          (candidate): candidate is GraphNode & { kind: 'doc' } =>
            candidate.kind === 'doc' && candidate.docName === docName,
        );
        if (!node) return false;
        applyGraphNodeClick({
          node,
          docClickBehavior,
          onSelectNode,
        });
        return true;
      },
      clickBackground() {
        if (!onBackgroundClick) return false;
        onBackgroundClick();
        return true;
      },
      clickExternal(url: string) {
        const node = displayData.nodes.find(
          (candidate): candidate is GraphNode & { kind: 'external' } =>
            candidate.kind === 'external' && candidate.url === url,
        );
        if (!node) return false;
        applyGraphNodeClick({
          node,
          docClickBehavior,
          onSelectNode,
        });
        return true;
      },
      getNodeVisualState(docName: string) {
        const node = displayData.nodes.find(
          (candidate): candidate is GraphNode & { kind: 'doc' } =>
            candidate.kind === 'doc' && candidate.docName === docName,
        );
        if (!node) return null;
        return getGraphNodeVisualState(node, {
          activeDocName,
          selectedNodeId,
        });
      },
      getNodeClickPoint(nodeKey: string) {
        const fg = fgRef.current;
        if (!fg) return null;

        const node = displayData.nodes.find(
          (candidate): candidate is NodeObject<GraphNode> =>
            ('docName' in candidate && candidate.docName === nodeKey) ||
            ('url' in candidate && candidate.url === nodeKey) ||
            candidate.id === nodeKey,
        );
        if (!node) return null;

        const hitbox = getGraphNodeHitbox({
          node,
          fg,
          activeDocName,
          selectedNodeId,
          globalScale: fg.zoom(),
          displayState: getGraphNodeDisplayState({
            node,
            navigationIntentByNodeId,
          }),
        });
        if (!hitbox) return null;

        return {
          x: hitbox.x,
          y: hitbox.y,
        };
      },
      getLayoutMetrics() {
        return {
          graphHeight:
            containerRef.current
              ?.querySelector<HTMLElement>('[role="img"]')
              ?.getBoundingClientRect().height ?? 0,
          containerHeight: containerRef.current?.getBoundingClientRect().height ?? 0,
          availableHeight: containerRef.current?.parentElement?.getBoundingClientRect().height ?? 0,
        };
      },
      // True once the force-layout simulation has reached cooldown — flipped
      // in `onEngineStop` and cleared on every `onEngineTick`.
      isSimulationSettled() {
        return simulationSettledRef.current;
      },
      getLinkClickPoint(sourceDocName: string, targetDocName: string) {
        const fg = fgRef.current;
        if (!fg) return null;

        const link = (displayData.links as LinkObject<GraphNode, GraphLink>[]).find((candidate) => {
          const source = getGraphLinkEndpointDocName({
            endpoint: candidate.source,
            nodes: displayData.nodes,
          });
          const target = getGraphLinkEndpointDocName({
            endpoint: candidate.target,
            nodes: displayData.nodes,
          });
          return source === sourceDocName && target === targetDocName;
        });
        if (!link) return null;

        const sourceNode =
          typeof link.source === 'object' && link.source !== null ? link.source : undefined;
        const targetNode =
          typeof link.target === 'object' && link.target !== null ? link.target : undefined;
        if (!sourceNode || !targetNode) return null;

        const sourceHitbox = getGraphNodeHitbox({
          node: sourceNode,
          fg,
          activeDocName,
          selectedNodeId,
          globalScale: fg.zoom(),
          displayState: getGraphNodeDisplayState({
            node: sourceNode,
            navigationIntentByNodeId,
          }),
        });
        const targetHitbox = getGraphNodeHitbox({
          node: targetNode,
          fg,
          activeDocName,
          selectedNodeId,
          globalScale: fg.zoom(),
          displayState: getGraphNodeDisplayState({
            node: targetNode,
            navigationIntentByNodeId,
          }),
        });
        if (!sourceHitbox || !targetHitbox) return null;

        const dx = targetHitbox.x - sourceHitbox.x;
        const dy = targetHitbox.y - sourceHitbox.y;
        const length = Math.hypot(dx, dy);
        if (length === 0) return null;

        const sourceOffset = sourceHitbox.radiusPx + 8;
        const targetOffset = targetHitbox.radiusPx + 8;
        const usableLength = Math.max(length - sourceOffset - targetOffset, 0);
        const distanceFromSource = sourceOffset + usableLength / 2;
        const unitX = dx / length;
        const unitY = dy / length;

        return {
          x: sourceHitbox.x + unitX * distanceFromSource,
          y: sourceHitbox.y + unitY * distanceFromSource,
        };
      },
    };

    window.__graphHarness = harness;
    return () => {
      if (window.__graphHarness === harness) {
        delete window.__graphHarness;
      }
    };
  }, [
    activeDocName,
    docClickBehavior,
    displayData.links,
    displayData.nodes,
    navigationIntentByNodeId,
    onBackgroundClick,
    onSelectNode,
    selectedNodeId,
  ]);

  return (
    <div
      ref={containerRef}
      className={cn('h-full min-h-0 overflow-hidden', className)}
      onPointerCancel={() => {
        backgroundPointerRef.current = null;
      }}
      onPointerDownCapture={(event) => {
        if (!event.isPrimary || event.button !== 0) {
          backgroundPointerRef.current = null;
          return;
        }
        backgroundPointerRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          target: (() => {
            const container = containerRef.current;
            const fg = fgRef.current;
            if (!container || !fg) {
              return { kind: 'background' } satisfies GraphPointerTarget;
            }

            const point = getLocalPointerPoint({
              clientX: event.clientX,
              clientY: event.clientY,
              container,
            });
            const node = getGraphNodeAtPoint({
              point,
              fg,
              nodes: displayData.nodes,
              activeDocName,
              selectedNodeId,
              navigationIntentByNodeId,
            });
            if (node) {
              return { kind: 'node', node } satisfies GraphPointerTarget;
            }
            if (
              isGraphLinkAtPoint({
                point,
                fg,
                links: displayData.links,
              })
            ) {
              return { kind: 'link' } satisfies GraphPointerTarget;
            }
            return { kind: 'background' } satisfies GraphPointerTarget;
          })(),
        };
      }}
      onPointerUpCapture={(event) => {
        if (!event.isPrimary || event.button !== 0) {
          backgroundPointerRef.current = null;
          return;
        }

        const pointerDown = backgroundPointerRef.current;
        backgroundPointerRef.current = null;
        if (!pointerDown || pointerDown.pointerId !== event.pointerId) return;

        const travelPx = Math.hypot(
          event.clientX - pointerDown.clientX,
          event.clientY - pointerDown.clientY,
        );
        if (travelPx > BACKGROUND_CLICK_TOLERANCE_PX) return;

        handleGraphPointerTapTarget({
          target: pointerDown.target,
          docClickBehavior,
          selectedNodeId,
          onSelectNode,
          onBackgroundClick,
        });
      }}
    >
      {error ? (
        <p className="p-4 text-sm text-destructive">{error}</p>
      ) : displayData.nodes.length === 0 && !loading ? (
        <p className="p-4 text-sm text-muted-foreground">
          <Trans>No links yet. Add wiki links or markdown links to build a graph.</Trans>
        </p>
      ) : (
        <div
          className="h-full min-h-0"
          role="img"
          aria-label={t`Graph visualization of document links`}
        >
          <ForceGraph2D
            ref={fgRef}
            graphData={displayData}
            cooldownTicks={150}
            onEngineTick={() => {
              simulationSettledRef.current = false;
              focusStateRef.current = maybeFocusActiveGraphNode({
                fg: fgRef.current,
                nodes: graphData.nodes,
                activeDocName,
                zoom: focusZoom,
                focusKey,
                focusState: focusStateRef.current,
              });
            }}
            onEngineStop={() => {
              simulationSettledRef.current = true;
              const coords = getActiveGraphNodeCoords({
                nodes: graphData.nodes,
                activeDocName,
              });
              if (
                shouldRunFinalSettle({
                  fg: fgRef.current,
                  coords,
                  dimensions,
                })
              ) {
                focusStateRef.current = maybeFocusActiveGraphNode({
                  fg: fgRef.current,
                  nodes: graphData.nodes,
                  activeDocName,
                  zoom: focusZoom,
                  focusKey,
                  focusState: focusStateRef.current,
                  force: true,
                });
              }
            }}
            width={dimensions.width}
            height={dimensions.height}
            backgroundColor={bgColor}
            nodeId="id"
            nodeLabel={(node: NodeObject<GraphNode>) => {
              return getGraphNodeTooltipLabel(node, {
                displayState: getGraphNodeDisplayState({
                  node,
                  navigationIntentByNodeId,
                }),
              });
            }}
            nodeRelSize={4}
            nodeVal={(node: NodeObject<GraphNode>) => {
              const state = getGraphNodeVisualState(node, {
                activeDocName,
                selectedNodeId,
              });

              if (state === 'active-selected') return 20;
              if (state === 'active') return 18;
              if (state === 'selected' || state === 'external-selected') return 12;
              return 6;
            }}
            nodeCanvasObjectMode={() => 'replace'}
            nodeCanvasObject={(
              node: NodeObject<GraphNode>,
              ctx: CanvasRenderingContext2D,
              globalScale: number,
            ) => {
              if (typeof node.x !== 'number' || typeof node.y !== 'number') return;

              const state = getGraphNodeVisualState(node, {
                activeDocName,
                selectedNodeId,
              });
              const displayState = getGraphNodeDisplayState({
                node,
                navigationIntentByNodeId,
              });
              const isFolderTarget = displayState === 'folder';
              const isMissingTarget = displayState === 'missing';
              const nodeRadius = getGraphNodeCanvasRadius(state);
              const pointerRadius = getGraphNodeInteractiveRadius({
                state,
                displayState,
                globalScale,
              });

              const docCluster = node.kind === 'doc' ? node.cluster : undefined;
              const clusterFill = docCluster ? clusterColor(docCluster, isDark) : defaultNodeColor;

              ctx.beginPath();
              ctx.arc(node.x, node.y, nodeRadius, 0, 2 * Math.PI, false);
              ctx.fillStyle =
                state === 'active'
                  ? activeNodeColor
                  : state === 'active-selected'
                    ? activeSelectedNodeColor
                    : state === 'external' || state === 'external-selected'
                      ? externalNodeColor
                      : isMissingTarget
                        ? missingNodeColor
                        : state === 'selected'
                          ? selectedNodeColor
                          : isFolderTarget
                            ? folderNodeColor
                            : clusterFill;
              ctx.fill();

              if (pointerRadius > nodeRadius) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, pointerRadius, 0, 2 * Math.PI, false);
                ctx.strokeStyle = isMissingTarget
                  ? missingNodeRingColor
                  : state === 'active'
                    ? activeNodeRingColor
                    : state === 'selected' || state === 'external-selected'
                      ? selectedNodeRingColor
                      : activeSelectedNodeRingColor;
                ctx.lineWidth = isMissingTarget ? 1.75 / globalScale : 2 / globalScale;
                ctx.setLineDash(isMissingTarget ? [3 / globalScale, 2 / globalScale] : []);
                ctx.stroke();
                ctx.setLineDash([]);
              } else if (isFolderTarget) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, nodeRadius + 2 / globalScale, 0, 2 * Math.PI, false);
                ctx.strokeStyle = folderNodeRingColor;
                ctx.lineWidth = 1.5 / globalScale;
                ctx.stroke();
              }
            }}
            nodePointerAreaPaint={(
              node: NodeObject<GraphNode>,
              color: string,
              ctx: CanvasRenderingContext2D,
              globalScale: number,
            ) => {
              if (typeof node.x !== 'number' || typeof node.y !== 'number') return;
              const state = getGraphNodeVisualState(node, {
                activeDocName,
                selectedNodeId,
              });
              const displayState = getGraphNodeDisplayState({
                node,
                navigationIntentByNodeId,
              });
              ctx.beginPath();
              ctx.arc(
                node.x,
                node.y,
                getGraphNodeInteractiveRadius({
                  state,
                  displayState,
                  globalScale,
                }),
                0,
                2 * Math.PI,
                false,
              );
              ctx.fillStyle = color;
              ctx.fill();
            }}
            onRenderFramePost={(ctx: CanvasRenderingContext2D, globalScale: number) => {
              if (globalScale < 1.8) return;

              const fg = fgRef.current;
              if (!fg) return;

              ctx.save();
              // force-graph keeps the graph transform active during frame hooks; reset to
              // CSS-pixel space so placement math and text rendering share one coordinate system.
              const pxRatio = window.devicePixelRatio || 1;
              ctx.setTransform(pxRatio, 0, 0, pxRatio, 0, 0);
              ctx.font = '10px system-ui, sans-serif';

              const placements = planGraphLabels({
                nodes: layoutNodes,
                links: layoutLinks,
                activeDocName,
                viewport: dimensions,
                maxLabels: maxVisibleLabels,
                maxLabelWidthPx,
                labelDescriptors,
                measureTextWidthPx: (text) => ctx.measureText(text).width,
                projectToScreen: (x, y) => fg.graph2ScreenCoords(x, y),
                getNodeRadiusPx: (node) => {
                  const state = getGraphNodeVisualState(node, {
                    activeDocName,
                    selectedNodeId,
                  });
                  const displayState = getGraphNodeDisplayState({
                    node,
                    navigationIntentByNodeId,
                  });
                  return (
                    getGraphNodeInteractiveRadius({
                      state,
                      displayState,
                      globalScale,
                    }) *
                      globalScale +
                    4
                  );
                },
              });

              drawGraphLabelPlacements({
                ctx,
                placements,
                labelColor,
                chipColor: labelChipColor,
                chipBorderColor: labelChipBorderColor,
              });
              ctx.restore();
            }}
            linkColor={() => edgeColor}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            linkWidth={1}
            showPointerCursor={(obj) => Boolean(obj && 'kind' in obj)}
            onNodeClick={(node: NodeObject<GraphNode>) => {
              if (node.kind === 'external') {
                openExternalUrl(node.url);
                return;
              }
              if (node.docName) {
                const navigationIntent = navigationIntentByNodeId.get(node.id);
                // A kind-aware hash (e.g. a global skill bundle reference routing
                // to the read-only skill-file viewer) takes precedence; otherwise
                // wrap the resolved docName as a normal `#/<doc>` hash.
                window.location.assign(
                  navigationIntent?.hash ??
                    hashFromDocName(
                      navigationIntent?.hashDocName ?? node.docName,
                      node.anchor ?? null,
                    ),
                );
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
