/**
 * AppErrorBoundary — last-resort boundary for the whole window shell.
 *
 * SCOPING: wraps the root app (editor / Navigator / terminal window) from
 * `main.tsx`, OUTSIDE the hybrid render tree. Document-view errors are caught
 * first by the per-Activity `DocumentErrorBoundary` instances (and the
 * settings chunk by `SettingsDialogErrorBoundary`); this boundary only sees
 * render crashes that escape every inner boundary — app-shell chrome, sidebar,
 * dialogs mounted outside the editor subtree. Without it, such a crash
 * unmounts the React root and white-screens the window with no recovery.
 *
 * Mounted inside the i18n/theme providers so the fallback keeps translated
 * copy and theme tokens; a crash in the provider layer itself is out of scope.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { OkBlob } from '@/components/OkBlob';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import { Button } from '@/components/ui/button';

function AppErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const { t } = useLingui();
  const [reportOpen, setReportOpen] = useState(false);
  const retryRef = useRef<HTMLButtonElement>(null);
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const message =
    error instanceof Error && error.message ? error.message : t`An unexpected error occurred.`;

  // Same focus-order treatment as DocumentErrorFallback: land keyboard and
  // screen-reader users on the recovery affordance, with role="alert"
  // announcing the error context first.
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
      <OkBlob size={80} variant="sleeping" />
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
            // The Navigator window has no project; main labels the bundle
            // truthfully either way — this only keeps the compose summary honest.
            systemWide={bridge.config.mode === 'navigator'}
            crashContext={{
              source: 'app shell',
              errorMessage: error instanceof Error && error.message ? error.message : String(error),
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
      onError={(error) => {
        // Full error object so the stack reaches the console — and, via the
        // renderer console capture, the next diagnostic bundle.
        console.error('[AppErrorBoundary] app-shell render crash', error);
      }}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * Null-fallback boundary for the crash-reporting surfaces themselves — the
 * crash-invite trigger mounted as a sibling of the shell boundary, and the
 * report dialog hosted inside a tripped boundary's fallback. Both render
 * where no other boundary can catch them, so an uncaught throw would unmount
 * the whole React root at exactly the moment the user is recovering from a
 * crash. Losing the reporting affordance is the lesser harm: render nothing.
 */
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
