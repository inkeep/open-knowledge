/**
 * Toast body for a background bug-report send.
 *
 * Sonner calls a `toast.custom` render function exactly once and keeps the
 * element it returned, so this component has to watch the send itself: it
 * subscribes to its own operation and re-renders in place as progress moves
 * and the outcome lands. It reads state and reports intent, nothing more —
 * every side effect (closing the toast, retrying, opening the draft, revealing
 * the bundle, writing the clipboard) arrives as a callback, so the toast never
 * reaches for the desktop bridge or restarts the send it is describing.
 *
 * Keep Radix context consumers out of here. `<Toaster />` now renders inside
 * `<TooltipProvider>`, so a `<Tooltip>` would no longer throw for want of a
 * provider — but the toaster is still outside every error boundary, so ANY
 * throw from this body unmounts the React root, on a successful send. The
 * provider move removed one cause; it did not add a net. Each primitive used
 * here must supply its own context, and `CopyReferenceButton` below stays
 * tooltip-free so the success path depends on nothing above it.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { AlertCircleIcon, CheckIcon, CopyIcon, InfoIcon, MailIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import type { BugReportSendManager, BugReportSendOperation } from '@/lib/bug-report-send-manager';
import { formatBundleSize } from '@/lib/bug-report-support';
import { revealInFileManagerLabel } from '@/lib/platform-labels';

/** Matches `CopyButton`'s window, so the two affordances feel like one. */
const COPIED_RESET_MS = 1500;

export interface BugReportSendToastActions {
  /** Close this toast. The send keeps running; only the watching stops. */
  readonly dismiss: () => void;
  /** Send the same bundle again under the same operation. */
  readonly retry: () => void;
  readonly openExternal: (url: string) => void;
  readonly revealInFileManager: (zipPath: string) => void;
  readonly writeToClipboard: (text: string) => Promise<void>;
}

export interface BugReportSendToastProps {
  readonly operationId: string;
  readonly manager: BugReportSendManager;
  readonly actions: BugReportSendToastActions;
  /** The bridge's `process.platform`, which names the file manager. */
  readonly platform?: string | null;
}

type OperationOf<S extends BugReportSendOperation['status']> = Extract<
  BugReportSendOperation,
  { status: S }
>;

export function BugReportSendToast({
  operationId,
  manager,
  actions,
  platform,
}: BugReportSendToastProps) {
  const operation = useSyncExternalStore(manager.subscribe, () => manager.get(operationId));

  // Unreachable in production: the manager never forgets an operation, and a
  // toast is only minted for one it published. Rendering nothing still beats
  // inventing a state for a send this window knows nothing about.
  if (operation === undefined) return null;

  switch (operation.status) {
    case 'sending':
      return <SendingLayout operation={operation} actions={actions} />;
    case 'sent':
      return <SentLayout operation={operation} actions={actions} />;
    case 'email-draft':
      return <EmailDraftLayout operation={operation} actions={actions} platform={platform} />;
    case 'failed':
      return <FailedLayout operation={operation} actions={actions} platform={platform} />;
    case 'already-sending':
      return <AlreadySendingLayout actions={actions} />;
  }
}

/**
 * Sonner renders its own close button only for a non-jsx toast, so a
 * `toast.custom` body gets none however `<Toaster />` is configured. The gate
 * is per-body, not per-layout, so the card supplies its own on every outcome.
 *
 * A 20px circle pinned to the inline-start corner and offset out over the
 * border, matching where sonner puts its own at the time of writing, so this
 * toast dismisses from the same place as the app's ordinary toasts. The offset
 * is a negative logical margin rather than a translate: `buttonVariants` drives
 * its press feedback through `translate-y`, and a positioning translate on the
 * same custom property loses to the higher-specificity `:active` rule.
 *
 * First in source as well as first on screen, so the control at the reading
 * origin is also the one focus reaches first.
 */
function ToastCard({
  icon,
  onDismiss,
  children,
}: {
  icon: ReactNode;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <div className="relative flex w-full gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg">
      <Button
        type="button"
        variant="ghost"
        className="-ms-[0.4375rem] -mt-[0.4375rem] absolute start-0 top-0 size-5 rounded-full border-border bg-popover p-0 text-popover-foreground"
        aria-label={t`Close`}
        onClick={onDismiss}
      >
        <XIcon className="size-3" aria-hidden="true" />
      </Button>
      {icon}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex flex-wrap gap-2">{children}</div>;
}

function SendingLayout({
  operation,
  actions,
}: {
  operation: OperationOf<'sending'>;
  actions: BugReportSendToastActions;
}) {
  const titleId = useId();
  return (
    <ToastCard
      icon={<Spinner className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />}
      onDismiss={actions.dismiss}
    >
      <div className="flex items-baseline gap-2">
        <p id={titleId} className="font-medium text-sm">
          <Trans>Sending report</Trans>
        </p>
        {/* No byte-level progress crosses the IPC boundary, so the only honest
            number here is the total size. */}
        <span className="ms-auto shrink-0 text-muted-foreground text-xs">
          <Trans>{formatBundleSize(operation.zipSizeBytes)} total</Trans>
        </span>
      </div>
      {/* The fill is a time-eased estimate, not real transfer progress, so the
          machine-readable state stays indeterminate (`value` null, hence no
          aria-valuenow) while the bar still moves — assistive tech must not
          hear invented percentages. The visible title is the bar's name; a
          second string would only restate it. */}
      <Progress
        value={null}
        indeterminateFillPercent={operation.fillPercent}
        aria-labelledby={titleId}
        className="h-1.5 bg-secondary"
      />
    </ToastCard>
  );
}

function SentLayout({
  operation,
  actions,
}: {
  operation: OperationOf<'sent'>;
  actions: BugReportSendToastActions;
}) {
  return (
    <ToastCard
      icon={<CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />}
      onDismiss={actions.dismiss}
    >
      <p className="font-medium text-sm">
        <Trans>Thanks for the report!</Trans>
      </p>
      <p className="text-muted-foreground text-sm">
        <Trans>We've filed it with the team and attached your logs.</Trans>
      </p>
      <div className="mt-0.5 flex items-center gap-1.5">
        {/* Labelled, not bare: on its own the identifier reads as a ticket the
            reporter is expected to open, when it is the handle they quote back
            to support. Matches the label the dialog used before the toast. */}
        <span className="shrink-0 text-muted-foreground text-xs">
          <Trans>Reference</Trans>
        </span>
        <span className="min-w-0 select-all truncate font-mono font-medium text-xs tracking-wide">
          {operation.reference}
        </span>
        <CopyReferenceButton reference={operation.reference} write={actions.writeToClipboard} />
      </div>
      {/* No reveal action: retention reclaims the zip on a confirmed send, so
          the file is gone by the time this renders. */}
    </ToastCard>
  );
}

function EmailDraftLayout({
  operation,
  actions,
  platform,
}: {
  operation: OperationOf<'email-draft'>;
  actions: BugReportSendToastActions;
  platform?: string | null;
}) {
  return (
    <ToastCard
      icon={<MailIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />}
      onDismiss={actions.dismiss}
    >
      <p className="font-medium text-sm">
        <Trans>Send your report by email</Trans>
      </p>
      {/* Informational, not an error: with no report service configured the
          prefilled draft is how reports travel, so nothing was attempted and
          nothing failed. */}
      <p className="text-muted-foreground text-sm">
        <Trans>
          Nothing was uploaded. The report stays on this computer until you email it to us.
        </Trans>
      </p>
      <ActionRow>
        <Button size="sm" onClick={() => actions.openExternal(operation.mailtoUrl)}>
          <Trans>Open email draft</Trans>
        </Button>
        <RevealBundleButton
          zipPath={operation.zipPath}
          platform={platform}
          onReveal={actions.revealInFileManager}
        />
      </ActionRow>
    </ToastCard>
  );
}

function FailedLayout({
  operation,
  actions,
  platform,
}: {
  operation: OperationOf<'failed'>;
  actions: BugReportSendToastActions;
  platform?: string | null;
}) {
  const { mailtoUrl } = operation;
  return (
    <ToastCard
      icon={
        <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      }
      onDismiss={actions.dismiss}
    >
      <p className="font-medium text-sm">
        <Trans>Couldn't send the report</Trans>
      </p>
      <p className="text-muted-foreground text-sm">
        <Trans>Your report is saved on this computer, so nothing was lost.</Trans>
      </p>
      <ActionRow>
        <Button size="sm" onClick={actions.retry}>
          <Trans>Try again</Trans>
        </Button>
        {/* Main composes the fallback draft as part of its result, so a send
            the transport never completed has no draft to offer. */}
        {mailtoUrl !== undefined && (
          <Button size="sm" variant="outline" onClick={() => actions.openExternal(mailtoUrl)}>
            <Trans>Open email draft</Trans>
          </Button>
        )}
        <RevealBundleButton
          zipPath={operation.zipPath}
          platform={platform}
          onReveal={actions.revealInFileManager}
        />
      </ActionRow>
    </ToastCard>
  );
}

function AlreadySendingLayout({ actions }: { actions: BugReportSendToastActions }) {
  return (
    <ToastCard
      icon={<InfoIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />}
      onDismiss={actions.dismiss}
    >
      <p className="font-medium text-sm">
        <Trans>Already sending this report</Trans>
      </p>
      {/* Deliberately offers no email draft: the bundle is mid-flight, and
          mailing support a report that is also being filed is the duplicate
          this outcome exists to prevent. */}
      <p className="text-muted-foreground text-sm">
        <Trans>
          This report is already on its way. Its result will appear in your bug report history.
        </Trans>
      </p>
    </ToastCard>
  );
}

function RevealBundleButton({
  zipPath,
  platform,
  onReveal,
}: {
  zipPath: string;
  platform?: string | null;
  onReveal: (zipPath: string) => void;
}) {
  return (
    <Button size="sm" variant="ghost" onClick={() => onReveal(zipPath)}>
      {revealInFileManagerLabel(platform)}
    </Button>
  );
}

/**
 * `CopyButton` without its `<Tooltip>`. Not because the provider is missing
 * any more (the toaster now renders inside `<TooltipProvider>`), but because
 * this body sits outside every error boundary: the fewer things the success
 * path can throw on, the better. The tooltip was only carrying the label, and
 * the `aria-label` carries it here just as well for a screen reader.
 */
function CopyReferenceButton({
  reference,
  write,
}: {
  reference: string;
  write: (text: string) => Promise<void>;
}) {
  const { t } = useLingui();
  // A monotonic tick rather than a boolean so a re-click while already
  // "copied" restarts the reset timer.
  const [copyTick, setCopyTick] = useState(0);
  const copied = copyTick > 0;

  useEffect(() => {
    if (copyTick === 0) return;
    const id = setTimeout(() => setCopyTick(0), COPIED_RESET_MS);
    return () => clearTimeout(id);
  }, [copyTick]);

  const handleClick = () => {
    Promise.resolve()
      .then(() => write(reference))
      .then(
        () => setCopyTick((n) => n + 1),
        () => {
          // Permission denial / insecure context — the clipboard is the one
          // boundary here that can refuse. Leave the icon as Copy rather than
          // claim a write that did not happen.
        },
      );
  };

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={copied ? t`Copied!` : t`Copy reference`}
      onClick={handleClick}
    >
      {copied ? (
        <CheckIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <CopyIcon className="size-3.5" aria-hidden="true" />
      )}
    </Button>
  );
}
