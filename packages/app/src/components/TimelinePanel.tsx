// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * TimelinePanel — document edit history content for the DocPanel timeline tab.
 *
 * Fetches GET /api/history on mount, polls every 10s while mounted. The
 * timeline surfaces only actor/system commits — WIP writes from agents,
 * principals, the file watcher, the service, plus upstream syncs — as a flat
 * reverse-chronological list. Checkpoint rows are filtered out: checkpoints
 * — from background cleanup jobs (shadow-branch GC, auto-consolidation,
 * silent rescue) and from agents via the MCP `checkpoint` tool — are restore
 * points, not user-facing edit history (agents reach them through `history` /
 * `restore_version`). The WIP commits those checkpoints fold over remain
 * visible (the server walks their ancestry), so dropping the checkpoint rows
 * loses no edit history.
 *
 * Per-row UX:
 *   - Click a row → open the version's "what changed" diff in the main editor
 *     pane (full-pane overlay, `TimelineDiffPane`), driven by `timeline-diff-store`.
 *     The active row is highlighted while its diff is open. There is no inline
 *     expand and no mode toggle — a version always shows what it changed vs the
 *     previous version.
 *   - The per-row Restore icon (lucide Undo2, ghost variant, hover-destructive)
 *     sits in the row header. Restore rolls back to that version via
 *     POST /api/rollback; the confirm dialog names how many later edits it
 *     undoes (`laterEdits` = the row's index). For the latest version
 *     (`laterEdits === 0`) there is nothing to roll back, so restore is instant
 *     with no confirm. Cancel aborts the in-flight fetch via AbortController.
 */
import {
  AGENT_ICON_COLORS,
  AGENT_ICON_COLORS_DARK,
  colorFromSeed,
  iconFromClientName,
  ProblemDetailsSchema,
  type TimelineEntry,
} from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  GitBranch,
  HardDrive,
  Loader2,
  RotateCcw,
  Sparkles,
  Undo2,
  User,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AgentIcon } from '@/components/icons/AgentIcon';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { closeAgentDiff } from '@/lib/agent-diff-store';
import { createSelfSchedulingPoll, type PollOutcome } from '@/lib/self-scheduling-poll';
import {
  closeTimelineDiff,
  openTimelineDiff,
  useTimelineDiffView,
} from '@/lib/timeline-diff-store';

// History poll cadence. The loop is SELF-SCHEDULING: the
// next poll is armed only after the previous one settles, so a slow query on a
// degraded repo can never stack requests into a self-inflicted load storm.
const TIMELINE_POLL_BASE_MS = 10_000;
// Errors back off exponentially up to this cap (no tight error loop); a success
// resets the cadence to the base interval.
const TIMELINE_POLL_MAX_BACKOFF_MS = 60_000;

/**
 * Run one history poll. Lives at module scope — NOT nested in the component —
 * because the React Compiler cannot lower a `try`/`finally` (it errors on the
 * finalizer clause) and it compiles every function nested inside a component.
 * The `finally`-based loading cleanup is legal here; the component passes its
 * state setters and the localized error string in via `handlers`.
 */
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
    // Drop checkpoint rows: they're background-cleanup artifacts now, not
    // user history. The WIP commits they fold over are returned independently
    // (the server walks checkpoint ancestry), so this loses no edit history.
    // Exclude-by-type (not an allowlist) keeps any future actor/system entry
    // type visible by default.
    handlers.setEntries((data.entries ?? []).filter((e) => e.type !== 'checkpoint'));
    handlers.setError(null);
    return 'ok';
  } catch (e) {
    // Re-throw an abort (unmount / doc-nav) so the loop treats it as a
    // cancellation, not an error to back off from.
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    handlers.setError(handlers.unavailableMessage);
    console.error('[timeline]', e);
    return 'error';
  } finally {
    // Guard against setState after the poll was aborted (unmount).
    if (!signal.aborted) handlers.setLoading(false);
  }
}

// ─── Public props ────────────────────────────────────────────────────────────

interface TimelineContentProps {
  docName: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Classify a timeline entry from its commit subject into a friendly descriptor,
 * so the row shows "Restored to the version from …" / "Renamed …" instead of the
 * raw `rollback: doc to a1b2c3d` / `rename: a -> b` subject. `edit` is the
 * default — those rows fall back to the agent summary / doc list as before.
 */
type EntryDescriptor =
  | { kind: 'restore'; targetSha7: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'reconcile' }
  | { kind: 'upstream' }
  | { kind: 'edit' };

function classifyEntry(entry: TimelineEntry): EntryDescriptor {
  if (entry.type === 'upstream') return { kind: 'upstream' };
  const msg = entry.message;
  const rollback = /^rollback: .+ to ([0-9a-f]{7,40})$/.exec(msg);
  if (rollback) return { kind: 'restore', targetSha7: rollback[1].slice(0, 7) };
  const rename = /^rename: (.+) -> (.+)$/.exec(msg);
  if (rename) return { kind: 'rename', from: rename[1], to: rename[2] };
  if (msg.startsWith('reconcile: ')) return { kind: 'reconcile' };
  if (msg.startsWith('import: ')) return { kind: 'upstream' };
  return { kind: 'edit' };
}

/** Basename of a doc path, for compact rename labels. */
function docLeaf(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Map internal author names to user-friendly display names. Uses structured contributors when available. */
function displayAuthor(entry: TimelineEntry): string {
  if (entry.type === 'upstream') return t`Upstream sync`;
  if (entry.contributors.length === 1) return entry.contributors[0].name;
  if (entry.contributors.length > 1) return entry.contributors.map((c) => c.name).join(', ');
  // Pre-attribution fallback
  if (entry.author === 'openknowledge-server' || entry.author === 'server') return t`Auto-save`;
  return entry.author;
}

/** Icon for a timeline entry contributor. Brand icons for agents, lucide icons for system writers. */
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

    // Known agent brand → brand icon with brand color (dark override when available)
    if (icon !== 'bot') {
      return (
        <AgentIcon icon={icon} width={14} height={14} className="shrink-0" style={{ color }} />
      );
    }

    // Classified system writers
    if (c.name === 'File System') return <HardDrive className={iconClass} />;
    if (c.name === 'OpenKnowledge (service)' || c.name === 'Git (upstream)') {
      return <ArrowDownToLine className={iconClass} />;
    }

    // Human or unknown contributor
    return <User className={iconClass} />;
  }

  // Pre-attribution fallback
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

// ─── Summary bullets ──────────────────────────────────────────────────────────
//
// Agent-provided summaries render as a collapsible bullet list under the author
// line. First bullet inline, further bullets behind a "Show N more" expander.
// The doc-list line ALWAYS renders alongside — it stays ground truth;
// bullets enrich, they don't replace.

/**
 * Flatten summaries across contributors (flat shape) preserving insertion
 * order. Multi-contributor commits coalesce into one flat list — per-bullet
 * contributor identity is deliberately deferred. Exported so the test suite
 * can lock the flatten invariant without touching React.
 */
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

/**
 * Collapsible bullet renderer. Default is collapsed so coalesced-heavy rows
 * don't dominate the panel. The expander is a real `<button>` — this works
 * because EntryRow is a `<div role="button">` (nested `<button>` inside a
 * `<button>` is invalid HTML; see EntryRow comment). The expander's
 * onClick stops propagation so the row's onSelect doesn't also fire.
 *
 * Markup shape: a SINGLE `<ul>` containing the always-visible first bullet
 * AND the expanded rest (conditionally rendered) — screen-reader list
 * navigation (VoiceOver rotor, JAWS list mode, NVDA) treats every bullet as
 * part of the same list instead of seeing the first as a free-floating
 * paragraph. The expander lives OUTSIDE the `<ul>` because `<button>` is not
 * a valid `<ul>` child per HTML spec.
 *
 * Keys combine the bullet's positional index with its text. The contributor
 * accumulator explicitly permits duplicate summaries within a debounce window
 * (`contributor-tracker.ts:87-91` — "No dedup: an agent may legitimately log
 * the same summary twice"), so a text-only key would collide on duplicates
 * and trigger React's "two children with the same key" warning + subtly wrong
 * reconciliation. The list is append-only with no reorder within a row, so a
 * positional component is safe.
 */
function SummaryBullets({ summaries }: SummaryBulletsProps) {
  const [expanded, setExpanded] = useState(false);
  // `useId` is React 19's idiomatic source for associating the expander
  // `<button aria-controls>` with its `<ul>` — each row instance gets its own
  // unique id, so multiple TimelinePanel rows mounted on one page don't
  // collide. NVDA and JAWS use this association to announce which region
  // just grew/shrank when the user activates "Show N more"; without it the
  // user only hears "expanded" with no cue about what changed.
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

// ─── Entry row ────────────────────────────────────────────────────────────────

/**
 * Row-2 detail line, chosen by the entry's classified kind. A restore renders
 * "Restored to the version from <date>" and — when the target version is on the
 * loaded page — links to it (click scrolls + flashes that row). Other kinds get
 * a friendly label instead of the raw commit subject; ordinary edits fall back
 * to the doc list.
 */
function EntryDetail({
  descriptor,
  allDocs,
  versionBySha7,
  onJumpToVersion,
}: {
  descriptor: EntryDescriptor;
  allDocs: string[];
  versionBySha7: Map<string, TimelineEntry>;
  onJumpToVersion: (sha7: string) => void;
}) {
  const { t } = useLingui();

  if (descriptor.kind === 'restore') {
    const target = versionBySha7.get(descriptor.targetSha7);
    const label = target
      ? t`Restored to the version from ${formatAbsoluteTime(target.timestamp)}`
      : t`Restored an earlier version (${descriptor.targetSha7})`;
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <RotateCcw className="size-3 shrink-0" aria-hidden />
        {target ? (
          <button
            type="button"
            className="truncate text-left underline-offset-2 hover:text-foreground hover:underline"
            title={label}
            onClick={(e) => {
              e.stopPropagation();
              onJumpToVersion(descriptor.targetSha7);
            }}
          >
            {label}
          </button>
        ) : (
          <span className="truncate" title={label}>
            {label}
          </span>
        )}
      </div>
    );
  }

  if (descriptor.kind === 'rename') {
    return (
      <p
        className="flex items-center gap-1 truncate text-xs text-muted-foreground"
        title={`${descriptor.from} → ${descriptor.to}`}
      >
        <ArrowLeftRight className="size-3 shrink-0" aria-hidden />
        <span className="truncate">
          {t`Renamed ${docLeaf(descriptor.from)} → ${docLeaf(descriptor.to)}`}
        </span>
      </p>
    );
  }

  if (descriptor.kind === 'reconcile') {
    return <p className="truncate text-xs text-muted-foreground">{t`Synced from disk`}</p>;
  }

  if (allDocs.length > 0) {
    return (
      <p className="truncate text-xs text-muted-foreground" title={allDocs.join(', ')}>
        {allDocs.join(', ')}
      </p>
    );
  }

  // Upstream syncs already say "Upstream sync" on the author line (displayAuthor)
  // — a detail line would just repeat it, so render none.
  if (descriptor.kind === 'upstream') return null;

  return <p className="truncate text-xs text-muted-foreground">{t`Edited`}</p>;
}

interface EntryRowProps {
  entry: TimelineEntry;
  isDark: boolean;
  docName: string;
  /** Number of newer versions above this row — what a restore rolls back. */
  laterEdits: number;
  onRestoreSuccess: () => void;
  /** Resolve a 7-char SHA to the version it points at (for restore-row labels). */
  versionBySha7: Map<string, TimelineEntry>;
  /** Scroll to + flash the version a restore row points at. */
  onJumpToVersion: (sha7: string) => void;
  /** Register this row's element so a jump can scroll it into view. */
  registerRowRef: (el: HTMLDivElement | null) => void;
  /** True while this row is the flash target of a just-clicked jump. */
  flashing: boolean;
}

function EntryRow({
  entry,
  isDark,
  docName,
  laterEdits,
  onRestoreSuccess,
  versionBySha7,
  onJumpToVersion,
  registerRowRef,
  flashing,
}: EntryRowProps) {
  const { t } = useLingui();
  const relative = formatRelativeTime(entry.timestamp);
  const authorName = displayAuthor(entry);
  const absoluteTime = formatAbsoluteTime(entry.timestamp);
  const allDocs = entry.contributors.flatMap((c) => c.docs);
  const allSummaries = allSummariesFor(entry);
  const descriptor = classifyEntry(entry);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Highlight the row whose diff is currently open in the main pane.
  const activeDiff = useTimelineDiffView();
  const isActive = activeDiff?.docName === docName && activeDiff.sha === entry.sha;

  // Aborting an in-flight restore on unmount avoids state writes on a
  // disposed component if the response lands after the user navigated away.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Open the full-pane "what changed" diff in the main editor pane. The two
  // full-pane diffs share one overlay slot — close the agent diff so they
  // can't both paint.
  const handleActivate = () => {
    closeAgentDiff();
    openTimelineDiff({
      docName,
      sha: entry.sha,
      parentSha: entry.parentSha ?? null,
      laterEdits,
      authorName,
      relativeTime: relative,
      absoluteTime,
    });
  };

  function handleCancelDialog() {
    // Cancel honors the user's intent: any in-flight rollback is aborted so
    // the document is not silently rewritten after they "Cancel".
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
      } catch {
        // non-JSON body; keep status detail
      }
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
      <div
        ref={registerRowRef}
        className={[
          'flex flex-col rounded-lg transition-shadow',
          flashing ? 'ring-2 ring-ring ring-offset-1 ring-offset-background' : '',
        ].join(' ')}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: row contains a nested SummaryBullets expander and a Restore <button>; native nested buttons inside a <button> are invalid HTML, so the row uses div[role=button] to preserve keyboard activation while allowing the nested interactive children. */}
        <div
          role="button"
          tabIndex={0}
          aria-pressed={isActive}
          data-testid="timeline-entry-open"
          className={[
            'group flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring',
            isActive ? 'bg-muted' : 'hover:bg-muted/80',
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
                      if (laterEdits > 0) setDialogOpen(true);
                      else handleRestore();
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
            <EntryDetail
              descriptor={descriptor}
              allDocs={allDocs}
              versionBySha7={versionBySha7}
              onJumpToVersion={onJumpToVersion}
            />
          </div>
        </div>
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

// ─── Main content (no Sheet wrapper) ─────────────────────────────────────────

export function TimelineContent({ docName }: TimelineContentProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Row elements keyed by full SHA, so a restore row can scroll its target into
  // view; `flashSha` briefly rings that target after the jump.
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [flashSha, setFlashSha] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 7-char SHA → version, so a `rollback: … to <sha7>` row can name and link the
  // version it restored (only versions on the loaded page resolve).
  const versionBySha7 = new Map<string, TimelineEntry>();
  for (const e of entries) versionBySha7.set(e.sha.slice(0, 7), e);

  useEffect(() => () => clearTimeout(flashTimer.current ?? undefined), []);

  function handleJumpToVersion(sha7: string) {
    const target = versionBySha7.get(sha7);
    if (!target) return;
    rowRefs.current.get(target.sha)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashSha(target.sha);
    clearTimeout(flashTimer.current ?? undefined);
    flashTimer.current = setTimeout(() => setFlashSha(null), 1600);
  }

  function handleRestoreSuccess() {
    // A restore made the open diff's baseline stale — close the pane. (Doc nav
    // is handled by EditorArea, which closes the diff when the open doc changes.)
    closeTimelineDiff();
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
      // Hidden tab issues zero requests — the loop parks until re-shown.
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

  return (
    <div className="flex h-full flex-col">
      {/* Panel header. The diff layout (unified/split) toggle moved to the
          full-pane diff view, where the diff actually renders. */}
      <PanelHeader>
        <PanelTitle>
          <Trans>Timeline</Trans>
        </PanelTitle>
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
            {entries.map((entry, index) => (
              <EntryRow
                key={entry.sha}
                entry={entry}
                isDark={isDark}
                docName={docName}
                laterEdits={index}
                onRestoreSuccess={handleRestoreSuccess}
                versionBySha7={versionBySha7}
                onJumpToVersion={handleJumpToVersion}
                registerRowRef={(el) => {
                  if (el) rowRefs.current.set(entry.sha, el);
                  else rowRefs.current.delete(entry.sha);
                }}
                flashing={flashSha === entry.sha}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
