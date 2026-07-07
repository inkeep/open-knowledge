// OpenTelemetry init runs FIRST (before any other module load) so the
// WebTracerProvider is registered before auto-instrumentations need it. The
// init is opt-in via VITE_OTEL_ENABLED — default-off keeps bundle cost + CORS
// spam out of normal dev sessions.
import { initFrontendTelemetry } from './telemetry';

initFrontendTelemetry();
// Open the `ok.app-startup` renderer span, parented to the Electron main
// process's launch trace via the `startupTraceparent` bridge config.
// No-op when OTel is disabled or there's no traceparent (web build / OTel off).
// Lazy-imported so the renderer startup-trace module (and the OTel
// `context`/`propagation` API surface it pulls) stays out of the always-loaded
// entry chunk; it resolves in a microtask — after the sync `initFrontendTelemetry`
// above, and long before the first-content checkpoint it ends the span on.
void import('./telemetry-startup').then((m) => m.initStartupTrace());

// Side-effect import: install `scheduler.yield()` on browsers that lack native
// support. No-op on modern Chromium / Electron. Must load before any editor
// module so the construction-mount yield-point in `mount-promise.ts` has the
// API available on first cold-mount.
import '@/lib/perf/scheduler-polyfill-shim';

import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { selectDesktopRootApp } from '@/components/desktop-root-app';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
// Side-effect import to load the `Window.okDesktop?` global augmentation.
import '@/lib/desktop-bridge-types';
import { installClientFetchWrapper } from '@/lib/client-fetch';
import { installConsentListener } from '@/lib/consent-store';
// Side-effect import: loads + activates the i18n catalog before first render.
import { i18n } from '@/lib/i18n';
import { installClientLogForwarder } from '@/lib/install-client-log-forwarder';
import { installDeepLinkListener } from '@/lib/install-deep-link-listener';
import { installOnboardingToastListener } from '@/lib/install-onboarding-toast';
import { installServerDriftListener } from '@/lib/install-server-drift-listener';
import { installMcpConsentListener } from '@/lib/mcp-consent-store';
import { installOnboardingCardStore } from '@/lib/onboarding-card-store';
import { initWebVitals } from '@/lib/perf';
import {
  installColdMountInstrumentation,
  shouldInstallColdMountInstrumentation,
} from '@/lib/perf/cold-mount-instrumentation';
import { installRelaunchStateBridge } from '@/lib/relaunch-store';
import { installShareReceivedListener } from '@/lib/share/receive-store';
import { seedInitialDocHashFromWindow } from '@/lib/single-file-initial-doc';
import { installSubscribeCardStore } from '@/lib/subscribe-card-store';
import { installUpdateNoticesBridge } from '@/lib/update-notices-store';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
// react-medium-image-zoom ships structural CSS (modal positioning, dialog
// backdrop, zoom animation gated on prefers-reduced-motion internally). Must
// be imported once globally so the Image component's click-to-zoom works
// without each consumer re-importing.
import 'react-medium-image-zoom/dist/styles.css';
// KaTeX CSS imported eagerly (~20 KB gzipped) — the Math component lazy-imports
// the JS bundle (~270 KB), but the CSS stays eager so it's available in
// environments where dynamic CSS imports don't resolve (Bun test runtime, SSR).
// The big win on the lazy boundary is the JS, not the stylesheet.
import 'katex/dist/katex.min.css';
import './globals.css';

// Always-on client fetch wrapper: injects the client's version headers on every
// `/api/*` request (web, `ok ui`, AND desktop renderer) and — in Electron only,
// where `apiOrigin` is set — rewrites relative `/api/*` to the utility process
// (the renderer host doesn't serve /api; the hocuspocus instance behind the
// bridge does). Must run BEFORE any component mounts so the first paint's
// `fetch('/api/documents')` is both instrumented and routed correctly.
installClientFetchWrapper({
  apiOrigin: typeof window !== 'undefined' ? window.okDesktop?.config.apiOrigin : undefined,
});

// Forward renderer console output to the server `/api/client-logs` ingest so
// client-side events (e.g. provider-pool's "Failed to connect") land in the
// diagnostics bundle. No-op in Electron — the main process captures the
// renderer console directly. Installed AFTER the fetch wrapper so the POST
// carries version headers + same-origin routing.
installClientLogForwarder();

// Install cold-mount instrumentation BEFORE any editor module loads — the
// prototype patches must be in place before the first `new Editor(...)` call.
// Marks emit in DEV/test by default; the `VITE_OK_PERF_INSTRUMENT=1` env-var
// override extends the gate to PROD builds so ship-gate re-baselines can
// measure the true user-visible attack surface. The collector buffer
// (`__ok_perf`) and the inert-in-PROD `mark()` helper still gate on
// `import.meta.env.PROD` separately — see `collector.ts` and `mark.ts`.
if (shouldInstallColdMountInstrumentation()) {
  installColdMountInstrumentation();
}
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  initWebVitals();
}

// Desktop-only: attach the auto-updater notice bridge subscribers at module-init
// time (BEFORE React mounts) so IPC events fired before first render aren't
// dropped, AND so renderer remounts don't detach the subscribers. The
// module-level store in `update-notices-store` buffers notices; the
// `<UpdateNotices />` component reads them via `useSyncExternalStore`.
// No-op in web/CLI distribution (window.okDesktop undefined).
installUpdateNoticesBridge();

// Hydrate the first-run onboarding card store from localStorage at module-init
// (BEFORE React mounts) so the card's persisted progress, dismissal, and
// completion are in place on first paint. Device-local, not bridge-gated —
// safe (no-op) in web/CLI and SSR where localStorage is unreachable.
installOnboardingCardStore();

// Hydrate the subscribe card store (post-update subscribe prompt) from
// localStorage at module-init, same rationale as the onboarding card store:
// persisted subscribe / dismiss / shown-versions budget in place before first
// paint. Device-local; no-op in web/CLI and SSR where localStorage is absent.
installSubscribeCardStore();

// Desktop-only: track whether an auto-update relaunch is in flight (the same
// `ok:update:relaunching` / `ok:update:relaunch-failed` events the notice
// bridge consumes) so connectivity-sensitive panels can show a calm
// "Relaunching…" state during the pre-`quitAndInstall` server teardown instead
// of a red "Could not reach server" error. Module-init for the same
// listener-before-event reason. No-op in web/CLI distribution.
installRelaunchStateBridge();

// Desktop-only: subscribe to the `ok:deep-link` bridge event so an
// `openknowledge://` URL routed to this window updates the hash to open the
// target doc. Registered at module-init so the listener is in
// place before the event can fire.
if (typeof window !== 'undefined') {
  installDeepLinkListener({ bridge: window.okDesktop });
}

// Desktop-only: subscribe to `ok:server-version-drift` so a window that
// attached to a server of a different version surfaces a cancelable
// "restart server" notification, and to `ok:server-restarted` so the
// recreated window confirms the restart. Module-init for the same
// listener-before-event reason as the deep-link wiring above.
if (typeof window !== 'undefined') {
  installServerDriftListener({ bridge: window.okDesktop });
}

// Desktop-only: subscribe to the first-launch MCP consent bridge event
// and call `mcpWiring.signalReady()` so main's whenRendererReady dispatch
// knows this renderer is attached. Same module-init pattern — listeners must
// be in place before `ok:mcp-wiring:show` can fire, and the `signalReady`
// invoke is what flips main's one-shot dispatch after `did-finish-load`.
// No-op in web / CLI distribution (window.okDesktop undefined).
if (typeof window !== 'undefined') {
  installMcpConsentListener({ bridge: window.okDesktop });
}

// Desktop-only: per-project consent dialog. Listener attaches at
// module-init so main's first `ok:onboarding:show` after a Navigator pick
// isn't dropped. Navigator-only — main never dispatches show to the editor
// renderer, but the listener is harmless there too.
if (typeof window !== 'undefined') {
  installConsentListener({ bridge: window.okDesktop });
}

// Desktop-only: editor-window onboarding toast. Listener
// attaches at module-init so a toast fired during `did-finish-load` isn't
// dropped. Editor-only in practice — main only dispatches the toast after
// spawning a fresh editor window.
if (typeof window !== 'undefined') {
  installOnboardingToastListener({ bridge: window.okDesktop });
}

// Desktop-only: share-receive payload listener feeding the shared store.
// The editor shell renders ShareBranchSwitchDialog and the Navigator renders
// ShareReceiveDialog; both read this store, which buffers the payload until
// the relevant component mounts so a payload arriving before React is ready
// isn't dropped.
if (typeof window !== 'undefined') {
  installShareReceivedListener({ bridge: window.okDesktop });
}

// Desktop-only: ephemeral single-file window (`ok <file>`). Seed the doc into
// the hash BEFORE `createRoot().render()` so `NavigationHandler`'s first-mount
// read lands on the file — deterministic, no post-load `ok:deep-link` IPC to
// race. No-op on every other window (`initialDoc` is null) and in web/CLI
// (window.okDesktop undefined).
seedInitialDocHashFromWindow();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000 },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

// Electron window-mode branch: the desktop preload flags `mode` per window so
// the renderer mounts the matching surface — `terminal` → the standalone
// terminal window, `navigator` → the launcher, everything else → the editor
// shell. CLI / web distribution: window.okDesktop is undefined, so this is
// always the editor (`App`) path.
const desktopBridge = typeof window === 'undefined' ? undefined : window.okDesktop;

createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          storageKey="ok-theme-v1"
        >
          <TooltipProvider>{selectDesktopRootApp(desktopBridge)}</TooltipProvider>
          {/*
           * Sonner toaster for ad-hoc status/error toasts (clone dialog, file
           * tree, etc.). Auto-update notices are NOT routed here — they live
           * in the sidebar footer via <UpdateNotices /> for a persistent home
           * that matches their permanent-until-clicked semantics.
           */}
          <Toaster richColors closeButton />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
