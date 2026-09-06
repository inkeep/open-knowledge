// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import type { FrontmatterDelta } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { PanelRightClose, PanelRightOpen, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { PropertyDiffBlock } from '@/components/PropertyDiffBlock';
import { computeRenderedDiff, RenderedDiffView } from '@/components/RenderedDiffView';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type AgentDiffView, closeAgentDiff, setAgentDiffKept } from '@/lib/agent-diff-store';
import {
  collectChangeAnchors,
  PROPERTY_CHANGE_ANCHOR_SELECTOR,
  watchPierreShadowRoots,
} from '@/lib/diff-change-nav';
import { LruStringCache } from '@/lib/lru-string-cache';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { RENDERED_DIFF_CHANGE_SELECTOR } from '@/lib/rendered-diff/diff-decorations';
import { fetchAgentBurstDiff } from '@/lib/use-activity-panel';
import { countDiffStat } from '@/lib/use-timeline-entry-diff';
import { AgentIcon } from './icons/AgentIcon';

const LazyActivityPanelDiffView = lazy(async () => {
  const mod = await import('@/components/ActivityPanelDiffView');
  return { default: mod.ActivityPanelDiffView };
});

const VERSION_DIFF_CACHE_LIMIT = 64;

const EMPTY_DELTA: FrontmatterDelta = { changes: [], unparseable: null };

interface AgentDiffPaneProps {
  view: AgentDiffView;
  isPanelCollapsed: boolean;
  onTogglePanel: () => void;
}

export function AgentDiffPane({ view, isPanelCollapsed, onTogglePanel }: AgentDiffPaneProps) {
  const { t } = useLingui();
  const { agentId, agentName, agentColor, agentIcon, docName, keptCount } = view;
  const [cache] = useState(() => new LruStringCache(VERSION_DIFF_CACHE_LIMIT));
  const diffBodyRef = useRef<HTMLDivElement>(null);
  const [renderMode, setRenderMode] = useState<'rendered' | 'source'>('rendered');
  const [result, setResult] = useState<{
    status: 'loading' | 'ready' | 'error';
    diff: string;
    before: string;
    after: string;
    properties: FrontmatterDelta;
  }>({ status: 'loading', diff: '', before: '', after: '', properties: EMPTY_DELTA });

  useEffect(() => {
    let cancelled = false;
    setResult({ status: 'loading', diff: '', before: '', after: '', properties: EMPTY_DELTA });
    const key = `${agentId}\0${docName}\0${keptCount}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      const parsed = JSON.parse(cached) as {
        diff: string;
        before: string;
        after: string;
        properties: FrontmatterDelta;
      };
      setResult({ status: 'ready', ...parsed });
      return;
    }
    fetchAgentBurstDiff(agentId, docName, keptCount)
      .then((data) => {
        if (cancelled) return;
        cache.set(key, JSON.stringify(data));
        setResult({ status: 'ready', ...data });
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[agent-diff] failed to load burst diff', {
            agentId,
            docName,
            keptCount,
            err,
          });
          setResult({ status: 'error', diff: '', before: '', after: '', properties: EMPTY_DELTA });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, docName, keptCount, cache]);

  const rendered =
    result.status === 'ready' ? computeRenderedDiff(result.before, result.after) : null;

  const diffKey = result.status === 'ready' ? `${renderMode}:${keptCount}:${result.diff}` : '';
  useEffect(() => {
    const container = diffBodyRef.current;
    if (diffKey === '' || !container) return;

    let done = false;
    let observer: MutationObserver | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let rafId: number | undefined;

    const scrollToFirstChange = (): void => {
      if (done) return;
      shadowWatcher.sync();
      const el =
        container.querySelector<HTMLElement>(PROPERTY_CHANGE_ANCHOR_SELECTOR) ??
        container.querySelector<HTMLElement>(RENDERED_DIFF_CHANGE_SELECTOR) ??
        collectChangeAnchors(container)[0];
      if (!el) return;
      done = true;
      observer?.disconnect();
      shadowWatcher.disconnect();
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    };

    const settleMs = 120;
    const scheduleAfterSettle = (): void => {
      if (done) return;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (rafId !== undefined) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          rafId = requestAnimationFrame(scrollToFirstChange);
        });
      }, settleMs);
    };

    const shadowWatcher = watchPierreShadowRoots(container, scheduleAfterSettle);

    observer = new MutationObserver(scheduleAfterSettle);
    observer.observe(container, { childList: true, subtree: true });
    scheduleAfterSettle();

    const failsafe = setTimeout(() => {
      observer?.disconnect();
      shadowWatcher.disconnect();
    }, 5000);
    return () => {
      observer?.disconnect();
      shadowWatcher.disconnect();
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      clearTimeout(failsafe);
    };
  }, [diffKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && e.defaultPrevented) return;
      if (isOverlayLayerOpen()) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Escape') {
        closeAgentDiff();
      } else if (e.key === 'j' || e.key === 'ArrowRight') {
        e.preventDefault();
        setAgentDiffKept(keptCount + 1);
      } else if (e.key === 'k' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setAgentDiffKept(keptCount - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keptCount]);

  const stat =
    result.status === 'ready' ? countDiffStat(result.diff) : { additions: 0, deletions: 0 };
  const showStat = stat.additions > 0 || stat.deletions > 0;
  const propertyCount = result.properties.changes.length;
  const hasPropertyBlock =
    result.properties.changes.length > 0 || result.properties.unparseable !== null;

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-background"
      data-testid="agent-diff-pane"
    >
      {}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              data-testid="agent-diff-close"
              aria-label={t`Close diff`}
              onClick={() => closeAgentDiff()}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t`Close diff`}</TooltipContent>
        </Tooltip>

        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-white"
          style={{ backgroundColor: agentColor }}
        >
          <AgentIcon icon={agentIcon} width={13} height={13} />
        </span>

        <div className="min-w-0 max-w-[14rem] shrink">
          <div className="truncate text-sm font-medium text-foreground">{docName}</div>
          <div className="truncate text-xs text-muted-foreground">{agentName}</div>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {propertyCount > 0 && (
            <span
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
              data-testid="agent-diff-property-stat"
            >
              <Plural value={propertyCount} one="# property" other="# properties" />
            </span>
          )}

          {showStat && (
            <span
              role="img"
              className="shrink-0 text-xs tabular-nums"
              data-testid="agent-diff-stat"
              aria-label={t`${stat.additions} added, ${stat.deletions} removed`}
            >
              <span aria-hidden="true" className="text-emerald-600 dark:text-emerald-500">
                +{stat.additions}
              </span>{' '}
              <span aria-hidden="true" className="text-red-600 dark:text-red-500">
                −{stat.deletions}
              </span>
            </span>
          )}

          <ToggleGroup
            type="single"
            value={renderMode}
            onValueChange={(v) => {
              if (v === 'rendered' || v === 'source') setRenderMode(v);
            }}
            aria-label={t`Diff render mode`}
            variant="segmented"
            size="sm"
            spacing={1}
            className="shrink-0 rounded-md bg-muted p-0.5 dark:bg-background"
          >
            <ToggleGroupItem
              value="rendered"
              className="h-6 px-2 text-xs"
              data-testid="agent-diff-render-rendered"
            >
              <Trans>Rendered</Trans>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="source"
              className="h-6 px-2 text-xs"
              data-testid="agent-diff-render-source"
            >
              <Trans>Source</Trans>
            </ToggleGroupItem>
          </ToggleGroup>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                data-testid="agent-diff-toggle-panel"
                aria-label={isPanelCollapsed ? t`Show panel` : t`Hide panel`}
                aria-expanded={!isPanelCollapsed}
                onClick={onTogglePanel}
              >
                {isPanelCollapsed ? (
                  <PanelRightOpen className="size-4" />
                ) : (
                  <PanelRightClose className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isPanelCollapsed ? t`Show panel` : t`Hide panel`}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {}
      <div ref={diffBodyRef} className="min-h-0 flex-1 overflow-auto subtle-scrollbar">
        {result.status === 'loading' && (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
            <Spinner aria-hidden="true" className="size-3" />
            <Trans>Loading diff</Trans>
          </div>
        )}
        {result.status === 'error' && (
          <p className="px-4 py-3 text-xs text-destructive">
            <Trans>Diff unavailable</Trans>
          </p>
        )}
        {result.status === 'ready' && <PropertyDiffBlock delta={result.properties} />}
        {result.status === 'ready' &&
          (renderMode === 'rendered' && rendered?.ok ? (
            <RenderedDiffView diff={rendered} />
          ) : result.diff === '' ? (
            <>
              <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground italic">
                {keptCount === 0 ? (
                  <Trans>Original file — before this agent's edits.</Trans>
                ) : hasPropertyBlock ? (
                  <Trans>No body changes at this version.</Trans>
                ) : (
                  <Trans>No content changes at this version.</Trans>
                )}
              </p>
              <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-xs text-foreground/90">
                {result.after}
              </pre>
            </>
          ) : (
            <Suspense
              fallback={
                <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
                  <Spinner aria-hidden="true" className="size-3" />
                  <Trans>Loading diff renderer</Trans>
                </div>
              }
            >
              <LazyActivityPanelDiffView
                before={result.before}
                after={result.after}
                cacheKey={`${agentId}@${docName}@v${keptCount}`}
              />
            </Suspense>
          ))}
      </div>
    </div>
  );
}
