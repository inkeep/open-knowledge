import type {
  SessionUpdate,
  ThreadAgentInfo,
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
  ThreadStatus,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { AgentThreadClient, ThreadState } from './thread-client';

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

  const owned = new Map<string, ThreadState>();
  const previousReceiveServerFrame = client.receiveServerFrame;
  const previousSetUrl = client.setUrl;
  const previousCloseThread = client.closeThread;
  const previousDeleteThread = client.deleteThread;

  const deliver = (frame: ThreadServerFrame): void => {
    client.receiveServerFrame(JSON.stringify(frame));
  };

  const deliverUnwrapped = (frame: ThreadServerFrame): void => {
    previousReceiveServerFrame.call(client, JSON.stringify(frame));
  };

  const captureOwned = (): void => {
    for (const threadId of owned.keys()) {
      const state = client.getThread(threadId);
      if (state !== null) owned.set(threadId, state);
    }
  };

  const restoreOwned = (): void => {
    for (const [threadId, state] of owned) {
      if (client.getThread(threadId) !== null) continue;
      deliverUnwrapped({ op: 'subscribed', threadId, fromSeq: 0, info: state.info });
      if (state.events.length > 0) {
        deliverUnwrapped({ op: 'events', threadId, fromSeq: 0, events: [...state.events] });
      }
    }
  };

  client.receiveServerFrame = (data: string): void => {
    captureOwned();
    previousReceiveServerFrame.call(client, data);
    restoreOwned();
  };
  client.setUrl = (url: string | null): void => {
    const previousUrl = client.getThreadScope();
    captureOwned();
    previousSetUrl.call(client, url);
    if (previousUrl !== null && url !== previousUrl) owned.clear();
  };
  client.closeThread = (threadId: string): void => {
    owned.delete(threadId);
    previousCloseThread.call(client, threadId);
  };
  client.deleteThread = (threadId: string): void => {
    owned.delete(threadId);
    previousDeleteThread.call(client, threadId);
  };

  const subscribe = (options: DevThreadOptions, lastSeq: number): string => {
    syntheticCounter += 1;
    const threadId = options.threadId ?? `injected-${syntheticCounter}`;
    const info = makeThreadInfo(options, threadId, lastSeq);
    deliver({
      op: 'subscribed',
      threadId,
      fromSeq: 0,
      info,
    });
    const state = client.getThread(threadId);
    if (state !== null) owned.set(threadId, state);
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
    client.receiveServerFrame = previousReceiveServerFrame;
    client.setUrl = previousSetUrl;
    client.closeThread = previousCloseThread;
    client.deleteThread = previousDeleteThread;
    if (window.__acpThreadHarness === harness) {
      delete window.__acpThreadHarness;
    }
  };
}
