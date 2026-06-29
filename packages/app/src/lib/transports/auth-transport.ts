import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { consumeAuthEventStream } from '@/components/auth-event-stream';
import type { OkDesktopBridge, OkLocalOpAuthEvent } from '@/lib/desktop-bridge-types';
import { createBufferedAsyncStream } from './buffered-async-stream';

type AuthEvent = OkLocalOpAuthEvent;

interface AuthTransportHandle {
  readonly events: AsyncIterable<AuthEvent>;
  cancel(): void;
}

export interface AuthTransport {
  start(): AuthTransportHandle;
}

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
              let message = 'Failed to start sign-in — try again';
              try {
                const body = (await res.json()) as unknown;
                const result = ProblemDetailsSchema.safeParse(body);
                if (result.success) message = result.data.title;
              } catch {}
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
                let parsed: unknown;
                try {
                  parsed = JSON.parse(line);
                } catch {
                  console.warn(
                    '[auth-transport] Dropped unparseable NDJSON line:',
                    line.slice(0, 100),
                  );
                  return 'continue'; // malformed JSON line
                }
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

export function ipcAuthTransport(bridge: OkDesktopBridge): AuthTransport {
  return {
    start(): AuthTransportHandle {
      return bridge.localOp.auth.start();
    },
  };
}
