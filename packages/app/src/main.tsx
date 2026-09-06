import { initFrontendTelemetry } from './telemetry';

initFrontendTelemetry();
void import('./telemetry-startup').then((m) => m.initStartupTrace());

import '@/lib/perf/scheduler-polyfill-shim';

import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary, CrashReportingBoundary } from '@/components/AppErrorBoundary';
import { AcpHarnessAgentDetection } from '@/components/acp/AcpHarnessAgentDetection';
import { selectDesktopRootApp } from '@/components/desktop-root-app';
import { ReportBugCrashInviteTrigger } from '@/components/ReportBugCrashInviteTrigger';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { startDisplayLockCrashKeyReporter } from '@/editor/display-lock-crash-key';
import '@/lib/desktop-bridge-types';
import { useHydrateRegisteredAgentMeta } from '@/lib/acp/catalog';
import { installClientFetchWrapper } from '@/lib/client-fetch';
import { installConsentListener } from '@/lib/consent-store';
import { installContactEmailStore } from '@/lib/contact-email-store';
import { installCrashInviteListener } from '@/lib/crash-invite-store';
import { installFeedbackNudgeStore } from '@/lib/feedback-nudge-store';
import { i18n } from '@/lib/i18n';
import { installBugReportSendToasts } from '@/lib/install-bug-report-send-toasts';
import { installClientLogForwarder } from '@/lib/install-client-log-forwarder';
import { installDeepLinkListener } from '@/lib/install-deep-link-listener';
import { installOnboardingToastListener } from '@/lib/install-onboarding-toast';
import { installRecentRemovedListener } from '@/lib/install-recent-removed-listener';
import { installServerDriftListener } from '@/lib/install-server-drift-listener';
import { installMcpConsentListener } from '@/lib/mcp-consent-store';
import { installOnboardingCardStore } from '@/lib/onboarding-card-store';
import { initWebVitals } from '@/lib/perf';
import {
  installColdMountInstrumentation,
  shouldInstallColdMountInstrumentation,
} from '@/lib/perf/cold-mount-instrumentation';
import { installPointerPositionTracker } from '@/lib/pointer-position';
import { installRelaunchStateBridge } from '@/lib/relaunch-store';
import { requestStoragePersistence } from '@/lib/request-storage-persistence';
import { installShareReceivedListener } from '@/lib/share/receive-store';
import { seedInitialDocHashFromWindow } from '@/lib/single-file-initial-doc';
import { installSubscribeCardStore } from '@/lib/subscribe-card-store';
import { installUpdateNoticesBridge } from '@/lib/update-notices-store';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'react-medium-image-zoom/dist/styles.css';
import 'katex/dist/katex.min.css';
import './globals.css';

installClientFetchWrapper({
  apiOrigin: typeof window !== 'undefined' ? window.okDesktop?.config.apiOrigin : undefined,
});

installClientLogForwarder();

void requestStoragePersistence();

if (shouldInstallColdMountInstrumentation()) {
  installColdMountInstrumentation();
}
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  initWebVitals();
}

installUpdateNoticesBridge();

installOnboardingCardStore();

installSubscribeCardStore();

installFeedbackNudgeStore();

installContactEmailStore();

if (typeof window !== 'undefined' && window.okDesktop !== undefined) {
  installPointerPositionTracker();
}

installRelaunchStateBridge();

if (typeof window !== 'undefined') {
  installDeepLinkListener({ bridge: window.okDesktop });
}

if (typeof window !== 'undefined') {
  installServerDriftListener({ bridge: window.okDesktop });
}

if (typeof window !== 'undefined') {
  installRecentRemovedListener({ bridge: window.okDesktop });
}

if (typeof window !== 'undefined') {
  installMcpConsentListener({ bridge: window.okDesktop });
}

if (typeof window !== 'undefined') {
  installConsentListener({ bridge: window.okDesktop });
}

if (typeof window !== 'undefined') {
  installOnboardingToastListener({ bridge: window.okDesktop });
}

if (typeof window !== 'undefined') {
  installShareReceivedListener({ bridge: window.okDesktop });
}

if (typeof window !== 'undefined') {
  installCrashInviteListener({ bridge: window.okDesktop });
}

if (typeof window !== 'undefined') {
  installBugReportSendToasts({ bridge: window.okDesktop });
}

seedInitialDocHashFromWindow();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000 },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

const desktopBridge = typeof window === 'undefined' ? undefined : window.okDesktop;

function RegisteredAgentHydrator(): null {
  useHydrateRegisteredAgentMeta();
  return null;
}

startDisplayLockCrashKeyReporter({ root: document });

createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AcpHarnessAgentDetection />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          storageKey="ok-theme-v1"
        >
          <RegisteredAgentHydrator />
          {}
          <TooltipProvider>
            <AppErrorBoundary>{selectDesktopRootApp(desktopBridge)}</AppErrorBoundary>
            {}
            {desktopBridge !== undefined && (
              <CrashReportingBoundary>
                <ReportBugCrashInviteTrigger bridge={desktopBridge} />
              </CrashReportingBoundary>
            )}
            {}
            <Toaster richColors closeButton />
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
