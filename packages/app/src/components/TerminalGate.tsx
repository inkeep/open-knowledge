/**
 * Enforcement gate for the docked terminal.
 *
 * The PTY-spawning {@link TerminalPanel} mounts by default — the terminal is
 * available unless the project-local config explicitly opts out with
 * `terminal.enabled === false`. `terminal.enabled` is `agentSettable:false`
 * (human-only), so an agent can never silence a human who wants the terminal nor
 * re-enable a shell a human turned off; the explicit opt-out is the only refusal.
 *
 * The mount waits for the project-local binding to sync, so an opted-out project
 * never flashes the shell (nor fires a PTY spawn the main backstop would refuse)
 * during the cold-start window before the real value is known.
 *
 * Opting out while a shell is running unmounts TerminalPanel, whose cleanup kills
 * the PTY — turning the terminal off takes effect immediately.
 */
import { useLingui } from '@lingui/react/macro';
import { lazy, Suspense } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTerminalConsentState, useTerminalEnabledWriter } from '@/hooks/use-terminal-enabled';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import type { TerminalLaunchIntent } from './EditorPane';

// xterm + its addons + xterm.css (a heavy, WebGL-bearing payload) import only
// through TerminalPanel, so lazy-loading it keeps them out of the initial
// bundle — including the web host, where the bridge is null and the terminal
// can never render.
const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);

interface TerminalGateProps {
  readonly bridge: OkDesktopBridge;
  /** Forwarded to TerminalPanel so the "Close terminal" button collapses the dock. */
  readonly onClose?: () => void;
  /** Forwarded to TerminalPanel — OSC 0/2 title reports for the dock's tab label. */
  readonly onTitleChange?: (title: string) => void;
  /** "Open in terminal" launch intent, forwarded to the session. */
  readonly launch?: TerminalLaunchIntent | null;
  /** Surviving PTY to adopt after a renderer reload, forwarded to the session;
   *  `null` for a freshly-opened tab. */
  readonly adoptPtyId?: string | null;
  /** Reports the session's live PTY id up to the host — see
   *  {@link TerminalPanelProps.onPtyId}. */
  readonly onPtyId?: (ptyId: string | null) => void;
}

export function TerminalGate({
  bridge,
  onClose,
  onTitleChange,
  launch = null,
  adoptPtyId = null,
  onPtyId,
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
      // Boundary OUTER, Suspense INNER (same composition as SettingsDialog /
      // EditorActivityPool): Suspense only covers the lazy chunk's pending state.
      // A render-time throw — xterm's WebGL/constructor path, or React.lazy
      // re-throwing a rejected chunk import after a deploy bumped the asset hash —
      // is NOT caught by Suspense and would unmount toward the app root, blanking
      // the editor. This boundary scopes the failure to the dock cell.
      <ErrorBoundary
        fallbackRender={(props) => <TerminalErrorFallback {...props} />}
        onError={(error, info) => {
          // console.error (not warn) — a user-visible fallback just rendered.
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
            onPtyId={onPtyId}
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
