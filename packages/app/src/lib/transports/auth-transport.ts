/**
 * Transport abstraction for the GitHub device-flow auth UI.
 *
 * Two implementations:
 *   - `httpAuthTransport` — wraps `fetch('/api/local-op/auth/login')` +
 *     `consumeAuthEventStream` (the existing path). Default for editor
 *     windows + web distribution.
 *   - `ipcAuthTransport` — wraps `bridge.localOp.auth.start()`. Used by
 *     the Project Navigator window where there is no backing API server
 *     (apiOrigin is empty).
 *
 * The `AuthModal` component accepts a `transport` prop; the default is
 * the HTTP transport so existing editor callers don't change. Navigator
 * passes the IPC transport explicitly.
 */

import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { consumeAuthEventStream } from '@/components/auth-event-stream';
import type { OkDesktopBridge, OkLocalOpAuthEvent } from '@/lib/desktop-bridge-types';
import { httpAuthQueryTransport } from './auth-query-transport';
import { createBufferedAsyncStream } from './buffered-async-stream';

/**
 * Auth event shape — both transports emit the same union, so we re-use the
 * bridge type as the canonical source. Server-side definition lives at
 * `packages/server/src/local-ops/types.ts` and is mirrored into the bridge
 * triplet (core / desktop / app), drift-caught at compile time.
 */
type AuthEvent = OkLocalOpAuthEvent;

/**
 * Which streaming flow a handle is driving. The server holds one concurrency
 * slot per flow, so an explicit cancel has to name the one it means.
 */
type AuthStreamChannel = 'login' | 'gh-login';

/**
 * Poll cadence while recovering a sign-in whose event stream dropped, backing
 * off from the first value to the second. Each poll spawns an `auth status`
 * subprocess server-side, so a fixed tight interval would cost ~300 spawns
 * across a code's full 15-minute life. Backing off keeps that under ~100 while
 * still closing the modal within ~10s of the user authorizing — and the early
 * polls, when the user is most likely to be finishing up, stay fast.
 */
const RECOVERY_POLL_INITIAL_MS = 2_000;
const RECOVERY_POLL_MAX_MS = 10_000;

export interface AuthTransportHandle {
  /** Async iterable of events. Iteration ends after `complete` / `error` / `cancel()`. */
  readonly events: AsyncIterable<AuthEvent>;
  /** Cancel the in-flight flow. Idempotent. */
  cancel(): void;
}

/** Result of a one-shot Personal Access Token sign-in. */
interface PatResult {
  ok: boolean;
  /** The authenticated login on success. */
  login?: string;
  /** A bounded, user-facing failure reason (bad token / cert / network). */
  error?: string;
}

export interface AuthTransport {
  /** Start a new device-flow login. */
  start(): AuthTransportHandle;
  /**
   * One-shot Personal Access Token sign-in for enterprise (non-github.com)
   * hosts, where the OAuth device flow can't work (OpenKnowledge's OAuth app
   * isn't registered on arbitrary GHES servers). Optional — the HTTP path (the
   * Account settings panel, where GHES connect happens) implements it.
   */
  pat?(host: string, token: string): Promise<PatResult>;
  /**
   * "Sign in with gh" — a browser device flow driven by the gh CLI, for
   * enterprise hosts where gh's OAuth app works but OpenKnowledge's doesn't.
   * Same event stream as `start()`. Optional — only the HTTP path implements it,
   * and it's only offered when the server reports gh is installed (`ghAvailable`).
   */
  ghLogin?(host: string): AuthTransportHandle;
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
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

/**
 * Tell the server the user backed out. The server deliberately keeps a flow
 * alive across a transport drop (a severed loopback stream is not intent), so
 * closing the modal has to say so explicitly or the device-flow child would
 * keep polling and could land a token nobody is waiting for. Best-effort: the
 * flow's own timeout and the fresh-start displacement both bound it anyway.
 */
function postAuthCancel(channel: AuthStreamChannel): void {
  void fetch('/api/local-op/auth/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
  }).catch((err: unknown) => {
    // Best-effort — the flow's own timeout and fresh-start displacement are the
    // backstops. Still worth surfacing: a cancel that never lands leaves a
    // device-flow child running for up to 16 minutes, and the environments this
    // fix targets are exactly the ones where a loopback POST might not make it.
    console.warn(
      '[auth-transport] Cancel request failed (best-effort):',
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * The event stream ended before the flow reached a terminal event.
 *
 * That is the #803 failure: on Windows the idle loopback stream gets severed by
 * an intermediary (AV/EDR inspection, VPN proxy, tab-backgrounding) while the
 * device code is still perfectly valid. The server keeps the flow running
 * across the drop, so the authorization the user is finishing on github.com can
 * still land — poll the status relay until it does, or until the code the user
 * is looking at expires.
 *
 * Caveat worth knowing: on the re-authenticate path, a still-valid existing
 * token makes the first poll report `authenticated` immediately, so recovery
 * can conclude "connected" from the old credential rather than the new grant.
 * `auth status` validates live against GitHub, so a revoked or expired token
 * still reads as unauthenticated — the residue is a user re-authing purely to
 * widen scopes, who is told they are connected (which they are) a grant early.
 */
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
      // Keep polling — a probe failure is usually transient. Surface it though:
      // otherwise a recovery that was broken the whole time is indistinguishable
      // from a user who simply never authorized, since both end at the same
      // expiry error 15 minutes later. Matches the bounded-warn pattern the
      // NDJSON line-drop above uses.
      console.warn(
        '[auth-transport] Recovery probe failed:',
        err instanceof Error ? err.message : err,
      );
    }
    await delay(interval, signal);
    interval = Math.min(interval * 1.5, RECOVERY_POLL_MAX_MS);
  }
  if (signal.aborted) return;
  // Same deadline the modal's countdown reached, so the two agree.
  push({ type: 'error', message: t`Code expired — please try again` });
}

/**
 * Shared streaming client for the two device-flow endpoints (`auth/login` and
 * `auth/gh-login`). Both stream the same NDJSON AuthEvent shape; only the URL +
 * body differ, so the reader/parser lives here once.
 */
function streamAuthEndpoint(
  url: string,
  requestBody: { host?: string; json: true },
  channel: AuthStreamChannel,
): AuthTransportHandle {
  // Latches once a terminal event is pushed, so `cancel()` can tell "the user
  // backed out of a live flow" (tell the server) from "the flow already
  // finished and the component is unmounting" (nothing to cancel).
  let settled = false;

  const stream = createBufferedAsyncStream<AuthEvent>((rawPush, signal) => {
    const push = (event: AuthEvent): void => {
      if (event.type === 'complete' || event.type === 'error') settled = true;
      rawPush(event);
    };
    void (async () => {
      // Set once the device code is on screen. Its presence is what makes a
      // dropped stream recoverable: before it there is no flow to rejoin, and
      // after it we know exactly how long the code stays good.
      let codeExpiresAt: number | null = null;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal,
        });
        if (!res.ok) {
          // Pre-stream RFC 9457 problem+json: the server emitted an error before
          // committing to the NDJSON stream. Surface the typed `title`.
          let message = t`Failed to start sign-in — try again`;
          try {
            const result = ProblemDetailsSchema.safeParse((await res.json()) as unknown);
            if (result.success) message = result.data.title;
          } catch {
            /* keep generic message */
          }
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
            // Narrow try/catch to JSON.parse only — event-processing errors
            // propagate instead of being swallowed with malformed JSON lines.
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              // A stream of malformed lines would otherwise hang silently until
              // completion. Surface the drop (bounded) for DevTools visibility.
              console.warn('[auth-transport] Dropped unparseable NDJSON line:', line.slice(0, 100));
              return 'continue';
            }
            // Server wraps mid-stream errors as `{type:'error', problem}`; the
            // consumer union expects `{type:'error', message}`. Bridge here.
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
            // Idle keepalive from `streamAuthFlow` — carries no meaning, exists
            // only so the connection never sits at zero bytes long enough for a
            // reaper to close it. Not an AuthEvent; never terminal.
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
          // The stream died before a code was ever issued: nothing is in flight
          // to rejoin, so there is nothing to recover.
          push({
            type: 'error',
            message: t`Sign-in stream ended without confirmation — please try again`,
          });
          return;
        }
        await recoverAfterStreamDrop(push, signal, codeExpiresAt, requestBody.host);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        // A severed connection usually lands here rather than as a clean end,
        // so this is the primary #803 recovery entry point, not the tidy one.
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

/**
 * HTTP transport — the device flow (`start`) and gh sign-in (`ghLogin`) both
 * stream via `streamAuthEndpoint`; `pat` is the one-shot token path.
 */
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
        // The relay returns RFC 9457 problem+json on a rejected token / TLS /
        // network error; surface the bounded `detail` (the CLI's real reason).
        let error = t`Failed to store the token — try again`;
        try {
          const result = ProblemDetailsSchema.safeParse(await res.json());
          if (result.success) error = result.data.detail || result.data.title;
        } catch {
          /* keep generic message */
        }
        return { ok: false, error };
      } catch {
        return { ok: false, error: t`Connection error — try again` };
      }
    },
  };
}

/**
 * IPC transport — wraps `bridge.localOp.auth.start()`. The bridge stream's
 * event type IS this transport's event type, so no adaptation is needed.
 *
 * No stream-drop recovery here, and none needed: the IPC channel is in-process,
 * so there is no idle connection for an intermediary to sever, and the main
 * process already keeps the flow alive when a renderer goes away — only an
 * explicit `:cancel` stops it. That is the lifetime model `streamAuthFlow` now
 * matches on the HTTP side.
 */
export function ipcAuthTransport(bridge: OkDesktopBridge): AuthTransport {
  return {
    start(): AuthTransportHandle {
      return bridge.localOp.auth.start();
    },
  };
}
