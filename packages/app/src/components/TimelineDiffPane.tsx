/**
 * TimelineDiffPane — the full-pane version diff, painted by EditorArea as an
 * absolute overlay over the editor (not a viewContent branch: unmounting the
 * EditorActivityPool would recycle the doc's provider and break the vs-live
 * diff, which reads live Y.Text). Driven by `timeline-diff-store`; a Timeline
 * row opens it, this pane owns the mode toggle, the `+N −M` stat, the diff
 * layout, and Restore.
 *
 * The provider stays mounted underneath, so closing the pane returns to the
 * editor instantly with no remount flash.
 */
import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Undo2,
  X,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { computeRenderedDiff, RenderedDiffView } from '@/components/RenderedDiffView';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { collectChangeAnchors, countChangeGroups } from '@/lib/diff-change-nav';
import { LruStringCache } from '@/lib/lru-string-cache';
import {
  countRenderedDiffAnchors,
  RENDERED_DIFF_CHANGE_SELECTOR,
} from '@/lib/rendered-diff/diff-decorations';
import { closeTimelineDiff, type TimelineDiffView } from '@/lib/timeline-diff-store';
import {
  HISTORICAL_CONTENT_CACHE_LIMIT,
  useTimelineEntryDiff,
} from '@/lib/use-timeline-entry-diff';

const LazyActivityPanelDiffView = lazy(async () => {
  const mod = await import('@/components/ActivityPanelDiffView');
  return { default: mod.ActivityPanelDiffView };
});

interface TimelineDiffPaneProps {
  view: TimelineDiffView;
  /** DocPanel collapsed state + toggle — the pane overlays the editor toolbar
   *  that normally owns this control, so it surfaces its own. */
  isPanelCollapsed: boolean;
  onTogglePanel: () => void;
}

export function TimelineDiffPane({ view, isPanelCollapsed, onTogglePanel }: TimelineDiffPaneProps) {
  const { t } = useLingui();
  const { docName, sha, parentSha, laterEdits, authorName, relativeTime } = view;
  const [cache] = useState(() => new LruStringCache(HISTORICAL_CONTENT_CACHE_LIMIT));
  // Rendered (WYSIWYG inline track-changes) is the default; Source is the raw
  // unified-diff view and the engine-failure fallback.
  const [renderMode, setRenderMode] = useState<'rendered' | 'source'>('rendered');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const diffBodyRef = useRef<HTMLDivElement>(null);
  const [currentChange, setCurrentChange] = useState(0);
  // The pane always shows "what changed in this version" (diff vs the previous
  // version). There is no vs-live mode — the only thing it told you (what a
  // restore would undo) lives in the Restore confirm as a plain count.
  const result = useTimelineEntryDiff(sha, docName, cache, 'vs-parent', parentSha);

  // Rendered-diff engine result (plain compute, not a hook). `ok === false`
  // (parse/recreate failure or over the size ceiling) → fall back to Source.
  const rendered =
    result.status === 'ready' ? computeRenderedDiff(result.before, result.after) : null;
  const usingRendered = renderMode === 'rendered' && rendered?.ok === true;

  // Header stepper count: rendered mode counts the engine's change regions;
  // source mode counts unified-diff hunks.
  const changeCount =
    result.status !== 'ready'
      ? 0
      : usingRendered && rendered?.ok
        ? countRenderedDiffAnchors(rendered)
        : countChangeGroups(result.diff);

  // Scroll to the Nth change (wraps). Anchors are re-read from the live DOM each
  // call so they stay valid across re-renders — rendered mode marks changes with
  // `.ok-diff-*` decoration DOM; source mode with react-diff-view change rows.
  function goToChange(next: number): void {
    const container = diffBodyRef.current;
    if (!container) return;
    const anchors = usingRendered
      ? Array.from(container.querySelectorAll<HTMLElement>(RENDERED_DIFF_CHANGE_SELECTOR))
      : collectChangeAnchors(container);
    if (anchors.length === 0) return;
    const clamped = (next + anchors.length) % anchors.length;
    setCurrentChange(clamped);
    anchors[clamped]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // Abort an in-flight restore if the pane unmounts (close / doc nav).
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // The diff is whole-file, so jump to the first changed line once it renders.
  const diffKey = result.status === 'ready' ? `${renderMode}:${result.diff}` : '';
  useEffect(() => {
    const container = diffBodyRef.current;
    if (diffKey === '' || !container) return;
    setCurrentChange(0);

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

    // Debounce: reset on every mutation so we only fire once the diff DOM has
    // stopped changing for `settleMs`. The double rAF lets that final batch
    // paint before we measure.
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

  // Esc closes the pane — parity with a full-screen overlay's expected dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !dialogOpen) closeTimelineDiff();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialogOpen]);

  // No try/finally: the React Compiler cannot lower a `finally` clause in a
  // component-nested function (same constraint that hoisted pollHistoryOnce in
  // TimelinePanel). `cleanup()` is called explicitly at each exit instead.
  async function handleRestore(): Promise<void> {
    setRestoring(true);
    const controller = new AbortController();
    abortRef.current = controller;

    function cleanup(): void {
      if (!controller.signal.aborted) setRestoring(false);
      if (abortRef.current === controller) abortRef.current = null;
    }

    let res: Response;
    try {
      res = await fetch('/api/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, commitSha: sha }),
        signal: controller.signal,
      });
    } catch (err) {
      if (
        !controller.signal.aborted &&
        !(err instanceof DOMException && err.name === 'AbortError')
      ) {
        toast.error(t`Restore failed — document unchanged`, { duration: 4000 });
      }
      cleanup();
      return;
    }

    if (controller.signal.aborted) {
      cleanup();
      return;
    }
    if (res.ok) {
      cleanup();
      setDialogOpen(false);
      closeTimelineDiff();
      return;
    }
    let detail = `HTTP ${res.status}`;
    try {
      const problem = ProblemDetailsSchema.safeParse(await res.json());
      if (problem.success) detail = problem.data.title;
    } catch {
      // non-JSON body; keep status detail
    }
    toast.error(t`Restore failed`, { description: detail, duration: 6000 });
    cleanup();
  }

  const showStat = result.status === 'ready' && (result.additions > 0 || result.deletions > 0);

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-background"
      data-testid="timeline-diff-pane"
    >
      {/* Header spans the pane: close · title · [stat · mode · render · restore].
          The control cluster wraps to a second row on a narrow pane instead of
          clipping off the right edge. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              data-testid="timeline-diff-close"
              aria-label={t`Close diff`}
              onClick={() => closeTimelineDiff()}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t`Close diff`}</TooltipContent>
        </Tooltip>

        <div className="min-w-[8rem] flex-1">
          <div className="truncate text-sm font-medium text-foreground">{docName}</div>
          <div className="truncate text-xs text-muted-foreground">
            {authorName} · {relativeTime}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {showStat && result.status === 'ready' && (
            <span
              role="img"
              className="shrink-0 text-xs tabular-nums"
              data-testid="timeline-diff-stat"
              aria-label={t`${result.additions} added, ${result.deletions} removed`}
            >
              <span aria-hidden="true" className="text-emerald-600 dark:text-emerald-500">
                +{result.additions}
              </span>{' '}
              <span aria-hidden="true" className="text-red-600 dark:text-red-500">
                −{result.deletions}
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
              data-testid="timeline-diff-render-rendered"
            >
              <Trans>Rendered</Trans>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="source"
              className="h-6 px-2 text-xs"
              data-testid="timeline-diff-render-source"
            >
              <Trans>Source</Trans>
            </ToggleGroupItem>
          </ToggleGroup>

          {changeCount > 1 && (
            <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5 dark:bg-background">
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={t`Previous change`}
                data-testid="timeline-diff-prev"
                onClick={() => goToChange(currentChange - 1)}
              >
                <ChevronUp className="size-3.5" />
              </Button>
              <span
                className="px-0.5 text-xs tabular-nums text-muted-foreground"
                aria-live="polite"
              >
                {currentChange + 1} / {changeCount}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={t`Next change`}
                data-testid="timeline-diff-next"
                onClick={() => goToChange(currentChange + 1)}
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            data-testid="timeline-diff-restore"
            disabled={restoring}
            onClick={() => (laterEdits > 0 ? setDialogOpen(true) : handleRestore())}
          >
            {restoring ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Undo2 className="mr-1.5 size-3.5" />
            )}
            <Trans>Restore</Trans>
          </Button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                data-testid="timeline-diff-toggle-panel"
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
            // Rendered (WYSIWYG) inline track-changes. Also the no-change path:
            // with zero changes it renders the document plain.
            <RenderedDiffView diff={rendered} />
          ) : result.diff === '' ? (
            // Source mode, no net content change (frontmatter- or whitespace-
            // only edit) — say so, then show the document unchanged.
            <>
              <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground italic">
                <Trans>No content changes in this version</Trans>
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

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next && !restoring) setDialogOpen(false);
          else if (next) setDialogOpen(true);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Restore to this version?`}</DialogTitle>
            <DialogDescription>
              <Plural
                value={laterEdits}
                one="Rolls back # later edit."
                other="Rolls back # later edits."
              />{' '}
              <Trans>Your current version is saved first, so this is reversible.</Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="timeline-diff-restore-cancel"
              onClick={() => setDialogOpen(false)}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="destructive"
              data-testid="timeline-diff-restore-confirm"
              disabled={restoring}
              onClick={() => handleRestore()}
            >
              {restoring ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              <Trans>Restore</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
