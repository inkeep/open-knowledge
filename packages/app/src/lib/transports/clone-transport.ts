/**
 * Transport abstraction for the git-clone UI.
 *
 * Two implementations:
 *   - `httpCloneTransport` — wraps `fetch('/api/local-op/clone')` (the
 *     existing path). The HTTP relay chains clone → server-start →
 *     emits `{type:'complete', port, dir}`. Default for editor windows
 *     and web distribution.
 *   - `ipcCloneTransport` — wraps `bridge.localOp.clone.start()`. The
 *     IPC path emits `{type:'complete', dir}` (no port — Electron main
 *     spawns a new editor window directly at `dir`).
 */

import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import type { OkDesktopBridge, OkLocalOpCloneEvent } from '@/lib/desktop-bridge-types';
import { createBufferedAsyncStream } from './buffered-async-stream';

/**
 * HTTP-relay-only complete variant. The relay intercepts the CLI's
 * `{type:'complete', dir}` (= `OkLocalOpCloneEvent` complete) and chains
 * `startServerAtDirAndGetPort` to add `port` before forwarding. IPC has
 * no port — Electron main spawns a new editor window directly at `dir`.
 */
type HttpCloneCompleteEvent = { type: 'complete'; port: number; dir: string };

/**
 * Emitted by the CLI when a requested `-b <branch>` falls back to the
 * remote default branch. Non-terminal — the clone keeps going and emits
 * `complete` afterwards.
 */
type CloneBranchFallbackEvent = { type: 'branch-fallback'; branch: string };

/**
 * Union spans both transports' shapes. IPC half is the canonical bridge
 * type — drift-caught at compile time. HTTP half adds `port`. Both
 * `complete` variants carry `dir: string`, so consumers always have it.
 */
type CloneEvent = OkLocalOpCloneEvent | HttpCloneCompleteEvent | CloneBranchFallbackEvent;

interface CloneTransportHandle {
  readonly events: AsyncIterable<CloneEvent>;
  cancel(): void;
}

export interface CloneTransport {
  start(request: { url: string; dir: string; branch?: string | null }): CloneTransportHandle;
}

/**
 * HTTP transport — wraps the existing fetch('/api/local-op/clone') NDJSON
 * stream reader.
 */
export function httpCloneTransport(): CloneTransport {
  return {
    start(request): CloneTransportHandle {
      return createBufferedAsyncStream<CloneEvent>((push, signal) => {
        void (async () => {
          try {
            const res = await fetch('/api/local-op/clone', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: request.url,
                dir: request.dir || undefined,
                branch:
                  typeof request.branch === 'string' && request.branch.length > 0
                    ? request.branch
                    : undefined,
              }),
              signal,
            });
            if (!res.ok) {
              // Pre-stream RFC 9457 problem+json: surface the typed `title`
              // so the user sees why clone failed (rate limit, auth, etc.)
              // instead of a generic "check the URL" message.
              let message = `Clone failed — check the URL and try again (${res.status})`;
              try {
                const body = (await res.json()) as unknown;
                const result = ProblemDetailsSchema.safeParse(body);
                if (result.success) message = `Clone failed: ${result.data.title}`;
              } catch {
                /* keep generic message */
              }
              push({ type: 'error', message });
              return;
            }
            if (!res.body) {
              push({ type: 'error', message: 'Clone failed — empty response body' });
              return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let leftover = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              leftover += decoder.decode(value, { stream: true });
              const lines = leftover.split('\n');
              leftover = lines.pop() ?? '';
              for (const line of lines) {
                if (!line.trim()) continue;
                // Narrow try/catch to JSON.parse only — push() failures
                // propagate instead of being silently swallowed alongside
                // malformed JSON lines.
                let parsed: unknown;
                try {
                  parsed = JSON.parse(line);
                } catch {
                  // A corrupted stream of malformed JSON lines would otherwise
                  // appear to hang silently until completion. Surface the drop
                  // at warn level for DevTools / observability visibility, and
                  // bound the slice so a giant garbled line doesn't dump the
                  // entire payload into the console.
                  console.warn(
                    '[clone-transport] Dropped unparseable NDJSON line:',
                    line.slice(0, 100),
                  );
                  continue; // malformed NDJSON line
                }
                // Server wraps mid-stream errors in `StreamingProblemEvent`
                // shape (`{type:'error', problem: ProblemDetails}`). The
                // `CloneEvent` consumer union expects
                // `{type:'error', message: string}`. Bridge the two shapes
                // here at the transport boundary so consumers stay simple.
                if (
                  parsed &&
                  typeof parsed === 'object' &&
                  (parsed as { type?: unknown }).type === 'error' &&
                  'problem' in parsed
                ) {
                  const p = (parsed as { problem: { title?: string; detail?: string } }).problem;
                  push({ type: 'error', message: p?.detail || p?.title || 'Unknown error' });
                  // Stop processing further lines in this chunk — push() of an
                  // error event aborts the buffered-async-stream's signal, so
                  // the outer while breaks on the next iteration
                  // anyway; making the intent explicit here mirrors auth-
                  // transport's `'terminal'` shape and avoids unnecessary
                  // no-op pushes on the remaining lines of the chunk.
                  break;
                }
                push(parsed as CloneEvent);
              }
              if (signal.aborted) break;
            }
            if (!signal.aborted) {
              push({
                type: 'error',
                message: 'Clone stream ended unexpectedly — check if the clone completed',
              });
            }
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
            push({ type: 'error', message: 'Clone failed — connection error' });
          }
        })();
      });
    },
  };
}

/**
 * IPC transport — wraps `bridge.localOp.clone.start()`. The bridge stream's
 * `OkLocalOpCloneEvent` is a member of `CloneEvent` (including the
 * `branch-fallback` variant), so the handle is assignable directly without
 * an adapter. Branch threads through to the main-process handler, which
 * forwards it to `runCloneSubprocess`'s `-b <branch>` arg — symmetry with
 * the HTTP transport's `/api/local-op/clone` body.
 */
export function ipcCloneTransport(bridge: OkDesktopBridge): CloneTransport {
  return {
    start(request): CloneTransportHandle {
      const branch =
        typeof request.branch === 'string' && request.branch.length > 0 ? request.branch : null;
      return bridge.localOp.clone.start({
        url: request.url,
        dir: request.dir,
        branch,
      });
    },
  };
}
