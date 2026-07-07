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

interface AuthTransportHandle {
  /** Async iterable of events. Iteration ends after `complete` / `error` / `cancel()`. */
  readonly events: AsyncIterable<AuthEvent>;
  /** Cancel the in-flight flow. Idempotent. */
  cancel(): void;
}

export interface AuthTransport {
  /** Start a new device-flow login. */
  start(): AuthTransportHandle;
}

/**
 * HTTP transport — wraps `fetch('/api/local-op/auth/login')` and the
 * existing NDJSON line reader. Identical wire shape to the editor-window
 * path; safe to swap in here.
 */
export function httpAuthTransport(): AuthTransport {
  return {
    start(): AuthTransportHandle {
      return createBufferedAsyncStream<AuthEvent>((push, signal) => {
        void (async () => {
          try {
            const res = await fetch('/api/local-op/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ json: true }),
              signal,
            });
            if (!res.ok) {
              // Pre-stream RFC 9457 problem+json: the server emitted an error
              // before committing to the NDJSON stream. Surface the typed
              // `title` so the user sees the actual reason instead of a
              // generic message.
              let message = 'Failed to start sign-in — try again';
              try {
                const body = (await res.json()) as unknown;
                const result = ProblemDetailsSchema.safeParse(body);
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
                // Narrow try/catch to JSON.parse only — event-processing
                // errors (e.g. push() throwing) propagate instead of being
                // silently swallowed alongside malformed JSON lines.
                let parsed: unknown;
                try {
                  parsed = JSON.parse(line);
                } catch {
                  // A corrupted stream of malformed JSON lines would otherwise
                  // appear to hang silently until completion. Surface the drop
                  // at warn level for DevTools / observability visibility, and
                  // bound the slice so a giant garbled line doesn't dump the
                  // entire payload into the console. Mirrors clone-transport.
                  console.warn(
                    '[auth-transport] Dropped unparseable NDJSON line:',
                    line.slice(0, 100),
                  );
                  return 'continue'; // malformed JSON line
                }
                // Server wraps mid-stream errors in `StreamingProblemEvent`
                // shape (`{type:'error', problem: ProblemDetails}`). The
                // `AuthEvent` consumer union expects `{type:'error',
                // message: string}`. Bridge at the transport boundary so
                // consumers stay simple.
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
