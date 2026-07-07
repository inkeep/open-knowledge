/**
 * AuthModal — GitHub sign-in dialog.
 *
 * Device Flow: shows user_code, polls for completion, 2-minute timeout.
 * Calls POST /api/local-op/auth/login (streaming JSONL).
 *
 * Variant props:
 *   identityPrompt — when true, this is the "set git identity" entry point (the
 *                    sync popover's "Set identity" nudge). An already-signed-in
 *                    user is taken straight to the Name + Email step — the device
 *                    flow is skipped unless the on-open status probe reports the
 *                    user is NOT authenticated (then it falls back to sign-in,
 *                    showing the identity fields after success). Setting git
 *                    identity does not require re-authenticating.
 *   reauth        — when true, shows "Re-authenticate" heading instead of "Connect".
 *
 * On success: calls onSuccess({ login, name, avatarUrl }) and closes.
 *
 * Layout note: this dialog follows the sibling header/body/footer shape
 * (PublishToGitHubDialog, CloneDialog, CreateProjectDialog) — action buttons
 * live in <DialogFooter>, which must be a direct sibling of <DialogBody> under
 * <DialogContent> (the footer's `-mx-6 -mb-6` breakout assumes that position).
 * The identity field state is therefore lifted to this component so the
 * footer buttons can read it; the body panels below are presentational.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import {
  type AuthQueryTransport,
  httpAuthQueryTransport,
} from '@/lib/transports/auth-query-transport';
import { type AuthTransport, httpAuthTransport } from '@/lib/transports/auth-transport';
import { Button } from './ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';

// ── helpers ───────────────────────────────────────────────────────────────────

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore — clipboard not available */
  }
}

interface AuthSuccessResult {
  login: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

interface AuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (result: AuthSuccessResult) => void;
  /** Show git identity fields (Name + Email) after sign-in. */
  identityPrompt?: boolean;
  /** Show "Re-authenticate" heading. */
  reauth?: boolean;
  /**
   * Transport for the device-flow subprocess. Defaults to the HTTP path
   * (POST /api/local-op/auth/login) so existing editor / web callers
   * don't change. The Project Navigator passes an IPC transport because
   * its window has no backing API server.
   */
  transport?: AuthTransport;
  /**
   * Transport for the on-open auth-status probe used by the `identityPrompt`
   * path to decide whether to skip the device flow. Defaults to the HTTP
   * path (POST /api/local-op/auth/status). Injectable for tests.
   */
  queryTransport?: AuthQueryTransport;
}

// ── Device Flow panel ─────────────────────────────────────────────────────────

interface DeviceFlowPanelProps {
  onSuccess: (result: AuthSuccessResult) => void;
  transport: AuthTransport;
}

const DEVICE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

function DeviceFlowPanel({ onSuccess, transport }: DeviceFlowPanelProps) {
  const { t } = useLingui();
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState('https://github.com/login/device');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState(DEVICE_TIMEOUT_MS);
  const cancelRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function startDeviceFlow() {
    setError(null);
    try {
      const handle = transport.start();
      cancelRef.current = handle.cancel;
      // Manual iterator drive — React Compiler (BuildHIR) does not yet
      // support `for await ... of` lowering, so we walk the iterator with
      // explicit `next()` calls instead.
      const iter = handle.events[Symbol.asyncIterator]();
      let sawTerminal = false;
      let result = await iter.next();
      while (!result.done) {
        const event = result.value;
        if (event.type === 'verification') {
          setUserCode(event.user_code);
          setVerificationUri(event.verification_uri);
          setTimeLeft(event.expires_in * 1000);
          void copyToClipboard(event.user_code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        } else if (event.type === 'complete') {
          sawTerminal = true;
          onSuccess({
            login: event.login,
            name: event.name,
            email: event.email,
            avatarUrl: event.avatarUrl,
          });
          break;
        } else if (event.type === 'error') {
          sawTerminal = true;
          setError(event.message);
          break;
        }
        result = await iter.next();
      }
      if (!sawTerminal) {
        setError(t`Sign-in stream ended without confirmation — please try again`);
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(t`Connection error — try again`);
      }
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: start device flow once on mount
  useEffect(() => {
    // Defer the start by one microtask so React StrictMode's dev-mode
    // mount→cleanup→remount cycle coalesces into a single start. The IPC
    // main side is now idempotent (a second `:start` atomically displaces
    // the stale slot rather than rejecting), but spawning a throwaway
    // device-flow subprocess on every Strict double-mount still burns a
    // device code with GitHub and emits a spurious displacement warn.
    // The microtask defer lets the first mount's cleanup set
    // `cancelled = true` before its start ever fires, leaving only the
    // second mount's start to run.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void startDeviceFlow();
    });
    return () => {
      cancelled = true;
      cancelRef.current?.();
      cancelRef.current = null;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Countdown timer
  useEffect(() => {
    if (!userCode) return;
    const start = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = DEVICE_TIMEOUT_MS - elapsed;
      if (remaining <= 0) {
        setTimeLeft(0);
        if (timerRef.current) clearInterval(timerRef.current);
        setError(t`Code expired — please try again`);
      } else {
        setTimeLeft(remaining);
      }
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [userCode, t]);

  const minutesLeft = Math.floor(timeLeft / 60_000);
  const secondsLeft = Math.floor((timeLeft % 60_000) / 1000);
  const timeLabel = `${minutesLeft}:${secondsLeft.toString().padStart(2, '0')}`;

  return (
    <div className="flex flex-col gap-4">
      {userCode ? (
        <>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Open{' '}
              <a
                href={verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => dispatchExternalLinkClick(e, verificationUri)}
                onAuxClick={(e) => dispatchExternalLinkClick(e, verificationUri)}
                className="inline-flex items-center gap-0.5 text-foreground hover:text-primary hover:underline"
              >
                <span>{verificationUri}</span>
                <ArrowUpRight className="inline size-3.5" aria-hidden />
              </a>{' '}
              and enter this code:
            </Trans>
          </p>
          <Button
            type="button"
            variant="outline"
            // Whole box is the copy target; the icon swaps in place (no width
            // change) so nothing shifts between the copy and copied states.
            // Static label names the action + code; success is announced via the
            // sibling live region below (a changing aria-label is not announced).
            aria-label={t`Copy code ${userCode}`}
            onClick={() =>
              void copyToClipboard(userCode).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
            className="relative h-auto w-full justify-center rounded-md bg-muted px-12 py-3 hover:bg-muted/80"
          >
            <code className="font-mono text-2xl font-bold tracking-widest">{userCode}</code>
            <span className="absolute right-3 text-muted-foreground" aria-hidden="true">
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </span>
          </Button>
          <span role="status" aria-live="polite" className="sr-only">
            {copied ? <Trans>Code copied to clipboard</Trans> : null}
          </span>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
              <Trans>Waiting for authorization</Trans>
            </span>
            <span>
              <Trans>Expires in {timeLabel}</Trans>
            </span>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
          {error ? null : <Trans>Starting sign-in flow</Trans>}
        </div>
      )}
      {error && <p className="text-1sm text-destructive">{error}</p>}
    </div>
  );
}

// ── Identity body ─────────────────────────────────────────────────────────────
// Presentational — shows who connected plus the Name + Email fields. The
// "Save" / "Skip" buttons live in the dialog footer.

interface IdentityBodyProps {
  login: string;
  name: string;
  onNameChange: (value: string) => void;
  email: string;
  onEmailChange: (value: string) => void;
}

function IdentityBody({ login, name, onNameChange, email, onEmailChange }: IdentityBodyProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">
        <Trans>Connected as @{login}</Trans>
      </p>
      <p className="text-1sm text-muted-foreground">
        <Trans>Before syncing, set your identity for git commits:</Trans>
      </p>
      <Input
        aria-label={t`Name`}
        placeholder={t`Name (e.g. ${login})`}
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
      />
      <Input
        type="email"
        aria-label={t`Email`}
        placeholder={t`Email`}
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
      />
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

// `checking` is the brief on-open auth-status probe for the identityPrompt
// path (deciding skip-to-identity vs fall-back-to-device-flow).
type AuthStep = 'checking' | 'auth' | 'identity' | 'done';

// Upper bound on the on-open status probe. The relay is localhost and answers
// near-instantly when healthy, but the HTTP transport's `fetch` has no timeout
// of its own — a hung relay would otherwise leave the user on the checking
// spinner indefinitely. On expiry we fall back to the device flow (which has a
// Cancel), the same terminal state as a rejected probe.
const IDENTITY_PROBE_TIMEOUT_MS = 10_000;

export function AuthModal({
  open,
  onOpenChange,
  onSuccess,
  identityPrompt,
  reauth,
  transport,
  queryTransport,
}: AuthModalProps) {
  const { t } = useLingui();
  // Default to the HTTP path so existing editor / web callers don't need
  // to change. Navigator passes its IPC transport explicitly.
  const resolvedTransport = transport ?? httpAuthTransport();
  const resolvedQueryTransport = queryTransport ?? httpAuthQueryTransport();
  const [step, setStep] = useState<AuthStep>('auth');
  const [authResult, setAuthResult] = useState<AuthSuccessResult | null>(null);

  // Identity-step field state, lifted so the footer "Save" button can read it.
  const [idName, setIdName] = useState('');
  const [idEmail, setIdEmail] = useState('');

  // Synchronous step decision in a layout effect so it commits BEFORE the
  // browser paints. In a passive effect the first painted frame would show the
  // stale `step` (often 'auth', since this modal stays mounted and `step`
  // persists across open/close), briefly flashing the device-flow panel on the
  // set-identity path before the probe decision lands.
  useLayoutEffect(() => {
    if (!open) return;
    setAuthResult(null);
    setIdName('');
    setIdEmail('');
    // Sign-in path: device flow as before. Set-identity path: show the probe
    // spinner; the async effect below resolves it to 'identity' or 'auth'.
    setStep(identityPrompt ? 'checking' : 'auth');
  }, [open, identityPrompt]);

  // Set-identity path only: probe auth status to decide skip-to-identity vs
  // fall-back-to-device-flow. The user reached this from the "git identity
  // isn't set" nudge and is almost always already signed in — setting git
  // user.name/user.email needs no re-auth. If authenticated, jump straight to
  // the identity fields (pre-filled from the OAuth profile); otherwise fall
  // back to the device flow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: probe runs on open / identityPrompt change; resolvedQueryTransport is a fresh object each render and excluded intentionally
  useEffect(() => {
    if (!open || !identityPrompt) return;
    // `settled` latches the first terminal transition. The probe result, the
    // timeout, and cleanup all race; first writer wins, later ones no-op. This
    // also stops a slow-but-eventually-resolving probe from yanking the user
    // off the device flow after the timeout already fell back to it.
    let settled = false;
    const settle = (next: AuthStep) => {
      if (settled) return;
      settled = true;
      setStep(next);
    };
    const timer = setTimeout(() => settle('auth'), IDENTITY_PROBE_TIMEOUT_MS);
    void resolvedQueryTransport
      .status()
      .then((status) => {
        if (settled) return;
        if (status.authenticated) {
          setAuthResult({
            login: status.login,
            name: status.name,
            email: status.email,
          });
          setIdName(status.name ?? '');
          setIdEmail(status.email ?? '');
          settle('identity');
        } else {
          settle('auth');
        }
      })
      .catch(() => {
        // Probe failed (offline, server hiccup) — fall back to the device flow
        // rather than stranding the user on a spinner.
        settle('auth');
      });
    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, [open, identityPrompt]);

  function handleAuthSuccess(result: AuthSuccessResult) {
    setAuthResult(result);
    // identityPrompt = the set-identity entry point. Reaching device-flow
    // success here means the on-open probe found the user unauthenticated and
    // fell back to sign-in; now land on the identity fields (pre-filled from
    // the OAuth profile) so the original intent — writing git user.name/email —
    // is actually carried out instead of closing the moment a token exists.
    if (identityPrompt) {
      setIdName(result.name ?? '');
      setIdEmail(result.email ?? '');
      setStep('identity');
    } else {
      setStep('done');
      onSuccess?.(result);
      onOpenChange(false);
      const login = result.login;
      toast.success(t`Connected as @${login}`);
    }
  }

  function handleIdentitySave(name: string, email: string) {
    // Persist git identity via the correct endpoint (best-effort).
    // /api/local-op/auth/set-identity writes to the active checkout's git
    // config (per-worktree on a linked worktree, repo-local otherwise) and
    // nudges the sync engine to re-probe so the unresolved-identity UI
    // banner clears on the next push cycle.
    void fetch('/api/local-op/auth/set-identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    }).catch(() => {
      /* ignore */
    });

    const result = { ...(authResult ?? { login: '' }), name, email };
    setStep('done');
    onSuccess?.(result);
    onOpenChange(false);
    const login = result.login;
    toast.success(t`Connected as @${login}`);
  }

  function handleIdentitySkip() {
    if (!authResult) return;
    setStep('done');
    onSuccess?.(authResult);
    onOpenChange(false);
    const login = authResult.login;
    toast.success(t`Connected as @${login}`);
  }

  function handleCancel() {
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {reauth ? (
              <Trans>Re-authenticate with GitHub</Trans>
            ) : identityPrompt && step !== 'auth' ? (
              // identityPrompt + non-`auth` step = the set-identity path with a
              // signed-in user; `auth` means the probe fell back to sign-in.
              <Trans>Set git identity</Trans>
            ) : (
              <Trans>Connect GitHub</Trans>
            )}
          </DialogTitle>
        </DialogHeader>

        {step === 'checking' && (
          <DialogBody>
            <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
              <Trans>Checking sign-in status</Trans>
            </div>
          </DialogBody>
        )}

        {step === 'auth' && (
          <>
            <DialogBody>
              <DeviceFlowPanel onSuccess={handleAuthSuccess} transport={resolvedTransport} />
            </DialogBody>

            <DialogFooter>
              <Button variant="outline" className="font-mono uppercase" onClick={handleCancel}>
                <Trans>Cancel</Trans>
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'identity' && authResult && (
          <>
            <DialogBody>
              <IdentityBody
                login={authResult.login}
                name={idName}
                onNameChange={setIdName}
                email={idEmail}
                onEmailChange={setIdEmail}
              />
            </DialogBody>

            <DialogFooter>
              <Button variant="ghost" onClick={handleIdentitySkip}>
                <Trans>Skip</Trans>
              </Button>
              <Button
                onClick={() => handleIdentitySave(idName.trim(), idEmail.trim())}
                disabled={!idName.trim() || !idEmail.trim()}
              >
                <Trans>Save</Trans>
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
