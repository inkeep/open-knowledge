/**
 * Development-only injection seam for the ACP thread transport.
 *
 * A real agent thread needs a spawned agent process, a negotiated session, and
 * a producer that happens to emit the shape under test. None of that is
 * reachable from a browser test, which is why the interesting rendering and
 * accessibility behaviour of the transcript has only ever been exercised
 * against hand-authored render models. Those bypass the client and the fold
 * entirely, so a classifier that never fires or a render arm that is never
 * reached still passes.
 *
 * This harness closes that gap by entering at the socket boundary instead:
 * frames are handed to {@link AgentThreadClient.receiveServerFrame} as raw
 * JSON, exactly as `onmessage` delivers them. Everything downstream — frame
 * dispatch, the event log, the incremental fold, the renderer, the browser's
 * own cascade — is the production path, unmodified and unaware that the bytes
 * were synthesized.
 *
 * Nothing here reaches a production bundle: the module is imported only from
 * inside an `import.meta.env.DEV` branch, which Vite resolves to a constant
 * false and Rollup then eliminates along with the dynamic import.
 */

import type {
  SessionUpdate,
  ThreadAgentInfo,
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
  ThreadStatus,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { AgentThreadClient } from './thread-client';

/** How a synthetic thread should present before any transcript arrives. */
interface DevThreadOptions {
  /**
   * Which agent the thread is running. Required, and deliberately so: the
   * transcript's interpretation of a payload can depend on which producer sent
   * it, so a default here would let a test assert a classification it never
   * actually asked for.
   */
  readonly agent: ThreadAgentInfo;
  /** Defaults to a fresh unique id. */
  readonly threadId?: string;
  readonly title?: string;
  readonly status?: ThreadStatus;
}

export interface AcpThreadHarness {
  /**
   * Put an empty synthetic thread on screen and return its id. The transcript
   * that follows arrives live, through {@link AcpThreadHarness.pushUpdates}.
   */
  openThread(options: DevThreadOptions): string;
  /**
   * Live arrival: one `event` frame per update, in order, as a streaming turn
   * delivers them.
   */
  pushUpdates(threadId: string, updates: readonly SessionUpdate[]): void;
  /**
   * History replay: subscribe a thread and hydrate its whole transcript from
   * the retained log in one batch, as opening an existing thread does. Takes
   * the same updates {@link AcpThreadHarness.pushUpdates} accepts so the two
   * lifecycles can be compared on identical input.
   */
  replayThread(options: DevThreadOptions, updates: readonly SessionUpdate[]): string;
  /**
   * Deliver one frame verbatim, for shapes the convenience methods above do
   * not cover.
   */
  frame(frame: ThreadServerFrame): void;
  /**
   * Drop every thread this harness opened, leaving any the server owns alone.
   */
  reset(): void;
}

let syntheticCounter = 0;

function makeThreadInfo(options: DevThreadOptions, threadId: string, lastSeq: number): ThreadInfo {
  const now = Date.now();
  return {
    threadId,
    agent: options.agent,
    title: options.title ?? 'Injected thread',
    status: options.status ?? 'ready',
    createdAt: now,
    lastActivityAt: now,
    modes: null,
    configOptions: null,
    lastSeq,
    archived: false,
  };
}

function toEvent(update: SessionUpdate): ThreadEvent {
  return { kind: 'session_update', update, ts: Date.now() };
}

/**
 * Publish the harness on `window.__acpThreadHarness` and return its uninstaller.
 * A no-op outside development, so the caller needs no gate of its own beyond
 * the one that keeps this module out of the bundle.
 */
export function installAcpThreadHarness(client: AgentThreadClient): () => void {
  if (!import.meta.env.DEV) return () => {};

  const owned = new Set<string>();

  const deliver = (frame: ThreadServerFrame): void => {
    client.receiveServerFrame(JSON.stringify(frame));
  };

  // `lastSeq` is the retained log's upper bound, which the server announces
  // before it replays anything. A consumer that has to tell history from live
  // arrival watches for the transcript to reach it, so a replay that claimed an
  // empty log would read as a burst of brand-new activity.
  const subscribe = (options: DevThreadOptions, lastSeq: number): string => {
    syntheticCounter += 1;
    const threadId = options.threadId ?? `injected-${syntheticCounter}`;
    owned.add(threadId);
    deliver({
      op: 'subscribed',
      threadId,
      fromSeq: 0,
      info: makeThreadInfo(options, threadId, lastSeq),
    });
    return threadId;
  };

  const harness: AcpThreadHarness = {
    openThread: (options) => subscribe(options, -1),

    pushUpdates(threadId, updates) {
      for (const update of updates) {
        // Read the seq back from the store rather than counting locally: the
        // client drops any event whose seq it already holds, so a private
        // counter that drifted would silently swallow updates.
        const seq = (client.getThread(threadId)?.lastSeq ?? -1) + 1;
        deliver({ op: 'event', threadId, seq, event: toEvent(update) });
      }
    },

    replayThread(options, updates) {
      const threadId = subscribe(options, updates.length - 1);
      if (updates.length > 0) {
        deliver({
          op: 'events',
          threadId,
          fromSeq: 0,
          events: updates.map(toEvent),
        });
      }
      return threadId;
    },

    frame: deliver,

    reset() {
      if (owned.size === 0) return;
      // A `threads` frame is the server's authoritative roster, and the client
      // drops whatever it omits. Re-listing the threads this harness does not
      // own is what keeps the reset from evicting real ones alongside them.
      const survivors = client.getThreads().filter((info) => !owned.has(info.threadId));
      owned.clear();
      deliver({ op: 'threads', threads: survivors });
    },
  };

  window.__acpThreadHarness = harness;
  return () => {
    if (window.__acpThreadHarness === harness) {
      delete window.__acpThreadHarness;
    }
  };
}
