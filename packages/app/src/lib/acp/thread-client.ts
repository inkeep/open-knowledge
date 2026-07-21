/**
 * Client for the `/collab/thread` WebSocket — the app-side half of the ACP
 * thread transport.
 *
 * One module-scope client per window holds a single WS, a map of thread
 * states (info + copy-on-write event log), and a listener set for
 * `useSyncExternalStore` consumers. Recovery contract: on (re)connect it
 * sends `list`, then `subscribe { sinceSeq: lastSeq + 1 }` for every thread —
 * the server replays the missed tail from its retained log, so a reload or a
 * dropped socket loses nothing that the server still holds.
 *
 * The URL comes from the same `/api/config` resolution the CRDT provider
 * uses (`useCollabUrl`), swapped onto the `/collab/thread` path — bind it via
 * `AgentThreadClientBinder` (mounted once in EditorPane).
 */

import type {
  ThreadClientFrame,
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t } from '@lingui/core/macro';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { type ThreadRenderModel, ThreadRenderModelBuilder } from './thread-event-model';

export interface ThreadState {
  readonly info: ThreadInfo;
  /** Copy-on-write: a new array reference per appended event. */
  readonly events: readonly ThreadEvent[];
  readonly lastSeq: number;
}

export type ThreadConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

interface PendingCreate {
  resolve: (info: ThreadInfo) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const CREATE_TIMEOUT_MS = 30_000;
/** Resume resolves only after the full agent respawn + session handshake (npx cold boots take a while). */
const RESUME_TIMEOUT_MS = 90_000;
const CHANNEL_WAIT_MS = 8_000;

/** A `resume` op the server rejected; `code` distinguishes "this agent can't
 *  resume old sessions" (offer a fresh thread) from transient failures. */
export class ThreadResumeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ThreadResumeError';
    this.code = code;
  }
}

/**
 * The thread channel could not be opened (no URL bound yet, the server is
 * down, or it predates the `/collab/thread` endpoint). Callers map this to a
 * localized, actionable message — the raw `message` is diagnostic only.
 */
export class ThreadChannelUnavailableError extends Error {
  constructor() {
    super('agent-thread channel is not connected');
    this.name = 'ThreadChannelUnavailableError';
  }
}

export class AgentThreadClient {
  private url: string | null = null;
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private threads = new Map<string, ThreadState>();
  private listeners = new Set<() => void>();
  private pendingCreates = new Map<string, PendingCreate>();
  private pendingResumes = new Map<string, PendingCreate>();
  /** Archived threads the user explicitly opened as tabs this session. */
  private openedArchived = new Set<string>();
  private reqCounter = 0;
  private status: ThreadConnectionStatus = 'idle';
  /** Bumped on every store change; the useSyncExternalStore snapshot. */
  private version = 0;

  /** Set (or clear) the WS URL. Reconnects when it changes. */
  setUrl(url: string | null): void {
    if (url === this.url) return;
    this.url = url;
    this.teardownSocket();
    if (url !== null) this.connect();
    else this.setStatus('idle');
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // Version-keyed snapshot cache. `useSyncExternalStore` requires getSnapshot to
  // return a value that is referentially stable between store bumps. Returning a
  // fresh array on every call would loop the store; worse, with React Compiler
  // enabled, a hook that CALLS `client.getThreads()` outside the
  // `useSyncExternalStore` return (discarding its result) has no tracked reactive
  // input, so the compiler memoizes the hook's result to the first (empty)
  // snapshot and the UI never updates. So the getters are bound fields returning
  // references that change only when `version` advances, and the hooks return the
  // store value directly (see the hooks at the bottom of this file).
  private threadsSnapshot: ThreadInfo[] = [];
  private threadsSnapshotVersion = -1;
  getThreads = (): ThreadInfo[] => {
    if (this.threadsSnapshotVersion !== this.version) {
      this.threadsSnapshot = [...this.threads.values()]
        .map((t) => t.info)
        .sort((a, b) => a.createdAt - b.createdAt);
      this.threadsSnapshotVersion = this.version;
    }
    return this.threadsSnapshot;
  };

  // Same version-keyed stability contract as getThreads (see above).
  private openTabsSnapshot: ThreadInfo[] = [];
  private openTabsSnapshotVersion = -1;
  /** Dock tabs: every live thread, plus archived ones explicitly opened. */
  getOpenTabs = (): ThreadInfo[] => {
    if (this.openTabsSnapshotVersion !== this.version) {
      this.openTabsSnapshot = [...this.threads.values()]
        .map((t) => t.info)
        .filter((info) => info.archived !== true || this.openedArchived.has(info.threadId))
        .sort((a, b) => a.createdAt - b.createdAt);
      this.openTabsSnapshotVersion = this.version;
    }
    return this.openTabsSnapshot;
  };

  private archivedSnapshot: ThreadInfo[] = [];
  private archivedSnapshotVersion = -1;
  /** History-menu list: archived threads, most recent activity first. */
  getArchivedThreads = (): ThreadInfo[] => {
    if (this.archivedSnapshotVersion !== this.version) {
      this.archivedSnapshot = [...this.threads.values()]
        .map((t) => t.info)
        .filter((info) => info.archived === true)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      this.archivedSnapshotVersion = this.version;
    }
    return this.archivedSnapshot;
  };

  // The stored `ThreadState` is replaced (new object) on every mutation and left
  // untouched otherwise, so it is a valid stable snapshot as-is.
  getThread = (threadId: string): ThreadState | null => this.threads.get(threadId) ?? null;

  /**
   * Render model per thread, folded incrementally as events arrive. Lazy: a
   * thread nobody renders (dock hidden, background tab) never pays the fold.
   * The builder caches its snapshot, so repeated calls without new events
   * return the same reference — the `useSyncExternalStore` contract.
   */
  private readonly modelBuilders = new Map<string, ThreadRenderModelBuilder>();
  getThreadModel = (threadId: string): ThreadRenderModel | null => {
    const state = this.threads.get(threadId);
    if (state === undefined) return null;
    let builder = this.modelBuilders.get(threadId);
    if (builder === undefined) {
      builder = new ThreadRenderModelBuilder();
      this.modelBuilders.set(threadId, builder);
    }
    return builder.sync(state.events);
  };

  getConnectionStatus = (): ThreadConnectionStatus => this.status;

  async createThread(params: {
    agent: { source: 'registry' | 'custom'; id: string };
    prompt?: string;
    docName?: string;
    titleHint?: string;
  }): Promise<ThreadInfo> {
    // A click can land while the socket is still connecting, mid-reconnect
    // backoff, or before the region has bound the URL. Fast-track a connect
    // attempt and wait briefly for the channel instead of failing instantly.
    this.connectNow();
    await this.waitForOpen(CHANNEL_WAIT_MS);
    this.reqCounter += 1;
    const reqId = `create-${this.reqCounter}`;
    const promise = new Promise<ThreadInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCreates.delete(reqId);
        reject(new Error('thread creation timed out'));
      }, CREATE_TIMEOUT_MS);
      this.pendingCreates.set(reqId, { resolve, reject, timer });
    });
    this.send({ op: 'create', reqId, ...params });
    return promise;
  }

  prompt(threadId: string, content: string): void {
    this.reqCounter += 1;
    this.send({ op: 'prompt', threadId, reqId: `prompt-${this.reqCounter}`, content });
  }

  respondPermission(
    threadId: string,
    requestId: string,
    outcome: { kind: 'selected'; optionId: string } | { kind: 'cancelled' },
  ): void {
    this.send({ op: 'permission_response', threadId, requestId, outcome });
  }

  respondRuntimeConsent(
    threadId: string,
    requestId: string,
    outcome: { kind: 'granted'; remember?: boolean } | { kind: 'declined'; remember?: boolean },
  ): void {
    this.send({ op: 'runtime_consent_response', threadId, requestId, outcome });
  }

  cancel(threadId: string): void {
    this.send({ op: 'cancel', threadId });
  }

  setMode(threadId: string, modeId: string): void {
    this.send({ op: 'set_mode', threadId, modeId });
  }

  /**
   * Manually retitle a thread (tab rename). Blank titles are a no-op; the
   * server clamps and confirms via an `info` frame, so no optimistic update.
   */
  renameThread(threadId: string, title: string): void {
    const trimmed = title.trim();
    if (trimmed === '') return;
    this.send({ op: 'rename', threadId, title: trimmed });
  }

  setConfigOption(threadId: string, configId: string, value: string | boolean): void {
    this.send({ op: 'set_config_option', threadId, configId, value });
  }

  closeThread(threadId: string): void {
    const state = this.threads.get(threadId);
    if (state?.info.archived === true) {
      // Archived tabs close locally — the server-side record (and its
      // transcript) stays. Drop the replayed events so a later reopen
      // replays fresh from disk instead of accreting.
      this.send({ op: 'unsubscribe', threadId });
      this.openedArchived.delete(threadId);
      this.modelBuilders.delete(threadId);
      this.threads.set(threadId, { info: state.info, events: [], lastSeq: -1 });
      this.bump();
      return;
    }
    this.send({ op: 'close', threadId });
    // Drop local state immediately — the tab is gone; the server confirms via
    // the refreshed `threads` frame (which re-adds it as archived history).
    this.openedArchived.delete(threadId);
    this.modelBuilders.delete(threadId);
    if (this.threads.delete(threadId)) this.bump();
  }

  /** Open an archived thread as a tab, replaying its transcript from disk. */
  openArchivedThread(threadId: string): void {
    const state = this.threads.get(threadId);
    if (state === undefined || state.info.archived !== true) return;
    if (this.openedArchived.has(threadId)) return;
    this.openedArchived.add(threadId);
    this.send({ op: 'subscribe', threadId, sinceSeq: state.lastSeq + 1 });
    this.bump();
  }

  /** Permanently delete an archived thread's transcript. */
  deleteThread(threadId: string): void {
    this.send({ op: 'delete', threadId });
    this.openedArchived.delete(threadId);
    this.modelBuilders.delete(threadId);
    if (this.threads.delete(threadId)) this.bump();
  }

  /**
   * Resume an archived thread (respawn agent + reconnect its session),
   * optionally sending `prompt` as the first turn. Resolves once the thread
   * is live again; rejects with {@link ThreadResumeError} on failure —
   * `code === 'resume-unsupported'` means the agent can't continue old
   * sessions and the UI should offer a fresh thread.
   */
  async resumeThread(threadId: string, prompt?: string): Promise<ThreadInfo> {
    this.connectNow();
    await this.waitForOpen(CHANNEL_WAIT_MS);
    this.reqCounter += 1;
    const reqId = `resume-${this.reqCounter}`;
    const promise = new Promise<ThreadInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResumes.delete(reqId);
        reject(new ThreadResumeError('timeout', 'resume timed out'));
      }, RESUME_TIMEOUT_MS);
      this.pendingResumes.set(reqId, { resolve, reject, timer });
    });
    this.send({ op: 'resume', threadId, reqId, prompt });
    return promise;
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Connect immediately if a URL is bound and no socket exists — cancels a
   * pending reconnect backoff (up to 15s) so a user-initiated action doesn't
   * sit out the timer. No-op while a socket is connecting or open.
   */
  private connectNow(): void {
    if (this.url === null || this.ws !== null) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.connect();
  }

  /** Resolve once the socket is OPEN; reject after `timeoutMs`. */
  private waitForOpen(timeoutMs: number): Promise<void> {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        if (ok) resolve();
        else reject(new ThreadChannelUnavailableError());
      };
      const unsubscribe = this.subscribe(() => {
        if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) settle(true);
      });
      const timer = setTimeout(() => settle(false), timeoutMs);
    });
  }

  private connect(): void {
    if (this.url === null) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.setStatus('open');
      this.send({ op: 'list' });
      // Re-attach to every LIVE thread (and any archived tab the user has
      // open), replaying whatever we missed. Unopened archived threads must
      // not re-subscribe — that would replay the whole retained archive on
      // every reconnect.
      for (const [threadId, state] of this.threads) {
        if (state.info.archived === true && !this.openedArchived.has(threadId)) continue;
        this.send({ op: 'subscribe', threadId, sinceSeq: state.lastSeq + 1 });
      }
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data !== 'string') return;
      let frame: ThreadServerFrame;
      try {
        frame = JSON.parse(event.data) as ThreadServerFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('closed');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  private teardownSocket(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reject in-flight creates and resumes immediately — the socket they
    // were issued on is gone, so letting them ride out their create/resume
    // timeouts would leak the timers and hand callers a late, misleading
    // timeout error.
    for (const pending of this.pendingCreates.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ThreadChannelUnavailableError());
    }
    this.pendingCreates.clear();
    for (const pending of this.pendingResumes.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ThreadChannelUnavailableError());
    }
    this.pendingResumes.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.url === null || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(frame: ThreadClientFrame): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The close handler owns recovery.
    }
  }

  private handleFrame(frame: ThreadServerFrame): void {
    switch (frame.op) {
      case 'created': {
        const pending = this.pendingCreates.get(frame.reqId);
        if (pending !== undefined) {
          this.pendingCreates.delete(frame.reqId);
          clearTimeout(pending.timer);
          pending.resolve(frame.info);
        }
        this.upsertInfo(frame.info);
        return;
      }
      case 'threads': {
        const seen = new Set<string>();
        for (const info of frame.threads) {
          seen.add(info.threadId);
          const known = this.threads.has(info.threadId);
          this.upsertInfo(info);
          // A LIVE thread we did not know about (fresh reload) — attach to
          // it. Archived threads are history: subscribing here would replay
          // every retained transcript on every reload, so they attach only
          // when explicitly opened.
          if (!known && info.archived !== true) {
            this.send({ op: 'subscribe', threadId: info.threadId, sinceSeq: 0 });
          }
        }
        let dropped = false;
        // Snapshot the keys before deleting during iteration.
        for (const threadId of Array.from(this.threads.keys())) {
          if (!seen.has(threadId)) {
            this.threads.delete(threadId);
            this.modelBuilders.delete(threadId);
            this.openedArchived.delete(threadId);
            dropped = true;
          }
        }
        if (dropped) this.bump();
        return;
      }
      case 'resumed': {
        const pending = this.pendingResumes.get(frame.reqId);
        if (pending !== undefined) {
          this.pendingResumes.delete(frame.reqId);
          clearTimeout(pending.timer);
          pending.resolve(frame.info);
        }
        this.upsertInfo(frame.info);
        return;
      }
      case 'subscribed': {
        this.upsertInfo(frame.info);
        return;
      }
      case 'info': {
        this.upsertInfo(frame.info);
        return;
      }
      case 'event': {
        this.appendEvents(frame.threadId, frame.seq, [frame.event]);
        return;
      }
      case 'events': {
        this.appendEvents(frame.threadId, frame.fromSeq, frame.events);
        return;
      }
      case 'error': {
        if (frame.reqId !== undefined) {
          const pending = this.pendingCreates.get(frame.reqId);
          if (pending !== undefined) {
            this.pendingCreates.delete(frame.reqId);
            clearTimeout(pending.timer);
            pending.reject(new Error(frame.message));
            return;
          }
          const pendingResume = this.pendingResumes.get(frame.reqId);
          if (pendingResume !== undefined) {
            this.pendingResumes.delete(frame.reqId);
            clearTimeout(pendingResume.timer);
            pendingResume.reject(new ThreadResumeError(frame.code, frame.message));
            return;
          }
          if (frame.reqId.startsWith('prompt-')) {
            // A rejected prompt (e.g. a turn was already running) never
            // reaches the transcript — the composer already cleared, so
            // without feedback the user's message just vanishes.
            toast.error(t`Message not sent: ${frame.message}`);
            return;
          }
        }
        // Thread-scoped errors surface through status events; log the rest.
        console.warn('[agent-threads] server error frame:', frame.code, frame.message);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Append consecutive events starting at `fromSeq`, skipping any the store
   * already has (replay/flush overlap) — one array copy and one listener
   * notification per batch, however many events arrived.
   */
  private appendEvents(threadId: string, fromSeq: number, events: readonly ThreadEvent[]): void {
    const state = this.threads.get(threadId);
    if (state === undefined || events.length === 0) return;
    const skip = Math.max(state.lastSeq + 1 - fromSeq, 0);
    if (skip >= events.length) return;
    const fresh = skip === 0 ? events : events.slice(skip);
    let info = state.info;
    for (const event of fresh) {
      info = applyEventToInfo(info, event);
    }
    this.threads.set(threadId, {
      info,
      events: [...state.events, ...fresh],
      lastSeq: fromSeq + events.length - 1,
    });
    this.bump();
  }

  private upsertInfo(info: ThreadInfo): void {
    const existing = this.threads.get(info.threadId);
    if (existing === undefined) {
      this.threads.set(info.threadId, { info, events: [], lastSeq: -1 });
    } else if (info.archived === true && existing.info.archived !== true) {
      // Live → archived (server-side close/reap). The tab derivation drops it
      // and the retained events would only go stale — free them so a later
      // history open replays fresh from disk.
      this.openedArchived.delete(info.threadId);
      this.modelBuilders.delete(info.threadId);
      this.threads.set(info.threadId, { info, events: [], lastSeq: -1 });
    } else {
      this.threads.set(info.threadId, { ...existing, info });
    }
    this.bump();
  }

  private setStatus(status: ThreadConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/** Keep tab labels/status live without waiting for the next `info` frame. */
function applyEventToInfo(info: ThreadInfo, event: ThreadEvent): ThreadInfo {
  switch (event.kind) {
    case 'status':
      return { ...info, status: event.status, lastActivityAt: event.ts };
    case 'title_changed':
      return { ...info, title: event.title, lastActivityAt: event.ts };
    default:
      return { ...info, lastActivityAt: event.ts };
  }
}

const client = new AgentThreadClient();

export function getAgentThreadClient(): AgentThreadClient {
  return client;
}

/** Reactive list of thread infos (creation order). */
export function useAgentThreads(): ThreadInfo[] {
  return useSyncExternalStore(client.subscribe, client.getThreads, client.getThreads);
}

/** Reactive dock-tab list: live threads + explicitly opened archived ones. */
export function useOpenAgentThreadTabs(): ThreadInfo[] {
  return useSyncExternalStore(client.subscribe, client.getOpenTabs, client.getOpenTabs);
}

/** Reactive archived-thread list (history menu), latest activity first. */
export function useArchivedAgentThreads(): ThreadInfo[] {
  return useSyncExternalStore(
    client.subscribe,
    client.getArchivedThreads,
    client.getArchivedThreads,
  );
}

/** Reactive state (info + events) for one thread; null when unknown. */
export function useAgentThread(threadId: string): ThreadState | null {
  const getSnapshot = () => client.getThread(threadId);
  return useSyncExternalStore(client.subscribe, getSnapshot, getSnapshot);
}

/**
 * Reactive render model for one thread; null when unknown. Incrementally
 * folded in the store — consuming this instead of re-folding
 * `state.events` in render is what keeps long streaming transcripts O(new
 * events) per update.
 */
export function useAgentThreadModel(threadId: string): ThreadRenderModel | null {
  const getSnapshot = () => client.getThreadModel(threadId);
  return useSyncExternalStore(client.subscribe, getSnapshot, getSnapshot);
}

/** Reactive connection status for the thread channel. */
export function useAgentThreadConnection(): ThreadConnectionStatus {
  return useSyncExternalStore(
    client.subscribe,
    client.getConnectionStatus,
    client.getConnectionStatus,
  );
}

/** Derive the thread WS URL from the resolved collab URL. */
export function threadUrlFromCollabUrl(collabUrl: string | null): string | null {
  if (collabUrl === null) return null;
  try {
    const url = new URL(collabUrl);
    url.pathname = '/collab/thread';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}
