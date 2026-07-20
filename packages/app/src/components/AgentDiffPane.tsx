/**
 * AgentDiffPane — the full-pane Agent edit diff, painted by EditorArea as an
 * absolute overlay over the editor (the same slot + rationale as
 * `TimelineDiffPane`: unmounting the EditorActivityPool would recycle the doc's
 * provider). Driven by `agent-diff-store`.
 *
 * Shows one file *version*: the whole document with the first `keptCount` edits
 * applied, diffed against the pre-agent original. Version 0 is the empty/original
 * file; version N (all edits) is the current document. J/K / ←/→ walk versions;
 * the panel's undo slider drives the same store, so the two stay in lockstep. The
 * diff is whole-file, so the pane scrolls to the first change once it renders.
 *
 * Undo is committed from the Activity panel's timeline, not here.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2, PanelRightClose, PanelRightOpen, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { computeRenderedDiff, RenderedDiffView } from '@/components/RenderedDiffView';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type AgentDiffView, closeAgentDiff, setAgentDiffKept } from '@/lib/agent-diff-store';
import { collectChangeAnchors } from '@/lib/diff-change-nav';
import { LruStringCache } from '@/lib/lru-string-cache';
import { RENDERED_DIFF_CHANGE_SELECTOR } from '@/lib/rendered-diff/diff-decorations';
import { fetchAgentBurstDiff } from '@/lib/use-activity-panel';
import { countDiffStat } from '@/lib/use-timeline-entry-diff';
import { AgentIcon } from './icons/AgentIcon';

const LazyActivityPanelDiffView = lazy(async () => {
  const mod = await import('@/components/ActivityPanelDiffView');
  return { default: mod.ActivityPanelDiffView };
});

// Bound the per-version diff cache so scrubbing a long session can't grow
// renderer memory unboundedly. Mirrors the panel hook's BURST_DIFF_CACHE_LIMIT.
const VERSION_DIFF_CACHE_LIMIT = 64;

interface AgentDiffPaneProps {
  view: AgentDiffView;
  /** DocPanel collapsed state + toggle — the pane overlays the editor toolbar
   *  that normally owns this control, so it surfaces its own. */
  isPanelCollapsed: boolean;
  onTogglePanel: () => void;
}

export function AgentDiffPane({ view, isPanelCollapsed, onTogglePanel }: AgentDiffPaneProps) {
  const { t } = useLingui();
  const { agentId, agentName, agentColor, agentIcon, docName, keptCount } = view;
  const [cache] = useState(() => new LruStringCache(VERSION_DIFF_CACHE_LIMIT));
  const diffBodyRef = useRef<HTMLDivElement>(null);
  // Rendered (WYSIWYG) is the default; Source is the raw unified diff and the
  // engine-failure fallback — parity with `TimelineDiffPane`.
  const [renderMode, setRenderMode] = useState<'rendered' | 'source'>('rendered');
  const [result, setResult] = useState<{
    status: 'loading' | 'ready' | 'error';
    diff: string;
    before: string;
    after: string;
  }>({ status: 'loading', diff: '', before: '', after: '' });

  // Fetch the current version's whole-page diff + before/after bodies (cached
  // across steps within this pane's lifetime as one JSON blob). Keyed on the
  // primitive coordinates so it doesn't re-fetch when `view` identity changes.
  useEffect(() => {
    let cancelled = false;
    setResult({ status: 'loading', diff: '', before: '', after: '' });
    const key = `${docName}\0${keptCount}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      const parsed = JSON.parse(cached) as { diff: string; before: string; after: string };
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
          setResult({ status: 'error', diff: '', before: '', after: '' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, docName, keptCount, cache]);

  // Rendered-diff engine result (plain compute, not a hook). `ok === false`
  // (parse/recreate failure or over the size ceiling) → fall back to Source.
  const rendered =
    result.status === 'ready' ? computeRenderedDiff(result.before, result.after) : null;

  // Whole-file diff → scroll to the first changed line once it renders.
  // Re-keyed on the diff string (re-runs per version step) and on mode (so
  // toggling Rendered/Source re-scrolls). Mirrors `TimelineDiffPane`'s
  // settle-debounced scroll: the rendered (ProseMirror) diff mounts its change
  // decorations a beat after the React commit, so scrolling on the first anchor
  // we see races a stale anchor from the previous version. Instead we wait until
  // the diff DOM has stopped mutating for `settleMs`, then double-rAF so the
  // final batch paints before we measure.
  const diffKey =
    result.status === 'ready' && result.diff !== '' ? `${renderMode}:${result.diff}` : '';
  useEffect(() => {
    const container = diffBodyRef.current;
    if (diffKey === '' || !container) return;

    let done = false;
    let observer: MutationObserver | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let rafId: number | undefined;

    const scrollToFirstChange = (): void => {
      if (done) return;
      // First rendered-diff decoration, else first source-diff change row.
      const el =
        container.querySelector<HTMLElement>(RENDERED_DIFF_CHANGE_SELECTOR) ??
        collectChangeAnchors(container)[0];
      if (!el) return;
      done = true;
      observer?.disconnect();
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

    observer = new MutationObserver(scheduleAfterSettle);
    observer.observe(container, { childList: true, subtree: true });
    // Kick once for the case where the anchor is already present and no further
    // mutations arrive to trigger the observer.
    scheduleAfterSettle();

    const failsafe = setTimeout(() => observer?.disconnect(), 5000);
    return () => {
      observer?.disconnect();
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      clearTimeout(failsafe);
    };
  }, [diffKey]);

  // Keyboard: Esc closes; J/K (or ←/→) step through versions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
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

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-background"
      data-testid="agent-diff-pane"
    >
      {/* Header: close · agent + file · [stat · render · panel]. */}
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

      {/* Diff body — scrolls independently of the header. */}
      <div ref={diffBodyRef} className="min-h-0 flex-1 overflow-auto subtle-scrollbar">
        {result.status === 'loading' && (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            <Trans>Loading diff</Trans>
          </div>
        )}
        {result.status === 'error' && (
          <p className="px-4 py-3 text-xs text-destructive">
            <Trans>Diff unavailable</Trans>
          </p>
        )}
        {result.status === 'ready' &&
          (renderMode === 'rendered' && rendered?.ok ? (
            // Rendered (WYSIWYG) inline diff. Also the no-change path: with zero
            // changes it renders the document (e.g. version 0 = the original).
            <RenderedDiffView diff={rendered} />
          ) : result.diff === '' ? (
            // Source mode, no diff (version 0 original, or a no-op edit): show the
            // note, then the whole document source — so the original's content is
            // visible in Source too, mirroring what Rendered shows (and Timeline).
            <>
              <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground italic">
                {keptCount === 0 ? (
                  <Trans>Original file — before this agent's edits.</Trans>
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
                  <Loader2 className="size-3 animate-spin" />
                  <Trans>Loading diff renderer</Trans>
                </div>
              }
            >
              <LazyActivityPanelDiffView diff={result.diff} viewType="unified" />
            </Suspense>
          ))}
      </div>
    </div>
  );
}
