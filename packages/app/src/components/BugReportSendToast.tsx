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

const COPIED_RESET_MS = 1500;

export interface BugReportSendToastActions {
  readonly dismiss: () => void;
  readonly retry: () => void;
  readonly openExternal: (url: string) => void;
  readonly revealInFileManager: (zipPath: string) => void;
  readonly writeToClipboard: (text: string) => Promise<void>;
}

export interface BugReportSendToastProps {
  readonly operationId: string;
  readonly manager: BugReportSendManager;
  readonly actions: BugReportSendToastActions;
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
        {}
        <span className="ms-auto shrink-0 text-muted-foreground text-xs">
          <Trans>{formatBundleSize(operation.zipSizeBytes)} total</Trans>
        </span>
      </div>
      {}
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
        {}
        <span className="shrink-0 text-muted-foreground text-xs">
          <Trans>Reference</Trans>
        </span>
        <span className="min-w-0 select-all truncate font-mono font-medium text-xs tracking-wide">
          {operation.reference}
        </span>
        <CopyReferenceButton reference={operation.reference} write={actions.writeToClipboard} />
      </div>
      {}
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
      {}
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
        {}
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
      {}
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

function CopyReferenceButton({
  reference,
  write,
}: {
  reference: string;
  write: (text: string) => Promise<void>;
}) {
  const { t } = useLingui();
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
        () => {},
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
