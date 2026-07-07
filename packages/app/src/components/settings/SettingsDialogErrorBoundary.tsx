/**
 * Containment boundary for the lazily-loaded Settings body.
 *
 * `SettingsDialogBodyLazy` is a `React.lazy` chunk. When its dynamic
 * import rejects — a transient network blip, or a stale chunk URL after
 * a deploy bumped the asset hash — React.lazy re-throws the rejection on
 * the render path toward the nearest error boundary. `SettingsDialogPortal`
 * is a sibling of the editor subtree (outside `EditorActivityPool`'s
 * `DocumentErrorBoundary`), so without a boundary here the rejection
 * unmounts the entire React root: the whole app white-screens with no
 * recovery. `lazy-with-preload`'s no-op `.catch` only silences the
 * preload-before-render unhandled-rejection channel; it does not and
 * cannot intercept React.lazy's render-path rejection.
 *
 * This boundary scopes the failure to the dialog body cell. The Dialog
 * chrome (title, sidebar, close affordance) and the editor behind it stay
 * mounted and usable — the user keeps working and can dismiss the dialog
 * normally. Recovery is a full page reload: a failed dynamic import is
 * almost always a post-deploy hash change (the old chunk URL is gone) or
 * a network fault, and a reload is the only action that reliably re-fetches
 * the current asset manifest. This mirrors Vite's own `vite:preloadError`
 * recovery guidance; an in-place re-import cannot work because React.lazy
 * permanently caches the rejected module for the component's identity.
 *
 * Same composition as the canonical lazy+Suspense+boundary precedent in
 * `EditorActivityPool` (`DocumentErrorBoundary` OUTER, `Suspense` INNER):
 * boundary catches the rejected chunk, Suspense handles the pending state.
 * `DocumentErrorBoundary` itself is not reusable here — its props bind to
 * the document-sync pool taxonomy (`onRecycle`, `activeDocName`).
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { Button } from '@/components/ui/button';

function SettingsBodyErrorFallback({ error }: FallbackProps) {
  const { t } = useLingui();
  const message =
    error instanceof Error && /dynamically imported module|Failed to fetch/i.test(error.message)
      ? t`A newer version may have been deployed since this tab opened.`
      : t`Something went wrong loading the settings panel.`;
  return (
    <div
      role="alert"
      aria-labelledby="settings-body-error-title"
      data-slot="settings-body-error-boundary"
      className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center"
    >
      <div className="flex flex-col items-center gap-1">
        <h3
          id="settings-body-error-title"
          className="font-heading text-base leading-none font-medium"
        >
          <Trans>Settings failed to load</Trans>
        </h3>
        <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="default" onClick={() => window.location.reload()}>
        <Trans>Reload</Trans>
      </Button>
    </div>
  );
}

export function SettingsDialogErrorBoundary({ children }: { children: React.ReactNode }) {
  // `fallbackRender` over `FallbackComponent` for the same reason
  // `DocumentErrorBoundary` does it: react-error-boundary renders the
  // function result directly with no createElement, so there is no
  // component-identity-churn remount of the fallback subtree.
  return (
    <ErrorBoundary
      fallbackRender={(props) => <SettingsBodyErrorFallback {...props} />}
      onError={(error, info) => {
        // console.error (not warn) — a user-visible fallback just rendered.
        // Include react-error-boundary's `info.componentStack` so the section
        // that faulted (Sync / Templates / Okignore / Integrations) is
        // identifiable from a single bug report — a chunk-load error self-
        // explains, but any other render throw from the ~330kB body subtree
        // would otherwise require bisecting sections to localize.
        console.error(
          '[SettingsDialogErrorBoundary] rendered fallback for Settings body',
          error,
          info.componentStack,
        );
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
