import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { OkBlobRunnerEasterEgg } from '@/components/OkBlobRunnerEasterEgg';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import { Button } from '@/components/ui/button';
import { recallComponentStack, rememberComponentStack } from '@/lib/component-stack-registry';
import { recordAppShellCrashTrip } from '@/lib/tab-session-restore-suppression';

function AppErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const { t } = useLingui();
  const [reportOpen, setReportOpen] = useState(false);
  const retryRef = useRef<HTMLButtonElement>(null);
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const message =
    error instanceof Error && error.message ? error.message : t`An unexpected error occurred.`;

  useEffect(() => {
    retryRef.current?.focus();
  }, []);

  return (
    <div
      role="alert"
      aria-labelledby="app-error-title"
      data-slot="app-error-boundary"
      className="flex h-screen flex-col items-center justify-center gap-8 p-8 text-center"
    >
      {}
      <OkBlobRunnerEasterEgg keyboard={false} />
      <div className="flex flex-col items-center gap-1">
        <h1 id="app-error-title" className="text-2xl font-light tracking-tighter text-balance">
          <Trans>Something went wrong</Trans>
        </h1>
        <p className="max-w-sm text-sm break-words text-muted-foreground">{message}</p>
      </div>
      <div className="mt-1 flex gap-2">
        <Button ref={retryRef} variant="default" onClick={() => resetErrorBoundary()}>
          <Trans>Try again</Trans>
        </Button>
        {bridge ? (
          <Button
            variant="ghost"
            className="font-mono uppercase"
            onClick={() => setReportOpen(true)}
          >
            <Trans>Report this error</Trans>
          </Button>
        ) : null}
      </div>
      {bridge ? (
        <CrashReportingBoundary>
          <ReportBugDialog
            open={reportOpen}
            onOpenChange={setReportOpen}
            systemWide={bridge.config.mode === 'navigator'}
            crashContext={{
              source: 'app shell',
              errorMessage: error instanceof Error && error.message ? error.message : String(error),
              componentStack: recallComponentStack(error),
            }}
          />
        </CrashReportingBoundary>
      ) : null}
    </div>
  );
}

export function AppErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary
      FallbackComponent={AppErrorFallback}
      onError={(error, info) => {
        rememberComponentStack(error, info.componentStack);
        recordAppShellCrashTrip(error);
        console.error(
          '[AppErrorBoundary] app-shell render crash',
          error,
          info.componentStack ?? '',
        );
      }}
    >
      {children}
    </ErrorBoundary>
  );
}

export function CrashReportingBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary
      fallback={null}
      onError={(error) => {
        console.error('[CrashReportingBoundary] crash-reporting UI render crash', error);
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
