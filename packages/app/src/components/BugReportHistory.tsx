import type { OkBugReportListRow } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDownIcon, FolderOpenIcon, MailIcon, RotateCwIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { bugReportSendManager } from '@/lib/bug-report-send-manager';
import { bugReportNoteTitle, formatBundleSize, supportMailtoUrl } from '@/lib/bug-report-support';
import { revealInFileManagerLabel } from '@/lib/platform-labels';

type PendingAction = 'retrying' | 'deleting';
type HistoryStatus = 'loading' | 'ready' | 'error';

function settledSends(): Map<string, number> {
  const settled = new Map<string, number>();
  for (const operation of bugReportSendManager.getSnapshot()) {
    if (operation.status !== 'sending') settled.set(operation.operationId, operation.requestSeq);
  }
  return settled;
}

function useReportHistory() {
  const { t } = useLingui();
  const [status, setStatus] = useState<HistoryStatus>('loading');
  const [reports, setReports] = useState<OkBugReportListRow[]>([]);
  const [pending, setPending] = useState<Record<string, PendingAction>>({});
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
      loadToken.current += 1;
    };
  }, []);

  function retry(row: OkBugReportListRow) {
    if (!row.retryable) return;
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
  const title =
    bugReportNoteTitle(row.note) ??
    (row.projectSlug !== null ? t`Report from ${row.projectSlug}` : t`Untitled report`);
  const when =
    row.createdAt === ''
      ? t`Unknown date`
      : new Intl.DateTimeFormat(i18n.locale || undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(row.createdAt));
  return (
    <li className="flex items-start gap-2.5 rounded-md border px-3 py-2.5">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          {}
          <p dir="auto" className="min-w-0 flex-1 truncate text-1sm" title={title}>
            {title}
          </p>
          <StateBadge state={row.state} />
        </div>
        {}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          {row.bundleLevel !== 'unknown' ? <Badge variant="gray">{row.bundleLevel}</Badge> : null}
          <span className="whitespace-nowrap">{when}</span>
          {}
          {row.zipBytes > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span className="whitespace-nowrap">{formatBundleSize(row.zipBytes)}</span>
            </>
          ) : null}
          {row.state === 'sent' && row.reference !== undefined ? (
            <>
              <span aria-hidden>·</span>
              <span>
                <Trans>
                  Reference <span className="font-mono text-foreground">{row.reference}</span>
                </Trans>
              </span>
            </>
          ) : row.state === 'upload-failed' && row.lastError !== undefined ? (
            <>
              <span aria-hidden>·</span>
              <span className="text-destructive">{row.lastError.reason}</span>
            </>
          ) : null}
        </div>
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
    </li>
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
    <ul className="flex flex-col gap-2">
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
    </ul>
  );
}

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

export function BugReportPreviousReports() {
  const [open, setOpen] = useState(false);
  const history = useReportHistory();

  if (history.status !== 'ready' || history.reports.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        {}
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
