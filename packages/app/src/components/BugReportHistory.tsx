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
 * per-row actions are Retry (hand the existing bundle to the background send
 * manager without regenerating), a support follow-up on a sent report that has
 * a reference, Reveal (open the zip in Finder), and Delete. The surface is
 * deliberately lightweight (a transient posture), not a management console.
 * Desktop-only — the callers gate on `window.okDesktop`.
 */

import type { OkBugReportListRow } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDownIcon, FolderOpenIcon, MailIcon, RotateCwIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { bugReportSendManager } from '@/lib/bug-report-send-manager';
import { formatBundleSize, supportMailtoUrl } from '@/lib/bug-report-support';
import { revealInFileManagerLabel } from '@/lib/platform-labels';

type PendingAction = 'retrying' | 'deleting';
type HistoryStatus = 'loading' | 'ready' | 'error';

/**
 * The settled send operations by id, tagged with the request that settled them.
 * A retry bumps `requestSeq`, so a report that terminates a second time reads
 * as a new entry rather than as the one already seen.
 */
function settledSends(): Map<string, number> {
  const settled = new Map<string, number>();
  for (const operation of bugReportSendManager.getSnapshot()) {
    if (operation.status !== 'sending') settled.set(operation.operationId, operation.requestSeq);
  }
  return settled;
}

/**
 * Fetch the report history on mount and expose the per-row actions. Retry hands
 * the persisted bundle to the background send manager and stops there — the
 * outcome, including the no-intake email draft, belongs to the send's toast, so
 * a retry never mails support without being asked. Delete and Reveal still act
 * directly and reload the list themselves.
 *
 * The list also reloads when a background send terminates, whichever surface
 * started it: a send outlives this component now, so without that an open pane
 * keeps asserting `Sending` about a report that already landed.
 */
function useReportHistory() {
  const { t } = useLingui();
  const [status, setStatus] = useState<HistoryStatus>('loading');
  const [reports, setReports] = useState<OkBugReportListRow[]>([]);
  const [pending, setPending] = useState<Record<string, PendingAction>>({});
  /**
   * Bumped by every load and once more on unmount, so a reply that lost the
   * race to a later load — or arrived after the pane closed — recognizes itself
   * as stale and writes nothing. Reloads now fire from the send manager as well
   * as from the action handlers, so two really can be in flight at once.
   */
  const loadToken = useRef(0);

  async function load() {
    loadToken.current += 1;
    const token = loadToken.current;
    const bugReport = window.okDesktop?.bugReport;
    if (!bugReport) {
      setStatus('error');
      return;
    }
    try {
      const result = await bugReport.list();
      if (loadToken.current !== token) return;
      if (result.ok) {
        setReports(result.reports);
        setStatus('ready');
      } else {
        setStatus('error');
      }
    } catch {
      if (loadToken.current === token) setStatus('error');
    }
  }

  function clearPending(ids: readonly string[]) {
    setPending((prev) => {
      if (!ids.some((id) => id in prev)) return prev;
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: one load and one subscription for the pane's lifetime; `load` only touches refs and setState
  useEffect(() => {
    void load();
    // Progress is deliberately ignored: the eased fill publishes five times a
    // second and changes nothing a row says. Only a terminal state does.
    let settled = settledSends();
    const unsubscribe = bugReportSendManager.subscribe(() => {
      const next = settledSends();
      const finished = [...next]
        .filter(([id, requestSeq]) => settled.get(id) !== requestSeq)
        .map(([id]) => id);
      settled = next;
      if (finished.length === 0) return;
      clearPending(finished);
      void load();
    });
    return () => {
      unsubscribe();
      // Whatever is still in flight is answering a pane that no longer exists.
      loadToken.current += 1;
    };
  }, []);

  function retry(row: OkBugReportListRow) {
    if (!row.retryable) return;
    // The manager keys the operation by the bundle's basename, which is exactly
    // how Electron main derives the report id this row was built from — so the
    // operation and `row.id` name the same report, and the spinner clears when
    // that operation settles. No bridge guard here: a renderer with no desktop
    // bridge resolves the operation to a failure the toast can state, which
    // beats a Retry press that does nothing at all.
    bugReportSendManager.startBugReportSend({ kind: 'history-row', row });
    setPending((prev) => ({ ...prev, [row.id]: 'retrying' }));
  }

  async function remove(row: OkBugReportListRow) {
    const bugReport = window.okDesktop?.bugReport;
    if (!bugReport) return;
    setPending((prev) => ({ ...prev, [row.id]: 'deleting' }));
    await bugReport.delete(row.id).catch(() => undefined);
    await load();
    clearPending([row.id]);
  }

  function reveal(row: OkBugReportListRow) {
    void window.okDesktop?.shell.showItemInFolder(row.zipPath);
  }

  /**
   * Follow up on a landed report. The reference is the subject so support can
   * correlate the mail with the bundle already in their hands — which is why
   * a sent row without one offers nothing to press.
   */
  function contactSupport(row: OkBugReportListRow) {
    if (row.reference === undefined) return;
    void window.okDesktop?.shell.openExternal(supportMailtoUrl(t`Bug report ${row.reference}`));
  }

  return { status, reports, pending, retry, remove, reveal, contactSupport };
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
  onContactSupport,
  onReveal,
  onDelete,
}: {
  row: OkBugReportListRow;
  pending: PendingAction | undefined;
  onRetry: (row: OkBugReportListRow) => void;
  onContactSupport: (row: OkBugReportListRow) => void;
  onReveal: (row: OkBugReportListRow) => void;
  onDelete: (row: OkBugReportListRow) => void;
}) {
  const { t, i18n } = useLingui();
  const busy = pending !== undefined;
  const when =
    row.createdAt === ''
      ? t`Unknown date`
      : // The picked interface language, not the OS one — otherwise a user on an
        // English machine who chose Spanish reads Spanish copy beside an
        // English-formatted date. Empty until the catalog activates, and
        // `new Intl.DateTimeFormat('')` throws, so fall back to the runtime's
        // own locale for that window.
        new Intl.DateTimeFormat(i18n.locale || undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(row.createdAt));
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
            <span>{formatBundleSize(row.zipBytes)}</span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {row.retryable ? (
          <Button variant="outline" size="xs" disabled={busy} onClick={() => onRetry(row)}>
            {pending === 'retrying' ? (
              <Spinner aria-hidden="true" />
            ) : (
              <RotateCwIcon aria-hidden="true" />
            )}
            <Trans>Retry</Trans>
          </Button>
        ) : null}
        {row.state === 'sent' && row.reference !== undefined ? (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={t`Email support about this report`}
            onClick={() => onContactSupport(row)}
          >
            <MailIcon aria-hidden="true" />
          </Button>
        ) : null}
        {row.zipExists ? (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={revealInFileManagerLabel(
              typeof window !== 'undefined' ? window.okDesktop?.platform : undefined,
            )}
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
            <Spinner aria-hidden="true" />
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
  contactSupport,
}: ReturnType<typeof useReportHistory>) {
  return (
    <div className="flex flex-col gap-2">
      {reports.map((row) => (
        <ReportRow
          key={row.id}
          row={row}
          pending={pending[row.id]}
          onRetry={retry}
          onContactSupport={contactSupport}
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
        <Spinner className="size-4" aria-hidden="true" />
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
