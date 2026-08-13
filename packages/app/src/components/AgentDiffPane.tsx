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
import { collectChangeAnchors, PROPERTY_CHANGE_ANCHOR_SELECTOR } from '@/lib/diff-change-nav';
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

// Bound the per-version diff cache so scrubbing a long session can't grow
// renderer memory unboundedly. Mirrors the panel hook's BURST_DIFF_CACHE_LIMIT.
const VERSION_DIFF_CACHE_LIMIT = 64;

/** Placeholder while loading / on error, so `properties` is never optional. */
const EMPTY_DELTA: FrontmatterDelta = { changes: [], unparseable: null };

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
    properties: FrontmatterDelta;
  }>({ status: 'loading', diff: '', before: '', after: '', properties: EMPTY_DELTA });

  // Fetch the current version's whole-page diff + before/after bodies + property
  // delta (cached across steps within this pane's lifetime as one JSON blob).
  // Keyed on the primitive coordinates so it doesn't re-fetch when `view`
  // identity changes.
  useEffect(() => {
    let cancelled = false;
    setResult({ status: 'loading', diff: '', before: '', after: '', properties: EMPTY_DELTA });
    const key = `${docName}\0${keptCount}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      // No try/catch: this cache is in-memory, private to this pane, and the only
      // writer is the `JSON.stringify` below over a Zod-validated response — so
      // unlike the fetch path there is no parse failure to recover from.
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

  // Rendered-diff engine result (plain compute, not a hook). `ok === false`
  // (parse/recreate failure or over the size ceiling) → fall back to Source.
  const rendered =
    result.status === 'ready' ? computeRenderedDiff(result.before, result.after) : null;

  // Whole-file diff → scroll to the first change once it renders. Keyed on the
  // version and the mode (so stepping versions or toggling Rendered/Source
  // re-scrolls), NOT on the body diff being non-empty: a write that only touched
  // frontmatter has an empty body diff and a property row to scroll to, so
  // gating on emptiness would skip exactly the case that needs the scroll.
  // `keptCount` is in the key because two adjacent versions can both have an
  // empty body diff, and a cache hit swaps them within one render. Mirrors
  // `TimelineDiffPane`'s settle-debounced scroll: the rendered (ProseMirror)
  // diff mounts its change decorations a beat after the React commit, so
  // scrolling on the first anchor we see races a stale anchor from the previous
  // version. Instead we wait until the diff DOM has stopped mutating for
  // `settleMs`, then double-rAF so the final batch paints before we measure.
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
      // First property row, else first rendered-diff decoration, else first
      // source-diff change row.
      const el =
        container.querySelector<HTMLElement>(PROPERTY_CHANGE_ANCHOR_SELECTOR) ??
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

  // Keyboard: Esc closes; J/K (or ←/→) step through versions. Bubble phase is
  // sufficient here — nothing this handler does needs to observe the DOM ahead
  // of a dismissable layer, because Escape arrives already cancelled.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A layer above the pane owns the keyboard: Escape belongs to it, and the
      // review chords must not step its arrow-key navigation. `defaultPrevented`
      // is what covers Escape — a dismissable layer cancels it from a
      // capture-phase listener on `document`, and that same listener has already
      // flipped `data-state` by the time this bubble-phase handler runs. Scoped
      // to Escape: the editor cancels ←/→ in its own gap-cursor and node-view
      // paths, and those must not silently disable version stepping.
      if (e.key === 'Escape' && e.defaultPrevented) return;
      if (isOverlayLayerOpen()) return;
      // The editor stays mounted and live behind the pane, so a text surface
      // with the caret in it keeps its own letters — `preventDefault` on "j"
      // cancels the insertion no matter which phase this handler runs in.
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
  // Property changes are counted separately — `+N −M` stays a body line count.
  const propertyCount = result.properties.changes.length;
  const hasPropertyBlock =
    result.properties.changes.length > 0 || result.properties.unparseable !== null;

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

      {/* Diff body — scrolls independently of the header. */}
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
        {result.status === 'ready' && (
          // Above the body in both render modes: an agent write that only
          // touched properties has no body diff to show.
          <PropertyDiffBlock delta={result.properties} />
        )}
        {result.status === 'ready' &&
          (renderMode === 'rendered' && rendered?.ok ? (
            // Rendered (WYSIWYG) inline diff. Also the no-change path: with zero
            // changes it renders the document (e.g. version 0 = the original).
            <RenderedDiffView diff={rendered} />
          ) : result.diff === '' ? (
            // Source mode, no body diff (version 0 original, or an edit that only
            // touched properties): show the note, then the whole document source —
            // so the original's content is visible in Source too, mirroring what
            // Rendered shows (and Timeline).
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
              <LazyActivityPanelDiffView diff={result.diff} viewType="unified" />
            </Suspense>
          ))}
      </div>
    </div>
  );
}
