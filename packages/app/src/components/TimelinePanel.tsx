// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import {
  AGENT_ICON_COLORS,
  AGENT_ICON_COLORS_DARK,
  colorFromSeed,
  iconFromClientName,
  isSurfacedCheckpointKind,
  ProblemDetailsSchema,
  SYSTEM_WRITER_DISPLAY_NAMES,
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
  History,
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
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { closeAgentDiff } from '@/lib/agent-diff-store';
import { createSelfSchedulingPoll, type PollOutcome } from '@/lib/self-scheduling-poll';
import {
  closeTimelineDiff,
  openTimelineDiff,
  useTimelineDiffView,
} from '@/lib/timeline-diff-store';

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
    handlers.setEntries((data.entries ?? []).filter(showsInTimeline));
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
}

function showsInTimeline(entry: TimelineEntry): boolean {
  if (entry.type !== 'checkpoint') return true;
  return entry.checkpoint !== null && isSurfacedCheckpointKind(entry.checkpoint.kind);
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

type EntryDescriptor =
  | { kind: 'restore'; targetSha7: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'reconcile' }
  | { kind: 'upstream' }
  | { kind: 'recovered' }
  | { kind: 'edit' };

function classifyEntry(entry: TimelineEntry): EntryDescriptor {
  if (entry.type === 'checkpoint') return { kind: 'recovered' };
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

function docLeaf(path: string): string {
  return path.split('/').pop() ?? path;
}

function displayAuthor(entry: TimelineEntry): string {
  if (entry.type === 'checkpoint') return t`Recovered content`;
  if (entry.type === 'upstream') return t`Upstream sync`;
  if (entry.contributors.length === 1) return entry.contributors[0].name;
  if (entry.contributors.length > 1) return entry.contributors.map((c) => c.name).join(', ');
  if (entry.author === 'openknowledge-server' || entry.author === 'server') return t`Auto-save`;
  return entry.author;
}

export function contributorIconKind(
  name: string,
): 'file-system' | 'upstream' | 'generated' | 'person' {
  const names = SYSTEM_WRITER_DISPLAY_NAMES;
  if (name === names.fileSystem) return 'file-system';
  if (name === names.service || name === names.gitUpstream) return 'upstream';
  if (name === names.generator) return 'generated';
  return 'person';
}

function ContributorIcon({ entry, isDark }: { entry: TimelineEntry; isDark: boolean }) {
  const iconClass = 'size-3.5 shrink-0 text-muted-foreground';

  if (entry.type === 'checkpoint') return <History className={iconClass} aria-hidden="true" />;
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
        <AgentIcon icon={icon} width={14} height={14} className="shrink-0" style={{ color }} />
      );
    }

    switch (contributorIconKind(c.name)) {
      case 'file-system':
        return <HardDrive className={iconClass} />;
      case 'upstream':
        return <ArrowDownToLine className={iconClass} />;
      case 'generated':
        return <Sparkles className={iconClass} />;
      default:
        return <User className={iconClass} />;
    }
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

  if (descriptor.kind === 'recovered') return null;

  if (allDocs.length > 0) {
    return (
      <p className="truncate text-xs text-muted-foreground" title={allDocs.join(', ')}>
        {allDocs.join(', ')}
      </p>
    );
  }

  if (descriptor.kind === 'upstream') return null;

  return <p className="truncate text-xs text-muted-foreground">{t`Edited`}</p>;
}

interface EntryRowProps {
  entry: TimelineEntry;
  isDark: boolean;
  docName: string;
  laterEdits: number;
  onRestoreSuccess: () => void;
  versionBySha7: Map<string, TimelineEntry>;
  onJumpToVersion: (sha7: string) => void;
  registerRowRef: (el: HTMLDivElement | null) => void;
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
  const activeDiff = useTimelineDiffView();
  const isActive = activeDiff?.docName === docName && activeDiff.sha === entry.sha;

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

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
          {}
          <span className="mt-0.5 shrink-0">{leadingIcon}</span>

          <div className="min-w-0 flex-1 space-y-0.5">
            {}
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs text-foreground">{authorName}</span>
              <time
                className="ml-auto shrink-0 text-xs text-muted-foreground/80"
                dateTime={entry.timestamp}
                title={entry.timestamp}
              >
                {relative}
              </time>
              {}
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
                      <Spinner aria-hidden="true" className="size-3" />
                    ) : (
                      <Undo2 className="size-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{t`Restore to this point`}</TooltipContent>
              </Tooltip>
            </div>

            {}
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
              {restoring ? <Spinner aria-hidden="true" className="mr-2 size-4" /> : null}
              <Trans>Restore</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function TimelineContent({ docName }: TimelineContentProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [flashSha, setFlashSha] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      {}
      <PanelHeader>
        <PanelTitle>
          <Trans>Timeline</Trans>
        </PanelTitle>
      </PanelHeader>
      {}
      <div className="flex-1 overflow-y-auto subtle-scrollbar scroll-fade-mask">
        {}
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

        {}
        {!loading && error && (
          <div className="px-4 py-3">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {}
        {!loading && !error && entries.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              <Trans>No history yet</Trans>
            </p>
          </div>
        )}

        {}
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
