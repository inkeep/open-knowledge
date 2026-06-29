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


async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
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
  identityPrompt?: boolean;
  reauth?: boolean;
  transport?: AuthTransport;
  queryTransport?: AuthQueryTransport;
}


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


type AuthStep = 'checking' | 'auth' | 'identity' | 'done';

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
  const resolvedTransport = transport ?? httpAuthTransport();
  const resolvedQueryTransport = queryTransport ?? httpAuthQueryTransport();
  const [step, setStep] = useState<AuthStep>('auth');
  const [authResult, setAuthResult] = useState<AuthSuccessResult | null>(null);

  const [idName, setIdName] = useState('');
  const [idEmail, setIdEmail] = useState('');

  useLayoutEffect(() => {
    if (!open) return;
    setAuthResult(null);
    setIdName('');
    setIdEmail('');
    setStep(identityPrompt ? 'checking' : 'auth');
  }, [open, identityPrompt]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: probe runs on open / identityPrompt change; resolvedQueryTransport is a fresh object each render and excluded intentionally
  useEffect(() => {
    if (!open || !identityPrompt) return;
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
        settle('auth');
      });
    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, [open, identityPrompt]);

  function handleAuthSuccess(result: AuthSuccessResult) {
    setAuthResult(result);
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
    void fetch('/api/local-op/auth/set-identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    }).catch(() => {
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
