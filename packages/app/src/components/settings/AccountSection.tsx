import type { ConfigBinding } from '@inkeep/open-knowledge-core/config/bind-config-doc';
import { isGitCredentialHost } from '@inkeep/open-knowledge-core/constants/github';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef, useState } from 'react';
import { AuthModal } from '@/components/AuthModal';
import { isGitHubRemote, remoteTakesStoredToken } from '@/components/SyncStatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { type GitSyncStatus, useGitSyncStatus } from '@/hooks/use-git-sync-status';
import { recordAuthStatus } from '@/lib/auth-state-cache';
import {
  type AuthQueryStatus,
  type AuthQueryTransport,
  httpAuthQueryTransport,
} from '@/lib/transports/auth-query-transport';
import { type AuthTransport, httpAuthTransport } from '@/lib/transports/auth-transport';
import { EnterpriseHostsSection } from './EnterpriseHostsSection';
import { SettingsSectionHeader } from './SettingsSectionHeader';

type StatusState =
  | { phase: 'loading' }
  | { phase: 'loaded'; result: AuthQueryStatus }
  | { phase: 'check-failed' };

interface AccountSectionProps {
  authQueryTransport?: AuthQueryTransport;
  authTransport?: AuthTransport;
  userBinding: ConfigBinding;
}

export function AccountSection({
  authQueryTransport,
  authTransport,
  userBinding,
}: AccountSectionProps) {
  const { t } = useLingui();
  const resolvedQuery = authQueryTransport ?? httpAuthQueryTransport();
  const remote = useGitSyncStatus()?.remote ?? null;
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
      recordAuthStatus(result);
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
      className="space-y-5"
      data-testid="settings-account"
    >
      <SettingsSectionHeader
        titleId="settings-account-title"
        title={<Trans>Git</Trans>}
        scope="user"
      >
        <Trans>
          Manage the accounts and access tokens OpenKnowledge uses to connect to your git hosts.
        </Trans>
      </SettingsSectionHeader>

      <div className="space-y-8">
        {status.phase === 'loaded' && status.result.unsupportedOrigin !== undefined ? null : (
          <section
            aria-labelledby="settings-github-account-title"
            className="space-y-4"
            data-field="section:github-account"
          >
            <h4 id="settings-github-account-title" className="text-sm font-medium">
              <Trans>GitHub</Trans>
            </h4>
            <GitHubAccountStatus
              status={status}
              disconnecting={disconnecting}
              disconnectError={disconnectError}
              onRetry={() => void loadStatus()}
              onConnect={() => setAuthModalOpen(true)}
              onDisconnect={() => void handleDisconnect()}
            />
          </section>
        )}

        <EnterpriseHostsSection binding={userBinding} />

        <HostTokenForm authTransport={authTransport} remote={remote} />
      </div>

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

function GitHubAccountStatus({
  status,
  disconnecting,
  disconnectError,
  onRetry,
  onConnect,
  onDisconnect,
}: {
  status: StatusState;
  disconnecting: boolean;
  disconnectError: string | null;
  onRetry: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return status.phase === 'loading' ? (
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
    <div className="space-y-2 rounded-md border p-3" data-testid="settings-account-check-failed">
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>We couldn't check your GitHub connection.</Trans>
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  ) : status.result.authenticated ? (
    status.result.tier === 'A' ? (
      <GhCliRow login={status.result.login} host={status.result.host} />
    ) : (
      <ConnectedRow
        login={status.result.login}
        host={status.result.host}
        disconnecting={disconnecting}
        error={disconnectError}
        onDisconnect={onDisconnect}
      />
    )
  ) : (
    <DisconnectedRow onConnect={onConnect} />
  );
}

export function hostFromRemoteLabel(label: string): string {
  const candidate = label.split('/')[0] ?? '';
  return isGitCredentialHost(candidate) ? candidate : '';
}

function HostTokenSuccess({ login, host }: { login: string; host: string }) {
  return (
    <p
      role="status"
      className="text-1sm text-muted-foreground"
      data-testid="settings-account-host-token-success"
    >
      <Trans>
        Token stored for {login} on {host}. To remove it, run{' '}
        <code translate="no">ok auth signout --host {host}</code>.
      </Trans>
    </p>
  );
}

const PASSWORD_MANAGER_OPT_OUT = {
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': true,
  'data-form-type': 'other',
} as const;

function HostTokenForm({
  authTransport,
  remote,
}: {
  authTransport?: AuthTransport;
  remote: GitSyncStatus['remote'] | null;
}) {
  const { t } = useLingui();
  const resolvedAuth = authTransport ?? httpAuthTransport();
  const remoteLabel = remote?.label ?? null;
  const remoteIsGitHub = remote ? isGitHubRemote(remote) : false;
  const remoteTakesTokens = remoteTakesStoredToken(remote);
  const hostId = useId();
  const hostErrorId = useId();
  const usernameId = useId();
  const usernameHintId = useId();
  const tokenId = useId();
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostInvalid, setHostInvalid] = useState(false);
  const [success, setSuccess] = useState<{ login: string; host: string } | null>(null);
  const submittingRef = useRef(false);
  const hostPrefillLockedRef = useRef(false);

  useEffect(() => {
    if (hostPrefillLockedRef.current) return;
    if (remoteLabel === null || remoteIsGitHub || !remoteTakesTokens) return;
    const seeded = hostFromRemoteLabel(remoteLabel);
    if (!seeded) return;
    hostPrefillLockedRef.current = true;
    setHost(seeded);
  }, [remoteLabel, remoteIsGitHub, remoteTakesTokens]);

  async function handleSubmit() {
    if (submittingRef.current) return;
    const trimmedHost = host.trim();
    const trimmedUsername = username.trim();
    const trimmedToken = token.trim();
    if (!trimmedHost || !trimmedUsername || !trimmedToken) return;
    if (!isGitCredentialHost(trimmedHost)) {
      setSuccess(null);
      setHostInvalid(true);
      setError(
        t`Enter the host name git connects to, with an optional :port and no scheme or path, for example git.example.com.`,
      );
      return;
    }
    setHostInvalid(false);
    if (!resolvedAuth.hostToken) {
      setError(t`This window can't store a token — open Settings from the main app window.`);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    const result = await resolvedAuth
      .hostToken(trimmedHost, trimmedUsername, trimmedToken)
      .catch((err: unknown) => {
        console.warn('[AccountSection] storing a host token failed', err);
        return { ok: false as const, login: undefined, error: t`Connection error — try again` };
      });
    setSubmitting(false);
    submittingRef.current = false;
    if (result.ok) {
      setToken('');
      setSuccess({ login: result.login || trimmedUsername, host: trimmedHost });
    } else {
      setError(result.error ?? t`Failed to store the token — try again`);
    }
  }

  return (
    <section
      aria-labelledby="settings-host-tokens-title"
      className="space-y-4"
      data-field="section:host-tokens"
    >
      <div>
        <h4 id="settings-host-tokens-title" className="text-sm font-medium">
          <Trans>Other Git hosts</Trans>
        </h4>
        <p className="text-1sm text-muted-foreground">
          <Trans>
            Add an access token for a GitLab, Gitea, Bitbucket, Azure DevOps or self-hosted git
            server. Without one, git uses the credentials it already has saved for that host; with
            one, OpenKnowledge uses the token instead.
          </Trans>
        </p>
      </div>

      <form
        className="space-y-3 rounded-lg border bg-card p-3"
        data-testid="settings-account-host-token"
        aria-labelledby="settings-host-tokens-title"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        {remoteLabel !== null && !remoteIsGitHub && !remoteTakesTokens ? (
          <p
            className="text-1sm text-muted-foreground"
            data-testid="settings-account-host-token-not-https"
          >
            <Trans>
              A token added here only applies to HTTPS remotes, and this project's remote doesn't
              use HTTPS.
            </Trans>
          </p>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor={hostId}>
            <Trans>Host</Trans>
          </Label>
          <Input
            id={hostId}
            type="text"
            placeholder="git.example.com"
            autoComplete="off"
            {...PASSWORD_MANAGER_OPT_OUT}
            aria-invalid={hostInvalid || undefined}
            aria-describedby={hostInvalid && error ? hostErrorId : undefined}
            value={host}
            onChange={(e) => {
              hostPrefillLockedRef.current = true;
              setHost(e.target.value);
              if (hostInvalid) {
                setHostInvalid(false);
                setError(null);
              }
            }}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor={usernameId}>
            <Trans>Username</Trans>
          </Label>
          <Input
            id={usernameId}
            type="text"
            autoComplete="off"
            {...PASSWORD_MANAGER_OPT_OUT}
            aria-describedby={usernameHintId}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <p
            id={usernameHintId}
            className="text-1sm text-muted-foreground"
            data-testid="settings-account-host-token-username-hint"
          >
            <Trans>
              The username git sends with the token. Some hosts expect a fixed value: type{' '}
              <code translate="no">x-bitbucket-api-token-auth</code> for a Bitbucket API token,{' '}
              <code translate="no">x-token-auth</code> for a Bitbucket repository or workspace
              access token, or <code translate="no">oauth2</code> for GitLab. For Gitea, use your
              Gitea username. Azure DevOps accepts any value.
            </Trans>
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor={tokenId}>
            <Trans>Access token</Trans>
          </Label>
          <Input
            id={tokenId}
            type="password"
            autoComplete="off"
            {...PASSWORD_MANAGER_OPT_OUT}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>

        <Button
          type="submit"
          data-testid="settings-account-host-token-submit"
          disabled={submitting || !host.trim() || !username.trim() || !token.trim()}
        >
          {submitting ? <Trans>Adding</Trans> : <Trans>Add token</Trans>}
        </Button>

        {success ? <HostTokenSuccess login={success.login} host={success.host} /> : null}

        {error ? (
          <p
            id={hostInvalid ? hostErrorId : undefined}
            role="alert"
            className="text-sm text-destructive"
            data-testid="settings-account-host-token-error"
          >
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}

function ConnectedRow({
  login,
  host,
  disconnecting,
  error,
  onDisconnect,
}: {
  login: string;
  host: string;
  disconnecting: boolean;
  error: string | null;
  onDisconnect: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="settings-account-connected">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            <Trans>
              Connected to {host} as @{login}
            </Trans>
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

function GhCliRow({ login, host }: { login: string; host: string }) {
  return (
    <div className="rounded-md border p-3" data-testid="settings-account-gh-cli">
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium">
          <Trans>
            Connected to {host} as @{login}
          </Trans>
        </div>
        <p className="text-muted-foreground text-1sm">
          <Trans>
            Provided by the GitHub CLI (<code translate="no">gh</code>) on this computer. To switch
            accounts or sign out, run <code translate="no">gh auth</code> in a terminal.
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
            <Trans>Connect a GitHub account to browse and publish GitHub repositories.</Trans>
          </p>
        </div>
        <Button onClick={onConnect} data-testid="settings-account-connect">
          <Trans>Sign in</Trans>
        </Button>
      </div>
    </div>
  );
}
