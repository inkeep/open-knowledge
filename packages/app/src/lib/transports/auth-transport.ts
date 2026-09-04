import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { consumeAuthEventStream } from '@/components/auth-event-stream';
import type { OkDesktopBridge, OkLocalOpAuthEvent } from '@/lib/desktop-bridge-types';
import { httpAuthQueryTransport } from './auth-query-transport';
import { createBufferedAsyncStream } from './buffered-async-stream';

type AuthEvent = OkLocalOpAuthEvent;

type AuthStreamChannel = 'login' | 'gh-login';

const RECOVERY_POLL_INITIAL_MS = 2_000;
const RECOVERY_POLL_MAX_MS = 10_000;

export interface AuthTransportHandle {
  readonly events: AsyncIterable<AuthEvent>;
  cancel(): void;
}

interface PatResult {
  ok: boolean;
  login?: string;
  error?: string;
}

export interface AuthTransport {
  start(): AuthTransportHandle;
  pat?(host: string, token: string): Promise<PatResult>;
  ghLogin?(host: string): AuthTransportHandle;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function postAuthCancel(channel: AuthStreamChannel): void {
  void fetch('/api/local-op/auth/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
  }).catch((err: unknown) => {
    console.warn(
      '[auth-transport] Cancel request failed (best-effort):',
      err instanceof Error ? err.message : err,
    );
  });
}

async function recoverAfterStreamDrop(
  push: (event: AuthEvent) => void,
  signal: AbortSignal,
  codeExpiresAt: number,
  host: string | undefined,
): Promise<void> {
  const query = httpAuthQueryTransport();
  let interval = RECOVERY_POLL_INITIAL_MS;
  while (!signal.aborted && Date.now() < codeExpiresAt) {
    try {
      const status = await query.status(host ? { host } : undefined);
      if (signal.aborted) return;
      if (status.authenticated) {
        push({
          type: 'complete',
          host: status.host,
          login: status.login,
          name: status.name,
          email: status.email,
        });
        return;
      }
    } catch (err) {
      console.warn(
        '[auth-transport] Recovery probe failed:',
        err instanceof Error ? err.message : err,
      );
    }
    await delay(interval, signal);
    interval = Math.min(interval * 1.5, RECOVERY_POLL_MAX_MS);
  }
  if (signal.aborted) return;
  push({ type: 'error', message: t`Code expired — please try again` });
}

function streamAuthEndpoint(
  url: string,
  requestBody: { host?: string; json: true },
  channel: AuthStreamChannel,
): AuthTransportHandle {
  let settled = false;

  const stream = createBufferedAsyncStream<AuthEvent>((rawPush, signal) => {
    const push = (event: AuthEvent): void => {
      if (event.type === 'complete' || event.type === 'error') settled = true;
      rawPush(event);
    };
    void (async () => {
      let codeExpiresAt: number | null = null;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal,
        });
        if (!res.ok) {
          let message = t`Failed to start sign-in — try again`;
          try {
            const result = ProblemDetailsSchema.safeParse((await res.json()) as unknown);
            if (result.success) message = result.data.title;
          } catch {}
          push({ type: 'error', message });
          return;
        }
        if (!res.body) {
          push({ type: 'error', message: t`Failed to start sign-in — try again` });
          return;
        }
        const terminatedByEvent = await consumeAuthEventStream(
          res.body,
          (line): 'terminal' | 'continue' => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              console.warn('[auth-transport] Dropped unparseable NDJSON line:', line.slice(0, 100));
              return 'continue';
            }
            if (
              parsed &&
              typeof parsed === 'object' &&
              (parsed as { type?: unknown }).type === 'error' &&
              'problem' in parsed
            ) {
              const p = (parsed as { problem: { title?: string; detail?: string } }).problem;
              push({ type: 'error', message: p?.detail || p?.title || t`Unknown error` });
              return 'terminal';
            }
            if ((parsed as { type?: unknown }).type === 'ping') return 'continue';
            const event = parsed as AuthEvent;
            if (event.type === 'verification') {
              codeExpiresAt = Date.now() + event.expires_in * 1000;
            }
            push(event);
            if (event.type === 'complete' || event.type === 'error') return 'terminal';
            return 'continue';
          },
        );
        if (terminatedByEvent || signal.aborted) return;
        if (codeExpiresAt === null) {
          push({
            type: 'error',
            message: t`Sign-in stream ended without confirmation — please try again`,
          });
          return;
        }
        await recoverAfterStreamDrop(push, signal, codeExpiresAt, requestBody.host);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (codeExpiresAt !== null) {
          await recoverAfterStreamDrop(push, signal, codeExpiresAt, requestBody.host);
          return;
        }
        push({ type: 'error', message: t`Connection error — try again` });
      }
    })();
  });

  return {
    events: stream.events,
    cancel: (): void => {
      if (!settled) postAuthCancel(channel);
      stream.cancel();
    },
  };
}

export function httpAuthTransport(): AuthTransport {
  return {
    start(): AuthTransportHandle {
      return streamAuthEndpoint('/api/local-op/auth/login', { json: true }, 'login');
    },
    ghLogin(host: string): AuthTransportHandle {
      return streamAuthEndpoint('/api/local-op/auth/gh-login', { host, json: true }, 'gh-login');
    },
    async pat(host: string, token: string): Promise<PatResult> {
      try {
        const res = await fetch('/api/local-op/auth/pat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host, token }),
        });
        if (res.ok) {
          const body = (await res.json()) as { login?: unknown };
          return { ok: true, login: typeof body.login === 'string' ? body.login : '' };
        }
        let error = t`Failed to store the token — try again`;
        try {
          const result = ProblemDetailsSchema.safeParse(await res.json());
          if (result.success) error = result.data.detail || result.data.title;
        } catch {}
        return { ok: false, error };
      } catch {
        return { ok: false, error: t`Connection error — try again` };
      }
    },
  };
}

export function ipcAuthTransport(bridge: OkDesktopBridge): AuthTransport {
  return {
    start(): AuthTransportHandle {
      return bridge.localOp.auth.start();
    },
  };
}
