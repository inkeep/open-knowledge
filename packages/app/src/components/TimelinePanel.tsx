// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
import {
  AGENT_ICON_COLORS,
  AGENT_ICON_COLORS_DARK,
  colorFromSeed,
  iconFromClientName,
  ProblemDetailsSchema,
  type TimelineEntry,
} from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { LucideProps } from 'lucide-react';
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  Columns2,
  GitBranch,
  HardDrive,
  Loader2,
  Rows2,
  Sparkles,
  Undo2,
  User,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { lazy, Suspense, type SVGProps, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DiffLayout } from '@/components/DiffView';
import { ClaudeIcon } from '@/components/icons/claude';
import { ClineIcon } from '@/components/icons/cline';
import { CodexIcon } from '@/components/icons/codex';
import { CopilotIcon } from '@/components/icons/copilot';
import { CursorIcon } from '@/components/icons/cursor';
import { WindsurfIcon } from '@/components/icons/windsurf';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LruStringCache } from '@/lib/lru-string-cache';
import { createSelfSchedulingPoll, type PollOutcome } from '@/lib/self-scheduling-poll';
import {
  HISTORICAL_CONTENT_CACHE_LIMIT,
  useTimelineEntryDiff,
} from '@/lib/use-timeline-entry-diff';

const LazyActivityPanelDiffView = lazy(async () => {
  const mod = await import('@/components/ActivityPanelDiffView');
  return { default: mod.ActivityPanelDiffView };
});

const TIMELINE_POLL_BASE_MS = 10_000;
const TIMELINE_POLL_MAX_BACKOFF_MS = 60_000;

async function pollHistoryOnce(
  docName: string,
  signal: AbortSignal,
  handlers: {
    setEntries: (entries: TimelineEntry[]) => void;
    setError: (message: string | null) => void;
    setLoading: (value: boolean) => void;
    unavailableMessage: string;
  },
): Promise<PollOutcome> {
  try {
    const res = await fetch(`/api/history?docName=${encodeURIComponent(docName)}&limit=100`, {
      signal,
    });
    if (!res.ok) {
      handlers.setError(handlers.unavailableMessage);
      return 'error';
    }
    const data = (await res.json()) as { entries: TimelineEntry[] };
    handlers.setEntries((data.entries ?? []).filter((e) => e.type !== 'checkpoint'));
    handlers.setError(null);
    return 'ok';
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    handlers.setError(handlers.unavailableMessage);
    console.error('[timeline]', e);
    return 'error';
  } finally {
    if (!signal.aborted) handlers.setLoading(false);
  }
}

interface TimelineContentProps {
  docName: string;
  diffLayout: DiffLayout;
  onDiffLayoutChange: (layout: DiffLayout) => void;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return t`just now`;
  if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return plural(mins, { one: '# min ago', other: '# min ago' });
  }
  if (diffSec < 86400) {
    const hrs = Math.floor(diffSec / 3600);
    return t`${hrs}h ago`;
  }
  if (diffSec < 86400 * 2) return t`yesterday`;
  const days = Math.floor(diffSec / 86400);
  if (days < 7) return plural(days, { one: '# day ago', other: '# days ago' });
  return date.toLocaleDateString();
}

function formatAbsoluteTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function displayAuthor(entry: TimelineEntry): string {
  if (entry.type === 'upstream') return t`Upstream sync`;
  if (entry.contributors.length === 1) return entry.contributors[0].name;
  if (entry.contributors.length > 1) return entry.contributors.map((c) => c.name).join(', ');
  if (entry.author === 'openknowledge-server' || entry.author === 'server') return t`Auto-save`;
  return entry.author;
}

function AgentBrandIcon({ icon, ...props }: { icon?: string } & SVGProps<SVGSVGElement>) {
  if (icon === 'claude') return <ClaudeIcon {...props} />;
  if (icon === 'cursor') return <CursorIcon {...props} />;
  if (icon === 'windsurf') return <WindsurfIcon {...props} />;
  if (icon === 'openai') return <CodexIcon {...props} />;
  if (icon === 'cline') return <ClineIcon {...props} />;
  if (icon === 'github') return <CopilotIcon {...props} />;
  return <Sparkles strokeWidth={1.5} {...(props as LucideProps)} />;
}

function ContributorIcon({ entry, isDark }: { entry: TimelineEntry; isDark: boolean }) {
  const iconClass = 'size-3.5 shrink-0 text-muted-foreground';

  if (entry.type === 'upstream') return <GitBranch className={iconClass} />;

  if (entry.contributors.length > 0) {
    const c = entry.contributors[0];
    const seed = c.colorSeed ?? c.name;
    const icon = iconFromClientName(seed);
    const brandColor = isDark
      ? (AGENT_ICON_COLORS_DARK[icon] ?? AGENT_ICON_COLORS[icon])
      : AGENT_ICON_COLORS[icon];
    const color = brandColor ?? colorFromSeed(seed);

    if (icon !== 'bot') {
      return (
        <AgentBrandIcon icon={icon} width={14} height={14} className="shrink-0" style={{ color }} />
      );
    }

    if (c.name === 'File System') return <HardDrive className={iconClass} />;
    if (c.name === 'OpenKnowledge (service)' || c.name === 'Git (upstream)') {
      return <ArrowDownToLine className={iconClass} />;
    }

    return <User className={iconClass} />;
  }

  if (
    entry.authorEmail.includes('agent') ||
    entry.author.includes('agent') ||
    entry.authorEmail.includes('cursor') ||
    entry.authorEmail.includes('claude')
  ) {
    return <Sparkles className={iconClass} />;
  }
  if (entry.author === 'openknowledge-server' || entry.author === 'server') {
    return <ArrowDownToLine className={iconClass} />;
  }
  return <User className={iconClass} />;
}

export function allSummariesFor(entry: TimelineEntry): string[] {
  const out: string[] = [];
  for (const c of entry.contributors) {
    if (!c.summaries) continue;
    for (const s of c.summaries) out.push(s);
  }
  return out;
}

interface SummaryBulletsProps {
  summaries: string[];
}

function SummaryBullets({ summaries }: SummaryBulletsProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (summaries.length === 0) return null;
  const [first, ...rest] = summaries;
  const hidden = rest.length;
  return (
    <div className="mt-0.5">
      <ul id={listId} className="list-none">
        <li className="text-xs text-foreground/90">
          <span aria-hidden="true">• </span>
          {first}
        </li>
        {expanded &&
          rest.map((s, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: bullet list is append-only within a debounce window — no reorder, no insertion, no deletion. Index in the composite key is needed because contributor-tracker.ts:87-91 explicitly permits duplicate summaries (text-only key collides on dupes and breaks React reconciliation).
            <li key={`${idx}-${s}`} className="text-xs text-foreground/90">
              <span aria-hidden="true">• </span>
              {s}
            </li>
          ))}
      </ul>
      {rest.length > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((prev) => !prev);
          }}
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {expanded ? <Trans>Hide</Trans> : <Trans>Show {hidden} more</Trans>}
        </button>
      )}
    </div>
  );
}

interface EntryDiffPanelProps {
  sha: string;
  docName: string;
  cache: LruStringCache;
  diffLayout: DiffLayout;
  panelId: string;
}

function EntryDiffPanel({ sha, docName, cache, diffLayout, panelId }: EntryDiffPanelProps) {
  const result = useTimelineEntryDiff(sha, docName, cache);

  return (
    <div id={panelId} className="px-3 pb-2" data-testid="timeline-entry-diff">
      {result.status === 'loading' && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          <Trans>Loading diff</Trans>
        </div>
      )}
      {result.status === 'error' && (
        <p className="py-2 text-xs text-destructive">
          <Trans>Diff unavailable</Trans>
        </p>
      )}
      {result.status === 'ready' && (
        <Suspense
          fallback={
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              <Trans>Loading diff renderer</Trans>
            </div>
          }
        >
          <LazyActivityPanelDiffView diff={result.diff} viewType={diffLayout} />
        </Suspense>
      )}
    </div>
  );
}

interface EntryRowProps {
  entry: TimelineEntry;
  isDark: boolean;
  diffLayout: DiffLayout;
  cache: LruStringCache;
  docName: string;
  expanded: boolean;
  onToggleExpanded: (sha: string) => void;
  onRestoreSuccess: () => void;
}

function EntryRow({
  entry,
  isDark,
  diffLayout,
  cache,
  docName,
  expanded,
  onToggleExpanded,
  onRestoreSuccess,
}: EntryRowProps) {
  const { t } = useLingui();
  const relative = formatRelativeTime(entry.timestamp);
  const authorName = displayAuthor(entry);
  const absoluteTime = formatAbsoluteTime(entry.timestamp);
  const entrySha = shortSha(entry.sha);
  const allDocs = entry.contributors.flatMap((c) => c.docs);
  const allSummaries = allSummariesFor(entry);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const diffPanelId = useId();

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleActivate = () => onToggleExpanded(entry.sha);

  function handleCancelDialog() {
    abortRef.current?.abort();
    abortRef.current = null;
    setRestoring(false);
    setDialogOpen(false);
  }

  async function handleRestore() {
    setRestoring(true);
    const controller = new AbortController();
    abortRef.current = controller;

    function cleanup() {
      if (!controller.signal.aborted) setRestoring(false);
      if (abortRef.current === controller) abortRef.current = null;
    }

    let res: Response;
    try {
      res = await fetch('/api/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, commitSha: entry.sha }),
        signal: controller.signal,
      });
    } catch (err) {
      if (
        !controller.signal.aborted &&
        !(err instanceof DOMException && err.name === 'AbortError')
      ) {
        console.error('[timeline] rollback fetch failed', { docName, sha: entry.sha, err });
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
      setDialogOpen(false);
      onRestoreSuccess();
    } else {
      let detail = `HTTP ${res.status}`;
      try {
        const problem = ProblemDetailsSchema.safeParse(await res.json());
        if (problem.success) detail = problem.data.title;
      } catch {}
      console.error('[timeline] rollback failed', {
        docName,
        sha: entry.sha,
        status: res.status,
        detail,
      });
      toast.error(t`Restore failed`, { description: detail, duration: 6000 });
    }
    cleanup();
  }

  const leadingIcon = <ContributorIcon entry={entry} isDark={isDark} />;

  return (
    <>
      <div className="flex flex-col rounded-lg">
        {/* biome-ignore lint/a11y/useSemanticElements: row contains a nested SummaryBullets expander and a Restore <button>; native nested buttons inside a <button> are invalid HTML, so the row uses div[role=button] to preserve keyboard activation while allowing the nested interactive children. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-controls={expanded ? diffPanelId : undefined}
          data-testid="timeline-entry-expand"
          className={[
            'group flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring',
            expanded ? 'bg-muted' : 'hover:bg-muted/80',
          ].join(' ')}
          onClick={handleActivate}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleActivate();
            }
          }}
        >
          {/* mt-0.5 aligns the icon to the center of the first text line rather than the full content block */}
          <span className="mt-0.5 shrink-0">{leadingIcon}</span>

          <div className="min-w-0 flex-1 space-y-0.5">
            {/* Row 1: title + date + Restore icon, vertically centered with the icon */}
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs text-foreground">{authorName}</span>
              <time
                className="ml-auto shrink-0 text-xs text-muted-foreground/80"
                dateTime={entry.timestamp}
                title={entry.timestamp}
              >
                {relative}
              </time>
              {/* Visual separator anchors the destructive Restore action as its own region. */}
              <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0 text-muted-foreground hover:text-destructive"
                    data-testid="timeline-entry-restore"
                    aria-label={t`Restore to this point`}
                    disabled={restoring}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDialogOpen(true);
                    }}
                  >
                    {restoring ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Undo2 className="size-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{t`Restore to this point`}</TooltipContent>
              </Tooltip>
            </div>

            {/* Row 2: details, aligned with title start */}
            {allSummaries.length > 0 && <SummaryBullets summaries={allSummaries} />}
            {allDocs.length > 0 ? (
              <p className="truncate text-xs text-muted-foreground" title={allDocs.join(', ')}>
                {allDocs.join(', ')}
              </p>
            ) : (
              <p className="truncate text-xs text-muted-foreground" title={entry.message}>
                {entry.message}
              </p>
            )}
          </div>
        </div>

        {expanded && (
          <EntryDiffPanel
            sha={entry.sha}
            docName={docName}
            cache={cache}
            diffLayout={diffLayout}
            panelId={diffPanelId}
          />
        )}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next) handleCancelDialog();
          else setDialogOpen(true);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Restore to this point?`}</DialogTitle>
            <DialogDescription>
              <Trans>
                This will replace the current document content with the version from{' '}
                <span className="font-medium text-foreground">
                  {relative} ({absoluteTime}, {entrySha})
                </span>{' '}
                by <span className="font-medium text-foreground">{authorName}</span>. Your current
                content is already saved in the timeline — you can restore it anytime.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="timeline-entry-restore-cancel"
              onClick={handleCancelDialog}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="destructive"
              data-testid="timeline-entry-restore-confirm"
              disabled={restoring}
              onClick={() => handleRestore()}
            >
              {restoring ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              <Trans>Restore</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function TimelineContent({ docName, diffLayout, onDiffLayoutChange }: TimelineContentProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cache] = useState(() => new LruStringCache(HISTORICAL_CONTENT_CACHE_LIMIT));
  const [expandedShas, setExpandedShas] = useState<Set<string>>(() => new Set());

  // biome-ignore lint/correctness/useExhaustiveDependencies: cache is a stable useState-initialized instance — including it in deps would not change behavior but reads as a noisier signal of "this effect depends on the cache" when in fact it depends only on the active doc.
  useEffect(() => {
    setExpandedShas(new Set());
    cache.clear();
  }, [docName]);

  function toggleExpanded(sha: string) {
    setExpandedShas((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  }

  function handleRestoreSuccess() {
    setExpandedShas(new Set());
  }

  useEffect(() => {
    if (!docName) {
      setEntries([]);
      return;
    }

    setLoading(true);
    const loop = createSelfSchedulingPoll({
      baseMs: TIMELINE_POLL_BASE_MS,
      maxBackoffMs: TIMELINE_POLL_MAX_BACKOFF_MS,
      isPaused: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
      poll: (signal) =>
        pollHistoryOnce(docName, signal, {
          setEntries,
          setError,
          setLoading,
          unavailableMessage: t`History unavailable`,
        }),
    });

    loop.start();
    const onVisibilityChange = () => loop.resume();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      loop.stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [docName, t]);

  const hasEntries = !loading && !error && entries.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Panel header — uses the shared PanelHeader primitive for parity with
          GraphPanel/LinksPanel (justify-between puts the title left, the
          diff-layout toggle right). The toggle only renders once there are
          entries to diff. */}
      <PanelHeader>
        <PanelTitle>
          <Trans>Timeline</Trans>
        </PanelTitle>

        {hasEntries && (
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroup
                type="single"
                value={diffLayout}
                onValueChange={(v) => {
                  if (v) onDiffLayoutChange(v as DiffLayout);
                }}
                aria-label={t`Diff layout`}
                variant="segmented"
                size="sm"
                spacing={1}
                className="bg-muted dark:bg-background p-0.5 rounded-md shrink-0"
              >
                <ToggleGroupItem
                  value="unified"
                  aria-label={t`Unified diff`}
                  className="size-6 px-0"
                >
                  <Rows2 className="size-3.5" />
                </ToggleGroupItem>
                <ToggleGroupItem value="split" aria-label={t`Split diff`} className="size-6 px-0">
                  <Columns2 className="size-3.5" />
                </ToggleGroupItem>
              </ToggleGroup>
            </TooltipTrigger>
            <TooltipContent>
              {diffLayout === 'unified' ? <Trans>Unified diff</Trans> : <Trans>Split diff</Trans>}
            </TooltipContent>
          </Tooltip>
        )}
      </PanelHeader>
      {/* Scrollable entry list */}
      <div className="flex-1 overflow-y-auto subtle-scrollbar scroll-fade-mask">
        {/* Loading skeleton */}
        {loading && (
          <div
            className="flex flex-col gap-1 p-2"
            role="status"
            aria-busy="true"
            aria-label={t`Loading timeline history`}
          >
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-2.5 rounded-lg px-3 py-2.5">
                <Skeleton className="size-3.5 rounded mt-0.5 shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-3 w-40" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="px-4 py-3">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && entries.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              <Trans>No history yet</Trans>
            </p>
          </div>
        )}

        {/* Flat reverse-chronological list of actor/system commits. */}
        {!loading && !error && entries.length > 0 && (
          <div className="flex flex-col gap-1 p-2">
            {entries.map((entry) => (
              <EntryRow
                key={entry.sha}
                entry={entry}
                isDark={isDark}
                diffLayout={diffLayout}
                cache={cache}
                docName={docName}
                expanded={expandedShas.has(entry.sha)}
                onToggleExpanded={toggleExpanded}
                onRestoreSuccess={handleRestoreSuccess}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
