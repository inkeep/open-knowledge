/**
 * Bug-report history — the persisted list of previously generated reports and
 * their last-known state, backed by `window.okDesktop.bugReport.list()`.
 *
 * Two surfaces share the same list + actions:
 *   - `BugReportHistoryList` — the standalone body (command-palette entry). Shows
 *     a loading / error / empty (with a "Report a bug" CTA) / rows state.
 *   - `BugReportPreviousReports` — the collapsible "Previous reports" disclosure
 *     inside the Report Bug dialog's compose step; renders nothing until there
 *     is at least one prior report, so it never clutters the compose flow.
 *
 * State is shown as an inline status badge (modeless — no nested dialogs), and
 * per-row actions are Retry (resend the existing bundle without regenerating),
 * Reveal (open the zip in Finder), and Delete. The surface is deliberately
 * lightweight (a transient posture), not a management console. Desktop-only —
 * the callers gate on `window.okDesktop`.
 */

import type { OkBugReportListRow } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDownIcon, FolderOpenIcon, Loader2, RotateCwIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

type PendingAction = 'retrying' | 'deleting';
type HistoryStatus = 'loading' | 'ready' | 'error';

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

/**
 * Fetch the report history on mount and expose the per-row actions. Retry
 * resends the persisted bundle via the existing `send` path (reconstructing the
 * send metadata from the row); on the no-intake email-draft path it opens the
 * prefilled draft. Every action reloads the list afterward so the row's badge
 * reflects the new on-disk state.
 */
function useReportHistory() {
  const [status, setStatus] = useState<HistoryStatus>('loading');
  const [reports, setReports] = useState<OkBugReportListRow[]>([]);
  const [pending, setPending] = useState<Record<string, PendingAction>>({});

  async function load() {
    const bugReport = window.okDesktop?.bugReport;
    if (!bugReport) {
      setStatus('error');
      return;
    }
    try {
      const result = await bugReport.list();
      if (result.ok) {
        setReports(result.reports);
        setStatus('ready');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load the history once on mount; the action handlers reload imperatively
  useEffect(() => {
    void load();
  }, []);

  function clearPending(id: string) {
    setPending((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function retry(row: OkBugReportListRow) {
    const bugReport = window.okDesktop?.bugReport;
    if (!bugReport || !row.retryable) return;
    setPending((prev) => ({ ...prev, [row.id]: 'retrying' }));
    // `send` is contract-safe (never rejects); the `.catch` is belt-and-suspenders
    // so a transport-layer IPC failure still clears the spinner and reloads.
    const result = await bugReport
      .send({
        zipPath: row.zipPath,
        metadata: {
          level: row.bundleLevel === 'unknown' ? 'standard' : row.bundleLevel,
          systemWide: row.systemWide,
          projectSlug: row.projectSlug,
        },
      })
      .catch(() => null);
    // The designed no-intake path: nothing uploaded, so hand the user the
    // prefilled email draft (the same behavior the dialog's Send has).
    if (result && !result.ok && result.reason === 'email-draft') {
      void window.okDesktop?.shell.openExternal(result.fallback.mailtoUrl);
    }
    await load();
    clearPending(row.id);
  }

  async function remove(row: OkBugReportListRow) {
    const bugReport = window.okDesktop?.bugReport;
    if (!bugReport) return;
    setPending((prev) => ({ ...prev, [row.id]: 'deleting' }));
    await bugReport.delete(row.id).catch(() => undefined);
    await load();
    clearPending(row.id);
  }

  function reveal(row: OkBugReportListRow) {
    void window.okDesktop?.shell.showItemInFolder(row.zipPath);
  }

  return { status, reports, pending, retry, remove, reveal };
}

function StateBadge({ state }: { state: OkBugReportListRow['state'] }) {
  switch (state) {
    case 'sent':
      return (
        <Badge variant="primary">
          <Trans>Sent</Trans>
        </Badge>
      );
    case 'upload-failed':
      return (
        <Badge variant="destructive">
          <Trans>Failed</Trans>
        </Badge>
      );
    case 'uploading':
      return (
        <Badge variant="warning">
          <Trans>Sending</Trans>
        </Badge>
      );
    case 'email-drafted':
      return (
        <Badge variant="secondary">
          <Trans>Emailed</Trans>
        </Badge>
      );
    case 'generated':
      return (
        <Badge variant="gray">
          <Trans>Not sent</Trans>
        </Badge>
      );
    default:
      return (
        <Badge variant="outline">
          <Trans>Unknown</Trans>
        </Badge>
      );
  }
}

function ReportRow({
  row,
  pending,
  onRetry,
  onReveal,
  onDelete,
}: {
  row: OkBugReportListRow;
  pending: PendingAction | undefined;
  onRetry: (row: OkBugReportListRow) => void;
  onReveal: (row: OkBugReportListRow) => void;
  onDelete: (row: OkBugReportListRow) => void;
}) {
  const { t } = useLingui();
  const busy = pending !== undefined;
  const when =
    row.createdAt === ''
      ? t`Unknown date`
      : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(row.createdAt),
        );
  return (
    <div className="flex items-start gap-2.5 rounded-md border px-3 py-2.5">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <StateBadge state={row.state} />
          {row.bundleLevel !== 'unknown' ? <Badge variant="gray">{row.bundleLevel}</Badge> : null}
          <span className="truncate text-1sm text-muted-foreground">{when}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {row.state === 'sent' && row.reference !== undefined ? (
            <Trans>
              Reference <span className="font-mono text-foreground">{row.reference}</span>
            </Trans>
          ) : row.state === 'upload-failed' && row.lastError !== undefined ? (
            <span className="text-destructive">{row.lastError.reason}</span>
          ) : (
            <span>{formatSize(row.zipBytes)}</span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {row.retryable ? (
          <Button variant="outline" size="xs" disabled={busy} onClick={() => onRetry(row)}>
            {pending === 'retrying' ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <RotateCwIcon aria-hidden="true" />
            )}
            <Trans>Retry</Trans>
          </Button>
        ) : null}
        {row.zipExists ? (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={t`Reveal in Finder`}
            onClick={() => onReveal(row)}
          >
            <FolderOpenIcon aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          aria-label={t`Delete report`}
          onClick={() => onDelete(row)}
        >
          {pending === 'deleting' ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Trash2Icon aria-hidden="true" />
          )}
        </Button>
      </div>
    </div>
  );
}

function ReportRows({
  reports,
  pending,
  retry,
  remove,
  reveal,
}: ReturnType<typeof useReportHistory>) {
  return (
    <div className="flex flex-col gap-2">
      {reports.map((row) => (
        <ReportRow
          key={row.id}
          row={row}
          pending={pending[row.id]}
          onRetry={retry}
          onReveal={reveal}
          onDelete={remove}
        />
      ))}
    </div>
  );
}

/**
 * Standalone history body — loading / error / empty (with a "Report a bug" CTA
 * for someone who opened the history meaning to file a report) / the report
 * rows. Used by the command-palette "Bug report history" entry.
 */
export function BugReportHistoryList({ onReportABug }: { onReportABug?: () => void }) {
  const history = useReportHistory();

  if (history.status === 'loading') {
    return (
      <div role="status" className="flex items-center gap-2.5 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <Trans>Loading your reports</Trans>
      </div>
    );
  }
  if (history.status === 'error') {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        <Trans>Couldn't load your bug reports.</Trans>
      </p>
    );
  }
  if (history.reports.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-sm text-muted-foreground">
          <Trans>No bug reports yet.</Trans>
        </p>
        {onReportABug ? (
          <Button onClick={onReportABug}>
            <Trans>Report a bug</Trans>
          </Button>
        ) : null}
      </div>
    );
  }
  return <ReportRows {...history} />;
}

/**
 * The "Previous reports" disclosure for the Report Bug dialog's compose step.
 * Renders nothing until at least one prior report exists, so the compose flow
 * stays clean when there is no history to show.
 */
export function BugReportPreviousReports() {
  const [open, setOpen] = useState(false);
  const history = useReportHistory();

  if (history.status !== 'ready' || history.reports.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        {/* The hover surface needs breathing room around the label, but the
            label has to stay flush with the report rows below. Padding paired
            with an equal negative margin buys the padding without moving the
            text. The width has to grow by the same 1rem explicitly: a `<button>`
            resolves `width: auto` to fit-content even at `display: flex`, so
            plain `w-full` would leave the surface 8px short on the right while
            the negative margin pulled it 8px left. The vertical pair nets out to
            the original `py-1`, leaving the row's own height unchanged.

            The ghost variant's `data-[state=open]:bg-muted` would leave the
            surface filled for as long as the disclosure stays expanded, which
            reads as a stuck hover next to the rows it just revealed. Dropping
            it back to transparent keeps the fill a hover/focus affordance;
            the rotated chevron already carries the open state. The paired
            `data-[state=open]:hover:` is required, not belt-and-braces: the
            open-state rule otherwise outranks the variant's plain `hover:` and
            hovering an expanded row goes dead. */}
        <Button
          variant="ghost"
          size="sm"
          className="-mx-2 -my-0.5 h-auto w-[calc(100%+1rem)] justify-between px-2 py-1.5 data-[state=open]:bg-transparent data-[state=open]:hover:bg-muted"
        >
          <span className="text-sm font-medium">
            <Trans>Previous reports</Trans>{' '}
            <span className="font-normal text-muted-foreground">({history.reports.length})</span>
          </span>
          <ChevronDownIcon
            className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <ReportRows {...history} />
      </CollapsibleContent>
    </Collapsible>
  );
}
