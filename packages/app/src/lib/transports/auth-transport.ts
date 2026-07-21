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
import { consumeAuthEventStream } from '@/components/auth-event-stream';
import type { OkDesktopBridge, OkLocalOpAuthEvent } from '@/lib/desktop-bridge-types';
import { createBufferedAsyncStream } from './buffered-async-stream';

/**
 * Auth event shape — both transports emit the same union, so we re-use the
 * bridge type as the canonical source. Server-side definition lives at
 * `packages/server/src/local-ops/types.ts` and is mirrored into the bridge
 * triplet (core / desktop / app), drift-caught at compile time.
 */
type AuthEvent = OkLocalOpAuthEvent;

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

/**
 * Shared streaming client for the two device-flow endpoints (`auth/login` and
 * `auth/gh-login`). Both stream the same NDJSON AuthEvent shape; only the URL +
 * body differ, so the reader/parser lives here once.
 */
function streamAuthEndpoint(url: string, requestBody: unknown): AuthTransportHandle {
  return createBufferedAsyncStream<AuthEvent>((push, signal) => {
    void (async () => {
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
          let message = 'Failed to start sign-in — try again';
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
          push({ type: 'error', message: 'Failed to start sign-in — try again' });
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
              push({ type: 'error', message: p?.detail || p?.title || 'Unknown error' });
              return 'terminal';
            }
            const event = parsed as AuthEvent;
            push(event);
            if (event.type === 'complete' || event.type === 'error') return 'terminal';
            return 'continue';
          },
        );
        if (!terminatedByEvent && !signal.aborted) {
          push({
            type: 'error',
            message: 'Sign-in stream ended without confirmation — please try again',
          });
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        push({ type: 'error', message: 'Connection error — try again' });
      }
    })();
  });
}

/**
 * HTTP transport — the device flow (`start`) and gh sign-in (`ghLogin`) both
 * stream via `streamAuthEndpoint`; `pat` is the one-shot token path.
 */
export function httpAuthTransport(): AuthTransport {
  return {
    start(): AuthTransportHandle {
      return streamAuthEndpoint('/api/local-op/auth/login', { json: true });
    },
    ghLogin(host: string): AuthTransportHandle {
      return streamAuthEndpoint('/api/local-op/auth/gh-login', { host, json: true });
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
        let error = 'Failed to store the token — try again';
        try {
          const result = ProblemDetailsSchema.safeParse(await res.json());
          if (result.success) error = result.data.detail || result.data.title;
        } catch {
          /* keep generic message */
        }
        return { ok: false, error };
      } catch {
        return { ok: false, error: 'Connection error — try again' };
      }
    },
  };
}

/**
 * IPC transport — wraps `bridge.localOp.auth.start()`. The bridge stream's
 * event type IS this transport's event type, so no adaptation is needed.
 */
export function ipcAuthTransport(bridge: OkDesktopBridge): AuthTransport {
  return {
    start(): AuthTransportHandle {
      return bridge.localOp.auth.start();
    },
  };
}
