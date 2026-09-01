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
import { SettingsSectionHeader } from './SettingsSectionHeader';

type StatusState =
  | { phase: 'loading' }
  | { phase: 'loaded'; result: OkLocalOpAuthStatusResponse }
  | { phase: 'check-failed' };

interface AccountSectionProps {
  authQueryTransport?: AuthQueryTransport;
  authTransport?: AuthTransport;
}

export function AccountSection({ authQueryTransport, authTransport }: AccountSectionProps) {
  const { t } = useLingui();
  const resolvedQuery = authQueryTransport ?? httpAuthQueryTransport();
  const [status, setStatus] = useState<StatusState>({ phase: 'loading' });
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const disconnectingRef = useRef(false);

  async function loadStatus() {
    setStatus({ phase: 'loading' });
    try {
      const result = await resolvedQuery.status();
      setStatus({ phase: 'loaded', result });
      setLastKnownSignedIn(result.authenticated);
    } catch (err) {
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
    setAuthModalOpen(false);
    setDisconnecting(true);
    setDisconnectError(null);
    let failure: string | null = null;
    try {
      const result = resolvedQuery.signout
        ? await resolvedQuery.signout()
        : { ok: false as const, error: t`Couldn't disconnect — please try again.` };
      if (!result.ok) failure = result.error ?? t`Couldn't disconnect — please try again.`;
    } catch (err) {
      console.warn('[AccountSection] GitHub disconnect failed', err);
      failure = t`Couldn't disconnect — please try again.`;
    }
    await loadStatus();
    if (failure) setDisconnectError(failure);
    setDisconnecting(false);
    disconnectingRef.current = false;
  }

  return (
    <section
      aria-labelledby="settings-account-title"
      className="space-y-3"
      data-testid="settings-account"
    >
      <SettingsSectionHeader
        titleId="settings-account-title"
        title={<Trans>Account</Trans>}
        scope="user"
      >
        <Trans>
          Manage the GitHub account OpenKnowledge uses to browse and sync your repositories.
        </Trans>
      </SettingsSectionHeader>

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
        onOpenChange={(open) => {
          setAuthModalOpen(open);
          if (!open) void loadStatus();
        }}
        transport={authTransport}
        host={status.phase === 'loaded' ? status.result.host : undefined}
        ghAvailable={status.phase === 'loaded' ? status.result.ghAvailable : undefined}
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
          <Trans>Sign in</Trans>
        </Button>
      </div>
    </div>
  );
}
