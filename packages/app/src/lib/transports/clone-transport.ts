import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import type { OkDesktopBridge, OkLocalOpCloneEvent } from '@/lib/desktop-bridge-types';
import { createBufferedAsyncStream } from './buffered-async-stream';

type HttpCloneCompleteEvent = { type: 'complete'; port: number; dir: string };

type CloneBranchFallbackEvent = { type: 'branch-fallback'; branch: string };

type CloneEvent = OkLocalOpCloneEvent | HttpCloneCompleteEvent | CloneBranchFallbackEvent;

interface CloneTransportHandle {
  readonly events: AsyncIterable<CloneEvent>;
  cancel(): void;
}

export interface CloneTransport {
  start(request: { url: string; dir: string; branch?: string | null }): CloneTransportHandle;
}

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
              let message = `Clone failed — check the URL and try again (${res.status})`;
              try {
                const body = (await res.json()) as unknown;
                const result = ProblemDetailsSchema.safeParse(body);
                if (result.success) message = `Clone failed: ${result.data.title}`;
              } catch {}
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
                let parsed: unknown;
                try {
                  parsed = JSON.parse(line);
                } catch {
                  console.warn(
                    '[clone-transport] Dropped unparseable NDJSON line:',
                    line.slice(0, 100),
                  );
                  continue; // malformed NDJSON line
                }
                if (
                  parsed &&
                  typeof parsed === 'object' &&
                  (parsed as { type?: unknown }).type === 'error' &&
                  'problem' in parsed
                ) {
                  const p = (parsed as { problem: { title?: string; detail?: string } }).problem;
                  push({ type: 'error', message: p?.detail || p?.title || 'Unknown error' });
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
