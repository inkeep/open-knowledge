import { useLingui } from '@lingui/react/macro';
import { lazy, Suspense } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTerminalConsentState, useTerminalEnabledWriter } from '@/hooks/use-terminal-enabled';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import type { TerminalLaunchIntent } from './EditorPane';

const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);

interface TerminalGateProps {
  readonly bridge: OkDesktopBridge;
  readonly onClose?: () => void;
  readonly onTitleChange?: (title: string) => void;
  readonly launch?: TerminalLaunchIntent | null;
  /** Surviving PTY to adopt after a renderer reload, forwarded to the session;
   *  `null` for a freshly-opened tab. */
  readonly adoptPtyId?: string | null;
}

export function TerminalGate({
  bridge,
  onClose,
  onTitleChange,
  launch = null,
  adoptPtyId = null,
}: TerminalGateProps) {
  const { enabled, synced } = useTerminalConsentState();
  const writer = useTerminalEnabledWriter();
  const { t } = useLingui();

  const optedOut = synced && enabled === false;

  function handleEnable() {
    if (writer === null) {
      toast.error(t`Terminal settings not loaded yet — try again in a moment.`);
      return;
    }
    const result = writer(true);
    if (!result.ok) toast.error(t`Could not enable the terminal: ${result.error}`);
  }

  if (synced && !optedOut) {
    return (
      <ErrorBoundary
        fallbackRender={(props) => <TerminalErrorFallback {...props} />}
        onError={(error, info) => {
          console.error(
            '[TerminalGate] rendered fallback for the terminal panel',
            error,
            info.componentStack,
          );
        }}
      >
        <Suspense fallback={<div className="h-full w-full bg-background" aria-hidden="true" />}>
          <TerminalPanel
            bridge={bridge}
            className="h-full"
            onClose={onClose}
            onTitleChange={onTitleChange}
            launch={launch}
            adoptPtyId={adoptPtyId}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return optedOut ? (
    <TerminalNotEnabledNotice onEnable={handleEnable} />
  ) : (
    <div className="h-full w-full bg-background" aria-hidden="true" />
  );
}

function TerminalErrorFallback({ error }: FallbackProps) {
  const { t } = useLingui();
  const message =
    error instanceof Error && /dynamically imported module|Failed to fetch/i.test(error.message)
      ? t`A newer version may have been deployed since this tab opened.`
      : t`Something went wrong starting the terminal.`;
  return (
    <section
      aria-label={t`Terminal failed to load`}
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-6 text-center"
      role="alert"
    >
      <p className="max-w-sm text-sm text-foreground">{message}</p>
      <Button onClick={() => window.location.reload()}>{t`Reload`}</Button>
    </section>
  );
}

interface TerminalNotEnabledNoticeProps {
  readonly onEnable: () => void;
}

function TerminalNotEnabledNotice({ onEnable }: TerminalNotEnabledNoticeProps) {
  const { t } = useLingui();
  return (
    <section
      aria-label={t`Terminal disabled`}
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-6 text-center"
    >
      <p className="max-w-sm text-sm text-foreground">
        {t`The terminal is turned off for this project. Turn it back on to run commands here.`}
      </p>
      <Button onClick={onEnable}>{t`Enable terminal`}</Button>
      <p className="text-xs text-muted-foreground">{t`You can also manage this in Settings.`}</p>
    </section>
  );
}
