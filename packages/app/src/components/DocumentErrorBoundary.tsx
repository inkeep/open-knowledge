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
}

function DocumentErrorFallback({
  error,
  resetErrorBoundary,
  activeDocName,
  previousDocName,
  onNavigateBack,
}: DocumentErrorFallbackProps) {
  const { title, summary } = errorCopy(error);
  const canGoBack = !!previousDocName && !!onNavigateBack;
  const retryRef = useRef<HTMLButtonElement>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const restartBridge = bridge && isServerReachError(error) ? bridge : null;

  useEffect(() => {
    retryRef.current?.focus();
  }, []);

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
  children: React.ReactNode;
}

export function DocumentErrorBoundary({
  activeDocName,
  previousDocName,
  onNavigateBack,
  onRecycle,
  children,
}: DocumentErrorBoundaryProps) {
  return (
    <ErrorBoundary
      fallbackRender={(props) => (
        <DocumentErrorFallback
          {...props}
          activeDocName={activeDocName}
          previousDocName={previousDocName}
          onNavigateBack={onNavigateBack}
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
