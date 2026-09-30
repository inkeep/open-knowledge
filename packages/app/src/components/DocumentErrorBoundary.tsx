import type { HocuspocusProvider } from '@hocuspocus/provider';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { toast } from 'sonner';
import { OkBlobRunnerEasterEgg } from '@/components/OkBlobRunnerEasterEgg';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import { Button } from '@/components/ui/button';
import { MountAbortError } from '@/editor/mount-promise';
import {
  BridgeSetupError,
  DocumentNotFoundError,
  invalidateSyncPromise,
  PreSyncDisconnectError,
  ServerCapabilityMismatchError,
  SyncTimeoutError,
} from '@/editor/sync-promise';
import { recallComponentStack, rememberComponentStack } from '@/lib/component-stack-registry';
import { restartCollabServer } from '@/lib/restart-collab-server';

interface ErrorCopy {
  title: string;
  summary: string;
}

const BACK_NAV_RESET_SENTINEL = '__back-nav__' as const;

const AUTO_RETRY_LIMIT = 3;
const AUTO_RETRY_DELAY_MS = 400;
const AUTO_RETRY_BUDGET_RESET_MS = 60_000;

interface AutoRetryLedger {
  docName: string;
  attempts: number;
  lastAt: number;
  claimedFor: unknown;
}

interface AutoRetryClaim {
  attempt: number;
  fresh: boolean;
}

/* STOP: the claim is keyed on the error identity, not on the effect running. The fallback's
   effect re-mounts for reasons that are not new failures — StrictMode's double invoke, a
   provider identity change — and each re-mount must re-arm the same pending retry rather than
   spend another attempt. */
function claimAutoRetry(
  ledger: AutoRetryLedger,
  docName: string,
  error: unknown,
): AutoRetryClaim | null {
  const now = Date.now();
  if (ledger.docName !== docName || now - ledger.lastAt > AUTO_RETRY_BUDGET_RESET_MS) {
    ledger.docName = docName;
    ledger.attempts = 0;
    ledger.claimedFor = null;
  }
  if (ledger.claimedFor === error && ledger.attempts > 0) {
    return { attempt: ledger.attempts, fresh: false };
  }
  if (ledger.attempts >= AUTO_RETRY_LIMIT) return null;
  ledger.attempts += 1;
  ledger.lastAt = now;
  ledger.claimedFor = error;
  return { attempt: ledger.attempts, fresh: true };
}

export function errorDocName(error: unknown): string | null {
  if (
    error instanceof SyncTimeoutError ||
    error instanceof PreSyncDisconnectError ||
    error instanceof DocumentNotFoundError ||
    error instanceof BridgeSetupError ||
    error instanceof ServerCapabilityMismatchError ||
    error instanceof MountAbortError
  ) {
    return error.docName;
  }
  return null;
}

export function isServerReachError(error: unknown): boolean {
  return error instanceof SyncTimeoutError || error instanceof PreSyncDisconnectError;
}

export function errorCopy(error: unknown): ErrorCopy {
  if (error instanceof SyncTimeoutError) {
    const docName = error.docName;
    return {
      title: t`Couldn't load document`,
      summary: t`"${docName}" took too long. Check your connection.`,
    };
  }
  if (error instanceof PreSyncDisconnectError) {
    const docName = error.docName;
    return {
      title: t`Connection dropped`,
      summary: t`Lost connection to "${docName}".`,
    };
  }
  if (error instanceof DocumentNotFoundError) {
    const docName = error.docName;
    return {
      title: t`Document not found`,
      summary: t`"${docName}" doesn't exist.`,
    };
  }
  if (error instanceof BridgeSetupError) {
    const docName = error.docName;
    return {
      title: t`Couldn't open document`,
      summary: t`Something went wrong opening "${docName}".`,
    };
  }
  if (error instanceof ServerCapabilityMismatchError) {
    return {
      title: t`Server can't open documents`,
      summary: t`This project's running server doesn't support live editing. Restart OpenKnowledge to fix.`,
    };
  }
  if (error instanceof MountAbortError) {
    const docName = error.docName;
    return {
      title: t`Cancelled`,
      summary: t`You cancelled loading "${docName}".`,
    };
  }
  const message =
    error instanceof Error && error.message ? error.message : t`An unexpected error occurred.`;
  return {
    title: t`Unknown error`,
    summary: message,
  };
}

interface DocumentErrorFallbackProps extends FallbackProps {
  activeDocName: string;
  previousDocName?: string;
  onNavigateBack?: (previousDocName: string) => void;
  provider?: HocuspocusProvider | null;
  autoRetryLedger: AutoRetryLedger;
}

function DocumentErrorFallback({
  error,
  resetErrorBoundary,
  activeDocName,
  previousDocName,
  onNavigateBack,
  provider,
  autoRetryLedger,
}: DocumentErrorFallbackProps) {
  const { title, summary } = errorCopy(error);
  const canGoBack = !!previousDocName && !!onNavigateBack;
  const retryRef = useRef<HTMLButtonElement>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const restartBridge = bridge && isServerReachError(error) ? bridge : null;
  const resetRef = useRef(resetErrorBoundary);

  useEffect(() => {
    resetRef.current = resetErrorBoundary;
  });

  useEffect(() => {
    retryRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isServerReachError(error)) return;
    if (!provider) return;

    let armed = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fire = () => {
      if (!armed) return;
      armed = false;
      const claim = claimAutoRetry(autoRetryLedger, activeDocName, error);
      if (claim === null) {
        console.warn(
          `[DocumentErrorBoundary] auto-retry budget spent for ${activeDocName}; leaving the error UI`,
        );
        return;
      }
      if (claim.fresh) {
        console.warn(
          `[DocumentErrorBoundary] auto-retry ${claim.attempt}/${AUTO_RETRY_LIMIT} for ${activeDocName}`,
        );
      }
      // STOP: the auto-retry must reset through resetErrorBoundary() so it takes the same recycle-then-reset ordering as the Try again button.
      timer = setTimeout(() => {
        resetRef.current();
      }, AUTO_RETRY_DELAY_MS);
    };

    const onSynced = ({ state }: { state: boolean }) => {
      if (state) fire();
    };

    if (provider.isSynced) {
      fire();
    } else {
      provider.on('synced', onSynced);
    }

    return () => {
      armed = false;
      provider.off('synced', onSynced);
      if (timer !== null) clearTimeout(timer);
    };
  }, [error, provider, autoRetryLedger, activeDocName]);

  return (
    <div
      role="alert"
      aria-labelledby="document-error-title"
      data-slot="document-error-boundary"
      className="flex h-full flex-col items-center justify-center gap-8 p-8 text-center"
    >
      {}
      <OkBlobRunnerEasterEgg keyboard={isServerReachError(error)} />
      <div className="flex flex-col items-center gap-1">
        <h2 id="document-error-title" className="text-2xl font-light tracking-tighter text-balance">
          {title}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">{summary}</p>
      </div>
      <div className="mt-1 flex gap-2">
        <Button ref={retryRef} variant="default" onClick={resetErrorBoundary}>
          <Trans>Try again</Trans>
        </Button>
        {restartBridge ? (
          <Button
            variant="outline-mono"
            disabled={restarting}
            onClick={() => {
              setRestarting(true);
              restartCollabServer(restartBridge)
                .then((result) => {
                  if (!result.ok) {
                    toast.error(result.message, {
                      id: 'server-restart-error',
                      duration: Infinity,
                    });
                  }
                })
                .catch(() => {})
                .finally(() => setRestarting(false));
            }}
          >
            <Trans>Restart server</Trans>
          </Button>
        ) : null}
        {bridge ? (
          <Button
            variant="ghost"
            className="font-mono uppercase"
            onClick={() => setReportOpen(true)}
          >
            <Trans>Report this error</Trans>
          </Button>
        ) : null}
        {canGoBack ? (
          <Button
            variant="ghost"
            className="font-mono uppercase"
            onClick={() => {
              if (!previousDocName || !onNavigateBack) return;
              const erroredDoc = errorDocName(error) ?? activeDocName;
              invalidateSyncPromise(erroredDoc);
              onNavigateBack(previousDocName);
              resetErrorBoundary(BACK_NAV_RESET_SENTINEL);
            }}
          >
            <Trans>Go back</Trans>
          </Button>
        ) : null}
      </div>
      {bridge ? (
        <ReportBugDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          crashContext={{
            source: 'document view',
            docName: errorDocName(error) ?? activeDocName,
            errorMessage: error instanceof Error && error.message ? error.message : String(error),
            componentStack: recallComponentStack(error),
          }}
        />
      ) : null}
    </div>
  );
}

interface DocumentErrorBoundaryProps {
  activeDocName: string;
  previousDocName?: string;
  onNavigateBack?: (previousDocName: string) => void;
  onRecycle: (docName: string) => void;
  provider?: HocuspocusProvider | null;
  children: React.ReactNode;
}

export function DocumentErrorBoundary({
  activeDocName,
  previousDocName,
  onNavigateBack,
  onRecycle,
  provider,
  children,
}: DocumentErrorBoundaryProps) {
  const autoRetryRef = useRef<AutoRetryLedger>({
    docName: activeDocName,
    attempts: 0,
    lastAt: 0,
    claimedFor: null,
  });

  return (
    <ErrorBoundary
      fallbackRender={(props) => (
        <DocumentErrorFallback
          {...props}
          activeDocName={activeDocName}
          previousDocName={previousDocName}
          onNavigateBack={onNavigateBack}
          provider={provider}
          autoRetryLedger={autoRetryRef.current}
        />
      )}
      resetKeys={[activeDocName]}
      onReset={(details) => {
        if (details.reason === 'imperative-api') {
          const isBackNav =
            Array.isArray(details.args) && details.args[0] === BACK_NAV_RESET_SENTINEL;
          if (isBackNav) {
            console.warn(`[DocumentErrorBoundary] back-nav reset (no recycle)`);
            return;
          }
          onRecycle(activeDocName);
          console.warn(`[DocumentErrorBoundary] retry recycled ${activeDocName}`);
        } else {
          console.warn(
            `[DocumentErrorBoundary] reset by key change (${details.prev?.[0]} → ${details.next?.[0]})`,
          );
        }
      }}
      onError={(error, info) => {
        rememberComponentStack(error, info.componentStack);
        console.error(
          `[DocumentErrorBoundary] rendered fallback for ${activeDocName}: ${errorCopy(error).title}`,
          error,
          info.componentStack ?? '',
        );
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
