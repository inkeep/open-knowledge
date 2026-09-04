import type {
  SessionUpdate,
  ThreadAgentInfo,
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
  ThreadStatus,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { AgentThreadClient } from './thread-client';

interface DevThreadOptions {
  readonly agent: ThreadAgentInfo;
  readonly threadId?: string;
  readonly title?: string;
  readonly status?: ThreadStatus;
}

export interface AcpThreadHarness {
  openThread(options: DevThreadOptions): string;
  pushUpdates(threadId: string, updates: readonly SessionUpdate[]): void;
  replayThread(options: DevThreadOptions, updates: readonly SessionUpdate[]): string;
  frame(frame: ThreadServerFrame): void;
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

export function installAcpThreadHarness(client: AgentThreadClient): () => void {
  if (!import.meta.env.DEV) return () => {};

  const owned = new Set<string>();

  const deliver = (frame: ThreadServerFrame): void => {
    client.receiveServerFrame(JSON.stringify(frame));
  };

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
