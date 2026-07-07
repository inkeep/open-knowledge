/**
 * Settings → Account — shows the GitHub connection state and lets the user
 * connect (opens the existing AuthModal) or disconnect. Disconnect clears
 * OpenKnowledge's own token through the same relay used for status/repos.
 *
 * Transports are caller-injected and default to the HTTP path (editor window
 * + web distribution). The Project Navigator window, which has no backing API
 * server, injects the IPC transports — mirroring CloneDialog / AuthModal.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { AuthModal } from '@/components/AuthModal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { setLastKnownSignedIn } from '@/lib/auth-state-cache';
import type { OkLocalOpAuthStatusResponse } from '@/lib/desktop-bridge-types';
import {
  type AuthQueryTransport,
  httpAuthQueryTransport,
} from '@/lib/transports/auth-query-transport';
import type { AuthTransport } from '@/lib/transports/auth-transport';

type StatusState =
  | { phase: 'loading' }
  | { phase: 'loaded'; result: OkLocalOpAuthStatusResponse }
  | { phase: 'check-failed' };

interface AccountSectionProps {
  /**
   * One-shot status / signout transport. Defaults to the HTTP path; the
   * Navigator window passes an IPC transport.
   */
  authQueryTransport?: AuthQueryTransport;
  /** Device-flow transport handed to the AuthModal. Defaults to HTTP. */
  authTransport?: AuthTransport;
}

export function AccountSection({ authQueryTransport, authTransport }: AccountSectionProps) {
  const { t } = useLingui();
  const resolvedQuery = authQueryTransport ?? httpAuthQueryTransport();
  const [status, setStatus] = useState<StatusState>({ phase: 'loading' });
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  // Synchronous re-entry guard: `disabled` only takes effect after a re-render,
  // so a same-tick double-click could otherwise spawn two relay signouts.
  const disconnectingRef = useRef(false);

  async function loadStatus() {
    setStatus({ phase: 'loading' });
    try {
      const result = await resolvedQuery.status();
      setStatus({ phase: 'loaded', result });
      // Seed the shared cache the Clone dialog reads on open, so connecting or
      // disconnecting here repaints that surface without a relaunch.
      setLastKnownSignedIn(result.authenticated);
    } catch (err) {
      // The status query crosses the relay subprocess seam (HTTP fetch / IPC).
      // A thrown rejection means we couldn't reach it — distinct from a
      // definitive "not connected" answer, which resolves with authenticated:false.
      // Leave the shared cache untouched: an unreachable check is not a signal
      // to flip other surfaces to signed-out.
      console.warn('[AccountSection] GitHub status check failed', err);
      setStatus({ phase: 'check-failed' });
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: status is checked once when the section mounts; resolvedQuery is recreated per render but functionally stable
  useEffect(() => {
    void loadStatus();
  }, []);

  async function handleDisconnect() {
    if (disconnectingRef.current) return;
    disconnectingRef.current = true;
    // Tear down any in-flight connect before clearing: closing the modal
    // unmounts the device-flow panel, whose cleanup cancels the poll, so a
    // connect can't complete and re-store a token after the clear.
    setAuthModalOpen(false);
    setDisconnecting(true);
    setDisconnectError(null);
    let failure: string | null = null;
    try {
      // Only the HTTP transport implements signout; AccountSection always
      // resolves to it (the IPC/Navigator window has no disconnect surface),
      // so the optional is present in practice — guard keeps the contract honest.
      const result = resolvedQuery.signout
        ? await resolvedQuery.signout()
        : { ok: false as const, error: t`Couldn't disconnect — please try again.` };
      // Show the server's specific reason when present; otherwise a localized
      // fallback (the transport no longer emits an English default).
      if (!result.ok) failure = result.error ?? t`Couldn't disconnect — please try again.`;
    } catch (err) {
      // The signout crosses the relay subprocess seam (HTTP fetch / IPC); a
      // thrown rejection means we couldn't reach it.
      console.warn('[AccountSection] GitHub disconnect failed', err);
      failure = t`Couldn't disconnect — please try again.`;
    }
    // Paint from a re-run status rather than assuming the clear succeeded: on
    // success status reports not-connected; on failure it stays connected, so
    // a failed clear can never paint "Not connected".
    await loadStatus();
    if (failure) setDisconnectError(failure);
    // Release the in-flight guard once the painted state has settled. No
    // try/finally: the only throw source is the awaited signout (caught above),
    // and React Compiler's BuildHIR does not lower try-without-catch.
    setDisconnecting(false);
    disconnectingRef.current = false;
  }

  return (
    <section
      aria-labelledby="settings-account-title"
      className="space-y-3"
      data-testid="settings-account"
    >
      <div className="space-y-1">
        <h3 id="settings-account-title" className="text-base font-semibold">
          <Trans>Account</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Manage the GitHub account OpenKnowledge uses to browse and sync your repositories.
          </Trans>
        </p>
      </div>

      {status.phase === 'loading' ? (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="space-y-2 rounded-md border p-3"
          data-testid="settings-account-loading"
        >
          <span className="sr-only">
            <Trans>Checking your GitHub connection</Trans>
          </span>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-32" />
        </div>
      ) : status.phase === 'check-failed' ? (
        <div
          className="space-y-2 rounded-md border p-3"
          data-testid="settings-account-check-failed"
        >
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>We couldn't check your GitHub connection.</Trans>
          </p>
          <Button variant="outline" size="sm" onClick={() => void loadStatus()}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : status.result.authenticated ? (
        status.result.tier === 'A' ? (
          // Tier A means the credential is delegated from the gh CLI. OpenKnowledge
          // stored no token of its own, so there is nothing for it to disconnect.
          <GhCliRow login={status.result.login} />
        ) : (
          <ConnectedRow
            login={status.result.login}
            disconnecting={disconnecting}
            error={disconnectError}
            onDisconnect={() => void handleDisconnect()}
          />
        )
      ) : (
        <DisconnectedRow onConnect={() => setAuthModalOpen(true)} />
      )}

      <AuthModal
        open={authModalOpen}
        onOpenChange={setAuthModalOpen}
        transport={authTransport}
        onSuccess={() => {
          void loadStatus();
        }}
      />
    </section>
  );
}

function ConnectedRow({
  login,
  disconnecting,
  error,
  onDisconnect,
}: {
  login: string;
  disconnecting: boolean;
  error: string | null;
  onDisconnect: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="settings-account-connected">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            <Trans>Connected as @{login}</Trans>
          </div>
          <p className="text-muted-foreground text-1sm">
            <Trans>OpenKnowledge is using this GitHub account.</Trans>
          </p>
        </div>
        <Button
          variant="outline"
          onClick={onDisconnect}
          disabled={disconnecting}
          aria-describedby="settings-account-disconnect-caveat"
          data-testid="settings-account-disconnect"
        >
          {disconnecting ? <Trans>Disconnecting</Trans> : <Trans>Disconnect</Trans>}
        </Button>
      </div>
      <p
        id="settings-account-disconnect-caveat"
        className="text-muted-foreground text-1sm"
        data-testid="settings-account-disconnect-caveat"
      >
        <Trans>
          Repositories you've already cloned may keep syncing through git's own saved credentials,
          even after you disconnect.
        </Trans>
      </p>
      {error ? (
        <p
          role="alert"
          className="text-sm text-destructive"
          data-testid="settings-account-disconnect-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function GhCliRow({ login }: { login: string }) {
  return (
    <div className="rounded-md border p-3" data-testid="settings-account-gh-cli">
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium">
          <Trans>Connected as @{login}</Trans>
        </div>
        <p className="text-muted-foreground text-1sm">
          <Trans>
            OpenKnowledge is using a GitHub account provided by the gh CLI. There's no separate
            OpenKnowledge credential to disconnect.
          </Trans>
        </p>
      </div>
    </div>
  );
}

function DisconnectedRow({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="rounded-md border p-3" data-testid="settings-account-disconnected">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            <Trans>Not connected</Trans>
          </div>
          <p className="text-muted-foreground text-1sm">
            <Trans>Connect a GitHub account to browse and sync your repositories.</Trans>
          </p>
        </div>
        <Button onClick={onConnect} data-testid="settings-account-connect">
          <Trans>Connect GitHub</Trans>
        </Button>
      </div>
    </div>
  );
}
