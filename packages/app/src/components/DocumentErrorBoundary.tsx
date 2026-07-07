/**
 * DocumentErrorBoundary — error surface for the hybrid Activity + Suspense
 * render tree. Wraps `react-error-boundary` and renders a recoverable fallback
 * when a `DocumentBoundary` (or anything beneath) throws during render — most
 * notably when a `syncPromise` rejects via `use()`.
 *
 * SCOPING: one instance per `<Activity>` inside `EditorActivityPool` — NOT
 * a single top-level boundary for the whole pool. A hidden Activity's cached
 * rejected syncPromise re-throws synchronously on every render; placing the
 * boundary outside Activity lets those throws bubble into the visible UI.
 * Scoping per-Activity confines the error render output to the Activity
 * subtree, where `<Activity mode="hidden">` applies `display:none` — hidden
 * errors stay invisible until their Activity becomes visible again.
 *
 * UX:
 *   - Document name + one-line error summary (per error kind).
 *   - Primary "Try again": recycles the pool entry (fresh provider) so the
 *     next render re-enters Suspense with a fresh `syncPromise`.
 *   - Secondary "Back to previous document": invalidates this doc's cached
 *     `syncPromise` and calls `onNavigateBack` with the prior active
 *     docName. Only rendered when `previousDocName` is present.
 *
 * `resetKeys={[activeDocName]}`: `activeDocName` is the Activity's OWN doc
 * (stable for the lifetime of the Activity), not the globally-active doc —
 * so key changes don't fire spuriously on navigation. Errors clear only
 * through (a) imperative "Try again" (recycle), (b) "Back to previous"
 * (invalidate + nav), or (c) Activity eviction from the MRU mount list.
 *
 * Retry ordering: recycle MUST run before the
 * boundary state clears, otherwise the re-render would pick up the old
 * cached rejected promise (or a broken provider with `synced=true`). We
 * hook that through `onReset` because react-error-boundary fires
 * `onReset(...)` synchronously before calling `setState`.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { toast } from 'sonner';
import { OkBlob } from '@/components/OkBlob';
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
import { restartCollabServer } from '@/lib/restart-collab-server';

interface ErrorCopy {
  title: string;
  summary: string;
}

/**
 * Sentinel string passed to `resetErrorBoundary(...)` from the "Back to
 * previous document" button so `onReset` can differentiate a back-nav
 * reset (no recycle) from a "Try again" reset (needs recycle). The
 * `resetErrorBoundary` args surface as `details.args` in `onReset`.
 */
const BACK_NAV_RESET_SENTINEL = '__back-nav__' as const;

/**
 * Read the errored doc's name from the error object. All typed sync-promise
 * errors carry `docName`; anything else returns null. Exported so tests can
 * pin the typed-error union — a regression that omits a new error class from
 * this branch would silently invalidate the wrong sync-promise on back-nav
 * (the only call site reads `errorDocName(error) ?? activeDocName`).
 */
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

/**
 * Does this error mean the server couldn't be reached (vs. a missing doc, a
 * server-capability mismatch, an aborted mount)? Only reach failures are
 * recoverable by restarting the server — the rest need a different remedy.
 * Exported for unit tests.
 */
export function isServerReachError(error: unknown): boolean {
  return error instanceof SyncTimeoutError || error instanceof PreSyncDisconnectError;
}

/**
 * Map a thrown value to user-facing copy. Pure — unit-testable without a
 * DOM. Kept separate from the React surface so the taxonomy can evolve
 * without touching rendering code.
 *
 * Copy discipline: the user-facing vocabulary is "load"/"loading", not
 * "sync"/"syncing". "Sync" is internal jargon (Y.js/Hocuspocus); the product
 * is a document editor where the user mental model is always "opening a
 * document."
 */
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
    // MountAbortError fires only via explicit `controller.abort()` — the
    // cancel-affordance path. Cache-driven invalidation (LRU eviction,
    // park/evict) is silent and never surfaces here. The user clicked
    // "Cancel" on the stalled-mount affordance, so the copy frames the
    // outcome as their action, not a system fault.
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
  // Desktop only, and only for reach failures: "Try again" recycles the
  // provider against the SAME server, which never succeeds once that server
  // has stopped. Restart spawns a fresh one. `ok ui` (browser) mode has no
  // bridge, so it keeps only "Try again".
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const restartBridge = bridge && isServerReachError(error) ? bridge : null;

  // Move focus to the primary "Try again" action when the fallback mounts so
  // keyboard and screen-reader users land on the recovery affordance without
  // tabbing through the page. WCAG 2.4.3 focus-order guidance for full-surface
  // error states. Paired with role="alert" so AT announces the error context
  // before the focus lands on the button.
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
      <OkBlob size={80} variant="sleeping" />
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
            variant="secondary"
            onClick={() => {
              restartCollabServer(restartBridge)
                .then((result) => {
                  // Success: main tears this window down and recreates it.
                  // Fixed `id` dedupes repeated failed clicks into one toast;
                  // `Infinity` keeps this actionable error until it's replaced.
                  if (!result.ok) {
                    toast.error(result.message, {
                      id: 'server-restart-error',
                      duration: Infinity,
                    });
                  }
                })
                // The invoke can reject when main destroys this window mid-call
                // (the success path) — nothing to surface.
                .catch(() => {});
            }}
          >
            <Trans>Restart server</Trans>
          </Button>
        ) : null}
        {canGoBack ? (
          <Button
            variant="ghost"
            className="font-mono uppercase"
            onClick={() => {
              if (!previousDocName || !onNavigateBack) return;
              // Invalidate the errored doc's cached sync promise BEFORE
              // triggering navigation. The cached rejected promise would
              // otherwise keep throwing for the errored doc's hidden
              // Activity subtree (which stays mounted pool-side), trapping
              // the error boundary after back-nav. A future re-visit to the
              // errored doc will create a fresh syncPromise — exactly what
              // we want for "Back now, retry later" UX. Read the docName
              // from the error itself (not activeDocName prop) because a
              // synchronously-thrown `use()` aborts the transition and
              // leaves activeDocName pointing at the pre-transition doc.
              const erroredDoc = errorDocName(error) ?? activeDocName;
              invalidateSyncPromise(erroredDoc);
              onNavigateBack(previousDocName);
              // Reset the boundary with a sentinel tag so onReset knows
              // this is a back-nav (no recycle). Without this reset, the
              // boundary's resetKeys would stay unchanged on an aborted
              // transition (sync throw aborts the transition before
              // activeDocName can transition commit) and leave the fallback
              // mounted even after the user leaves the errored doc.
              resetErrorBoundary(BACK_NAV_RESET_SENTINEL);
            }}
          >
            <Trans>Go back</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface DocumentErrorBoundaryProps {
  activeDocName: string;
  previousDocName?: string;
  onNavigateBack?: (previousDocName: string) => void;
  /**
   * Called on imperative "Try again" — destroy + recreate the pool entry so
   * the next sync attempt runs against a fresh provider. REQUIRED (not
   * optional) because a `BridgeSetupError`-failed entry would otherwise
   * remain in the pool and the retry would resolve immediately via the
   * warm-path (the broken provider has `synced=true` from the original sync)
   * without re-running `setupObservers`, leaving the user with a
   * non-functional editor and no further error UI. Per precedent
   * #7 ("remove broken capabilities rather than shipping them"), the
   * known-broken fallback path (invalidate-only) is removed entirely — every
   * caller must wire recycle or the retry button is not functional.
   */
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
  // Use `fallbackRender` (not `FallbackComponent`) so inline closures capturing
  // `activeDocName` / `previousDocName` / `onNavigateBack` don't create a new
  // component type on every render. react-error-boundary calls `fallbackRender`
  // as a function and renders the result directly (no createElement), so there
  // is no component-identity-churn remount of the fallback subtree.
  // (FallbackComponent takes the createElement branch; fallbackRender does not.)
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
      // Fires before the boundary clears state, so the next render re-enters
      // Suspense against a fresh syncPromise.
      onReset={(details) => {
        if (details.reason === 'imperative-api') {
          // Back-nav reset carries the sentinel string — do NOT recycle the
          // active doc (we're navigating AWAY from the errored target, not
          // retrying it). Sentinel check reads `details.args` which holds
          // the arguments passed to `resetErrorBoundary(...)`.
          const isBackNav =
            Array.isArray(details.args) && details.args[0] === BACK_NAV_RESET_SENTINEL;
          if (isBackNav) {
            console.warn(`[DocumentErrorBoundary] back-nav reset (no recycle)`);
            return;
          }
          // "Try again" path. Order is load-bearing: recycle FIRST (which
          // destroys the pool entry, calling invalidateSyncPromise via
          // destroyEntry, and recreates the entry with a fresh provider),
          // so that when the boundary re-renders, `EditorArea` sees the new
          // provider and `DocumentBoundary` calls syncPromise(docName,
          // freshProvider) → fresh sync attempt. `onRecycle` is required
          // (not optional) so this branch is always live — see prop doc.
          onRecycle(activeDocName);
          console.warn(`[DocumentErrorBoundary] retry recycled ${activeDocName}`);
        } else {
          // resetKeys change (navigated away). The broken doc's entry stays
          // pool-resident with its cached rejection — revisiting it will
          // re-render the same error UI, where the user can click "Try
          // again" to recycle. Invalidating without recycling would let the
          // warm-path resolve immediately on the broken provider (synced=true,
          // observers not wired), surfacing a non-functional editor with no
          // error UI. The user retains a clear retry path either way.
          console.warn(
            `[DocumentErrorBoundary] reset by key change (${details.prev?.[0]} → ${details.next?.[0]})`,
          );
        }
      }}
      onError={(error) => {
        // Pass the full error object as the second arg so the stack trace and
        // cause chain reach the console — `errorCopy(error).title` alone is a
        // user-facing summary ("Couldn't open document") with no debugging
        // signal. console.error (not warn) so it surfaces at the right severity
        // for the user-visible fallback that just rendered.
        console.error(
          `[DocumentErrorBoundary] rendered fallback for ${activeDocName}: ${errorCopy(error).title}`,
          error,
        );
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
