// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
import {
  type HubEntry,
  HubsSuccessSchema,
  isOrphanMode,
  ORPHAN_MODES,
  type OrphanEntry,
  type OrphanMode,
  OrphansSuccessSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Globe,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { GraphLegend } from '@/components/GraphLegend';
import { GraphView } from '@/components/GraphView';
import {
  type GraphNodeSelection,
  getHashForGraphDocSelection,
} from '@/components/graph-view-utils';
import { usePageList } from '@/components/PageListContext';
import { resolveTargetNavigationIntent } from '@/components/target-navigation-intent';
import { Button } from '@/components/ui/button';
import {
  Panel,
  PanelBody,
  PanelCount,
  PanelEmpty,
  PanelError,
  PanelHeader,
  PanelTitle,
} from '@/components/ui/panel';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { hashFromDocName } from '@/lib/doc-hash';
import { openExternalUrl } from '@/lib/external-link';
import { cn } from '@/lib/utils';

const FULLSCREEN_HUB_LIMIT = 50;

const GRAPH_URL_NODES_DOCKED_KEY = 'ok-graph-docked-url-nodes-v1';
const GRAPH_URL_NODES_FULLSCREEN_KEY = 'ok-graph-fullscreen-url-nodes-v1';

function loadBoolPref(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function saveBoolPref(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) {
      window.localStorage.setItem(key, 'true');
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
  }
}

type FullscreenGraphMode = 'explore' | 'orphans' | 'hubs';

function fullscreenModeLabel(mode: FullscreenGraphMode): string {
  if (mode === 'explore') return t`Explore`;
  if (mode === 'orphans') return t`Orphans`;
  return t`Hubs`;
}

function orphanModeLabel(mode: OrphanMode): string {
  if (mode === 'incoming') return t`No Incoming`;
  if (mode === 'outgoing') return t`No Outgoing`;
  return t`Both`;
}

async function fetchOrphans(mode: OrphanMode): Promise<OrphanEntry[]> {
  const res = await fetch(`/api/orphans?mode=${encodeURIComponent(mode)}`);
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(body);
    const status = res.status;
    const statusText = res.statusText;
    throw new Error(
      problem.success ? problem.data.title : t`Server error: ${status} ${statusText}`,
    );
  }
  const success = OrphansSuccessSchema.safeParse(body);
  if (!success.success) throw new Error(t`Failed to load orphan pages`);
  return success.data.orphans;
}

async function fetchHubs(limit: number): Promise<HubEntry[]> {
  const res = await fetch(`/api/hubs?limit=${encodeURIComponent(String(limit))}`);
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(body);
    const status = res.status;
    const statusText = res.statusText;
    throw new Error(
      problem.success ? problem.data.title : t`Server error: ${status} ${statusText}`,
    );
  }
  const success = HubsSuccessSchema.safeParse(body);
  if (!success.success) throw new Error(t`Failed to load hub pages`);
  return success.data.hubs;
}

function navigateToDoc(docName: string) {
  window.location.assign(hashFromDocName(docName));
}

function getOrphanDescription(mode: OrphanMode): string {
  if (mode === 'incoming') {
    return t`Project-level pages with no incoming graph edges.`;
  }
  if (mode === 'outgoing') {
    return t`Project-level pages with no outgoing graph edges.`;
  }
  return t`Project-level pages with neither incoming nor outgoing graph edges.`;
}

function getOrphanEmptyState(mode: OrphanMode): string {
  if (mode === 'incoming') {
    return t`No pages are missing incoming graph links.`;
  }
  if (mode === 'outgoing') {
    return t`No pages are missing outgoing graph links.`;
  }
  return t`No disconnected pages. Pages appear here only when they have no incoming and no outgoing graph edges.`;
}

function FullscreenOrphansView({
  mode,
  onModeChange,
}: {
  mode: OrphanMode;
  onModeChange: (mode: OrphanMode) => void;
}) {
  const { t } = useLingui();
  const {
    data: orphans = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['orphans', mode],
    queryFn: () => fetchOrphans(mode),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              <Trans>Project-level disconnected pages</Trans>
            </p>
            <p className="text-xs text-muted-foreground">{getOrphanDescription(mode)}</p>
          </div>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={mode}
            aria-label={t`Orphan mode`}
            onValueChange={(value) => {
              if (value && isOrphanMode(value)) {
                onModeChange(value);
              }
            }}
          >
            {ORPHAN_MODES.map((value) => (
              <ToggleGroupItem key={value} value={value}>
                {orphanModeLabel(value)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>
      <PanelBody aria-busy={isLoading}>
        {error ? (
          <PanelError>
            {error instanceof Error ? error.message : t`Failed to load orphan pages`}
          </PanelError>
        ) : orphans.length === 0 && !isLoading ? (
          <PanelEmpty>{getOrphanEmptyState(mode)}</PanelEmpty>
        ) : (
          <div className="flex flex-col gap-2">
            {orphans.map((entry) => (
              <button
                key={entry.docName}
                type="button"
                className="block w-full rounded-lg border border-border bg-background/80 px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => navigateToDoc(entry.docName)}
              >
                <div className="truncate text-sm font-medium">{entry.title}</div>
                <div className="truncate text-xs text-muted-foreground">{entry.docName}</div>
              </button>
            ))}
          </div>
        )}
      </PanelBody>
    </div>
  );
}

function FullscreenHubsView() {
  const { t } = useLingui();
  const {
    data: hubs = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['hubs', FULLSCREEN_HUB_LIMIT],
    queryFn: () => fetchHubs(FULLSCREEN_HUB_LIMIT),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            <Trans>Top linked pages</Trans>
          </p>
          <p className="text-xs text-muted-foreground">
            <Trans>
              Project-level pages ordered by inbound link count, up to {FULLSCREEN_HUB_LIMIT}{' '}
              results.
            </Trans>
          </p>
        </div>
      </div>
      <PanelBody aria-busy={isLoading}>
        {error ? (
          <PanelError>
            {error instanceof Error ? error.message : t`Failed to load hub pages`}
          </PanelError>
        ) : hubs.length === 0 && !isLoading ? (
          <PanelEmpty>
            <Trans>No hub pages yet. Hubs appear once pages accumulate inbound graph links.</Trans>
          </PanelEmpty>
        ) : (
          <div className="flex flex-col gap-2">
            {hubs.map((hub) => (
              <button
                key={hub.docName}
                type="button"
                className="block w-full rounded-lg border border-border bg-background/80 px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => navigateToDoc(hub.docName)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{hub.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{hub.docName}</div>
                  </div>
                  <span className="rounded-md bg-muted px-2 py-1 text-xs font-mono text-muted-foreground">
                    {hub.count}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </PanelBody>
    </div>
  );
}

export function GraphPanel({ activeDocName }: { activeDocName: string }) {
  const { t } = useLingui();
  const {
    folderPaths,
    loading: pageListLoading,
    pages,
    pagesBySlug,
    pagesByBasename,
  } = usePageList();
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  const [isExpanded, setIsExpanded] = useState(false);
  const [fullscreenMode, setFullscreenMode] = useState<FullscreenGraphMode>('explore');
  const [orphanMode, setOrphanMode] = useState<OrphanMode>('both');
  const [selectedNode, setSelectedNode] = useState<GraphNodeSelection | null>(null);
  const [stats, setStats] = useState<{ nodes: number; links: number } | null>(null);
  const [clusters, setClusters] = useState<string[]>([]);
  const [showUrlNodesDocked, setShowUrlNodesDocked] = useState(() =>
    loadBoolPref(GRAPH_URL_NODES_DOCKED_KEY),
  );
  const [showUrlNodesFull, setShowUrlNodesFull] = useState(() =>
    loadBoolPref(GRAPH_URL_NODES_FULLSCREEN_KEY),
  );
  const nodeCount = stats?.nodes ?? 0;
  const linkCount = stats?.links ?? 0;

  useEffect(() => {
    saveBoolPref(GRAPH_URL_NODES_DOCKED_KEY, showUrlNodesDocked);
  }, [showUrlNodesDocked]);

  useEffect(() => {
    saveBoolPref(GRAPH_URL_NODES_FULLSCREEN_KEY, showUrlNodesFull);
  }, [showUrlNodesFull]);

  useEffect(() => {
    if (!isExpanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsExpanded(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isExpanded]);

  useEffect(() => {
    if (!isExpanded && selectedNode !== null) {
      setSelectedNode(null);
    }
  }, [isExpanded, selectedNode]);

  useEffect(() => {
    if (fullscreenMode !== 'explore' && selectedNode !== null) {
      setSelectedNode(null);
    }
  }, [fullscreenMode, selectedNode]);

  const activeMode = isExpanded ? fullscreenMode : 'explore';
  const showUrlNodes = isExpanded ? showUrlNodesFull : showUrlNodesDocked;
  const setShowUrlNodes = isExpanded ? setShowUrlNodesFull : setShowUrlNodesDocked;
  const selectedNodeIntent =
    selectedNode?.kind === 'doc' && !pageListLoading
      ? resolveTargetNavigationIntent(selectedNode.docName, {
          pages,
          folderPaths,
          pagesBySlug,
          pagesByBasename,
        })
      : null;
  const selectedDocDisplayState = selectedNodeIntent?.displayState ?? 'doc';
  const hashForSelectedNode = (
    selection: Parameters<typeof getHashForGraphDocSelection>[0],
  ): string => selectedNodeIntent?.hash ?? getHashForGraphDocSelection(selection);
  const selectedNodeState =
    selectedNode === null
      ? null
      : selectedNode.kind === 'doc' && selectedDocDisplayState === 'missing'
        ? {
            eyebrow: t`Broken link`,
            description: t`This page doesn't exist yet. Open it to create the page in the editor and collapse the graph.`,
            Icon: AlertTriangle,
            actionLabel: t`Create page`,
            secondaryLabel: selectedNode.docName,
            onAction: () => {
              const hash = hashForSelectedNode(selectedNode);
              setIsExpanded(false);
              window.location.assign(hash);
            },
          }
        : selectedNode.kind === 'doc' && selectedNode.docName === activeDocName
          ? {
              eyebrow: t`Already open`,
              description: t`This document is already active in the editor. Use Open to collapse the graph.`,
              Icon: CheckCircle2,
              actionLabel: t`Open`,
              secondaryLabel: selectedNode.docName,
              onAction: () => {
                const hash = hashForSelectedNode(selectedNode);
                setIsExpanded(false);
                window.location.assign(hash);
              },
            }
          : selectedNode.kind === 'doc'
            ? {
                eyebrow: t`Selected in graph`,
                description: t`Open this document in the editor and collapse the graph.`,
                Icon: ArrowUpRight,
                actionLabel: t`Open`,
                secondaryLabel: selectedNode.docName,
                onAction: () => {
                  const hash = hashForSelectedNode(selectedNode);
                  setIsExpanded(false);
                  window.location.assign(hash);
                },
              }
            : {
                eyebrow: t`Selected in graph`,
                description: t`Open this link in a new tab and collapse the graph.`,
                Icon: ArrowUpRight,
                actionLabel: t`Open link`,
                secondaryLabel: selectedNode.url,
                onAction: () => {
                  openExternalUrl(selectedNode.url);
                  setIsExpanded(false);
                },
              };

  return (
    <Panel className={isExpanded ? 'fixed inset-0 z-50 overflow-hidden bg-background' : undefined}>
      <PanelHeader
        data-electron-drag={isExpanded && isElectronHost ? '' : undefined}
        className={cn(
          isExpanded
            ? 'mt-2 h-12 gap-3 py-0 pl-[var(--ok-titlebar-reserve-left,1rem)]'
            : 'flex-wrap gap-3',
          isExpanded && isElectronHost && '[-webkit-app-region:drag]',
        )}
      >
        {/* Fullscreen header anatomy (expanded only):
            • `pl-[var(--ok-titlebar-reserve-left,1rem)]` reserves the macOS
              traffic-light footprint on the chrome row (precedent #49). The
              arbitrary `pl-` wins over PanelHeader's base `px-4` by Tailwind
              emit order (measured: resolves to 78px under electron-mode); the
              `,1rem` fallback keeps web layout at the base `px-4`. Because `pl-`
              *replaces* the base `px-4` rather than stacking on it, 78px alone
              leaves the title touching the buttons — the title cluster adds
              `ml-4` below for the 16px of breathing room (94px total, measured).
            • `mt-2 h-12 py-0` land the row on the editor chrome midline: the
              overlay is pinned to the whole window, so it starts at the raw
              window top, 8px above EditorHeader's SidebarInset-`m-2` band.
              `mt-2` reproduces that inset, `h-12` matches the 48px band, `py-0`
              drops the inherited `py-3` so content centers in the full band —
              title at y=32, exactly where the traffic lights are tuned (measured).
            • Electron: the header row is the window-drag region (so graph mode
              stays draggable); the controls cluster opts back out below. */}
        <div
          data-slot="graph-title-cluster"
          className={cn('flex min-w-0 items-center gap-1.5', isExpanded && 'ml-4')}
        >
          <PanelTitle>
            <Trans>Graph</Trans>
          </PanelTitle>
          {activeMode === 'explore' && stats ? (
            <div className="flex items-center gap-0.5">
              <PanelCount>
                <Plural value={nodeCount} one="# node" other="# nodes" />
              </PanelCount>
              <PanelCount>
                <Plural value={linkCount} one="# link" other="# links" />
              </PanelCount>
            </div>
          ) : null}
        </div>
        <div
          data-slot="graph-controls"
          className={cn(
            'ml-auto flex items-center gap-2',
            isExpanded && isElectronHost && '[&>*]:[-webkit-app-region:no-drag]',
          )}
        >
          {isExpanded ? (
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={fullscreenMode}
              aria-label={t`Expanded graph mode`}
              onValueChange={(value) => {
                if (value === 'explore' || value === 'orphans' || value === 'hubs') {
                  setFullscreenMode(value);
                }
              }}
            >
              {(['explore', 'orphans', 'hubs'] as const).map((value) => (
                <ToggleGroupItem key={value} value={value}>
                  {fullscreenModeLabel(value)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
          <div className="flex items-center gap-0.5">
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground hover:bg-accent"
                  aria-label={
                    showUrlNodes ? t`Hide external URL nodes` : t`Show external URL nodes`
                  }
                  aria-pressed={showUrlNodes}
                  onClick={() => setShowUrlNodes((prev) => !prev)}
                >
                  <Globe
                    className={
                      showUrlNodes
                        ? 'size-4 text-sidebar-accent-foreground'
                        : 'size-4 text-muted-foreground'
                    }
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                sideOffset={8}
                className={isExpanded ? 'z-[9999]' : undefined}
              >
                {showUrlNodes ? (
                  <Trans>Hide external URL nodes</Trans>
                ) : (
                  <Trans>Show external URL nodes</Trans>
                )}
              </TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground hover:bg-accent"
                  aria-label={isExpanded ? t`Collapse graph` : t`Expand graph`}
                  onClick={() => setIsExpanded((prev) => !prev)}
                >
                  {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                sideOffset={8}
                className={isExpanded ? 'z-[9999]' : undefined}
              >
                {isExpanded ? <Trans>Collapse</Trans> : <Trans>Expand graph</Trans>}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </PanelHeader>
      {activeMode === 'explore' ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <GraphView
            activeDocName={activeDocName}
            selectedNodeId={isExpanded ? (selectedNode?.id ?? null) : null}
            isExpanded={isExpanded}
            showUrlNodes={showUrlNodes}
            className="h-full min-h-0"
            docClickBehavior={isExpanded ? 'select' : 'navigate'}
            onSelectNode={isExpanded ? setSelectedNode : undefined}
            onBackgroundClick={
              isExpanded
                ? () => {
                    if (selectedNode !== null) {
                      setSelectedNode(null);
                    }
                  }
                : undefined
            }
            onStatsChange={(nodes, links, loading) => {
              if (loading) {
                setStats(null);
                return;
              }
              setStats({ nodes, links });
            }}
            onClustersChange={setClusters}
          />
          <GraphLegend clusters={clusters} variant={isExpanded ? 'fullscreen' : 'docked'} />
          {isExpanded && activeMode === 'explore' && selectedNode !== null && selectedNodeState ? (
            <div className="pointer-events-none absolute inset-x-4 top-4 z-10 flex justify-center">
              <div
                role="status"
                aria-label={t`Selected graph item`}
                className="pointer-events-auto flex w-full max-w-2xl items-center gap-3 rounded-xl border border-border/70 bg-background/95 px-4 py-3 text-sm shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85"
              >
                <selectedNodeState.Icon className="size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {selectedNodeState.eyebrow}
                  </div>
                  <div className="truncate font-medium text-foreground">{selectedNode.label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {selectedNodeState.secondaryLabel}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {selectedNodeState.description}
                  </div>
                </div>
                <Button size="sm" className="shrink-0" onClick={selectedNodeState.onAction}>
                  {selectedNodeState.actionLabel}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {isExpanded && activeMode === 'orphans' ? (
        <FullscreenOrphansView mode={orphanMode} onModeChange={setOrphanMode} />
      ) : null}
      {isExpanded && activeMode === 'hubs' ? <FullscreenHubsView /> : null}
    </Panel>
  );
}
