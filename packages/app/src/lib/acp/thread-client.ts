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
  AttachmentPart,
  ThreadClientFrame,
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { THREAD_REOPEN_OP_TIMEOUT_MS } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t } from '@lingui/core/macro';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import {
  agentSettingsKey,
  getRememberedAgentConfig,
  getRememberedAgentMode,
} from './agent-settings-store';
import { type ThreadRenderModel, ThreadRenderModelBuilder } from './thread-event-model';

export interface ThreadState {
  readonly info: ThreadInfo;
  /** Copy-on-write: a new array reference per appended event. */
  readonly events: readonly ThreadEvent[];
  readonly lastSeq: number;
  /**
   * Upper bound of the replay the server is about to deliver, taken from the
   * `subscribed` frame and held still afterwards.
   *
   * `info.lastSeq` cannot serve here even though it carries the same number at
   * subscribe time: the server advances it the moment it appends while event
   * batches coalesce on a timer, so it races ahead of the transcript for the
   * rest of the session. Anything at or below this bound was already history
   * when the subscription opened; anything above it arrived while the reader
   * was watching. Infinity until the server says otherwise, so an unbounded
   * window is treated as all-history rather than all-new.
   */
  readonly replayThroughSeq: number;
}

export type ThreadConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

interface PendingCreate {
  resolve: (info: ThreadInfo) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingQueueEdit {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Placeholder for a seq the server never delivered. Renders nothing (the fold
 * has no arm for this kind) and exists only to keep an event's position in the
 * transcript array equal to its seq.
 */
const SEQ_GAP_EVENT: ThreadEvent = Object.freeze({
  kind: 'agent_stderr',
  line: '[missing log entry]',
  ts: 0,
});

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const CREATE_TIMEOUT_MS = 30_000;
/** Resume resolves only after the full agent respawn + session handshake (npx cold boots take a while). */
const RESUME_TIMEOUT_MS = THREAD_REOPEN_OP_TIMEOUT_MS;
/** Retry re-runs the same launch, plus a fresh login-shell PATH probe. */
const RETRY_TIMEOUT_MS = THREAD_REOPEN_OP_TIMEOUT_MS;
/** Sign-in can park on a browser round trip before the session re-opens. */
const AUTHENTICATE_TIMEOUT_MS = 180_000;
const CHANNEL_WAIT_MS = 8_000;
/** How long a queue edit waits for a refusal before it counts as applied. */
const QUEUE_EDIT_TIMEOUT_MS = 10_000;

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
  private pendingRetries = new Map<string, PendingCreate>();
  private pendingAuths = new Map<string, PendingCreate>();
  private pendingQueueEdits = new Map<string, PendingQueueEdit>();
  /** Archived threads the user explicitly opened as tabs this session. */
  private openedArchived = new Set<string>();
  /**
   * Per-thread timestamp of the last activity the user actually saw — bumped
   * to `info.lastActivityAt` when the tab activates. Seeded on first
   * observation of a thread to whatever `lastActivityAt` already is, so a
   * renderer reload does NOT report every idle `ready` tab as unread — the
   * pulse should mean "advanced while you were elsewhere in this window",
   * not "you just reloaded". In-memory only; not persisted across processes.
   */
  private lastViewedByThread = new Map<string, number>();
  private reqCounter = 0;
  private status: ThreadConnectionStatus = 'idle';
  /** Bumped on every store change; the useSyncExternalStore snapshot. */
  private version = 0;

  /**
   * Mark a thread as "seen up to its current lastActivityAt" — clears the
   * unread affordance on its tab. Called on tab activation, and again on
   * every activity tick (or status transition into `ready`) while the tab
   * stays active.
   */
  markThreadViewed = (threadId: string): void => {
    const state = this.threads.get(threadId);
    if (state === undefined) return;
    // Only meaningful on a settled `ready` tab. Skipping during `running`
    // avoids a bump storm: every streaming event advances lastActivityAt,
    // and the SessionsHost effect keys on it — a bump per batch here
    // would invalidate the snapshot cache and re-render every subscriber
    // once per event. The transition into `ready` re-fires the effect
    // and clears unread with a single bump.
    if (state.info.status !== 'ready') return;
    const at = state.info.lastActivityAt;
    if (this.lastViewedByThread.get(threadId) === at) return;
    this.lastViewedByThread.set(threadId, at);
    this.bump();
  };

  /**
   * Whether the thread has activity the user hasn't seen since last viewing
   * it. Only meaningful on a settled (`ready`) tab — a running turn already
   * carries its own pulse via the status dot.
   */
  getThreadUnread = (threadId: string): boolean => {
    const state = this.threads.get(threadId);
    if (state === undefined) return false;
    if (state.info.status !== 'ready') return false;
    // Floor is seeded at first observation in `upsertInfo`, so any thread
    // present in `this.threads` also has an entry here. The undefined
    // check exists to discharge `Map.get`'s `T | undefined` return for
    // strictNullChecks; it is not a live failure mode (unreachable under
    // the current write set).
    const seen = this.lastViewedByThread.get(threadId);
    if (seen === undefined) return false;
    return state.info.lastActivityAt > seen;
  };

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
      builder = new ThreadRenderModelBuilder(state.info.agent);
      this.modelBuilders.set(threadId, builder);
    }
    return builder.sync(state.events);
  };

  getConnectionStatus = (): ThreadConnectionStatus => this.status;

  async createThread(params: {
    agent: { source: 'registry' | 'custom'; id: string };
    prompt?: string;
    attachments?: readonly AttachmentPart[];
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
    // Carry this agent type's remembered settings so the server applies them
    // before turn 1 (a new thread of the same agent opens on the last-chosen
    // options). `modeId` covers the legacy mode surface; a mode advertised as a
    // config option already rides `config`. Absent → the agent's defaults stand.
    const settingsKey = agentSettingsKey(params.agent);
    const config = getRememberedAgentConfig(settingsKey);
    const modeId = getRememberedAgentMode(settingsKey);
    const settings =
      config !== undefined || modeId !== undefined
        ? {
            ...(config !== undefined ? { config } : {}),
            ...(modeId !== undefined ? { modeId } : {}),
          }
        : undefined;
    this.send({
      op: 'create',
      reqId,
      ...params,
      ...(settings !== undefined ? { settings } : {}),
    });
    return promise;
  }

  prompt(threadId: string, content: string, attachments?: readonly AttachmentPart[]): void {
    const trimmed = content.trim();
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    // Refuse both-empty at the client so a no-op frame doesn't open an
    // empty turn — matches the guard steer() has. Server's `prompt` parser
    // accepts empty strings (attachment-only prompts are legitimate), so
    // this side is where the guard lives.
    if (trimmed === '' && !hasAttachments) return;
    this.reqCounter += 1;
    this.send({
      op: 'prompt',
      threadId,
      reqId: `prompt-${this.reqCounter}`,
      content: trimmed,
      ...(hasAttachments ? { attachments } : {}),
    });
  }

  /**
   * Stop the running turn and send `content` as the next one. Fire-and-forget
   * like `prompt`: the refreshed `info` (carrying the parked `steer`) is the
   * confirmation, and a refusal comes back as an `error` frame on the reqId.
   */
  steer(threadId: string, content: string, attachments?: readonly AttachmentPart[]): void {
    const trimmed = content.trim();
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (trimmed === '' && !hasAttachments) return;
    this.reqCounter += 1;
    this.send({
      op: 'steer',
      threadId,
      reqId: `steer-${this.reqCounter}`,
      content: trimmed,
      ...(hasAttachments ? { attachments } : {}),
    });
  }

  /**
   * Edit a message waiting in the thread's queue (`ThreadInfo.queue`) in
   * place, releasing any hold on it — saving is the resubmit. Resolves on the
   * server's `queue_edited` ack; REJECTS on the refusal carrying this reqId,
   * so the caller can tell the user the edit never landed instead of letting
   * it vanish.
   */
  editQueued(threadId: string, id: string, content: string): Promise<void> {
    const trimmed = content.trim();
    if (trimmed === '') return Promise.resolve();
    this.reqCounter += 1;
    const reqId = `queue-edit-${this.reqCounter}`;
    const promise = new Promise<void>((resolve, reject) => {
      // Backstop for a server too old to ack (or a frame lost with the
      // socket): silence for this long is read as applied, which is what the
      // pre-ack protocol assumed anyway.
      const timer = setTimeout(() => {
        this.pendingQueueEdits.delete(reqId);
        resolve();
      }, QUEUE_EDIT_TIMEOUT_MS);
      this.pendingQueueEdits.set(reqId, { resolve, reject, timer });
    });
    this.send({ op: 'queue_edit', threadId, id, content: trimmed, reqId });
    return promise;
  }

  /** Park a queued message so the drain skips it (an open edit holds its
   *  row), or release it back into line. */
  holdQueued(threadId: string, id: string, held: boolean): void {
    this.send({ op: 'queue_hold', threadId, id, held });
  }

  /** Remove a message from the thread's queue before it dispatches. */
  removeQueued(threadId: string, id: string): void {
    this.send({ op: 'queue_remove', threadId, id });
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
    outcome: { kind: 'granted' } | { kind: 'declined' },
  ): void {
    this.send({ op: 'runtime_consent_response', threadId, requestId, outcome });
  }

  /** Allow (or refuse) provisioning Pi's bridge extension for this project. */
  respondPiBridgeConsent(
    threadId: string,
    requestId: string,
    outcome: { kind: 'granted' } | { kind: 'declined' },
  ): void {
    this.send({ op: 'pi_bridge_consent_response', threadId, requestId, outcome });
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
      this.threads.set(threadId, {
        info: state.info,
        events: [],
        lastSeq: -1,
        replayThroughSeq: Number.POSITIVE_INFINITY,
      });
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
  async resumeThread(
    threadId: string,
    prompt?: string,
    attachments?: readonly AttachmentPart[],
  ): Promise<ThreadInfo> {
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
    this.send({
      op: 'resume',
      threadId,
      reqId,
      prompt,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    });
    return promise;
  }

  /**
   * Retry a thread whose startup failed — same thread, same transcript, a
   * fresh launch (the server re-probes the environment first, so a binary
   * installed since the failure is picked up). Resolves once the agent is
   * ready; rejects with the failure the retry landed on.
   */
  async retryThread(threadId: string): Promise<ThreadInfo> {
    this.connectNow();
    await this.waitForOpen(CHANNEL_WAIT_MS);
    this.reqCounter += 1;
    const reqId = `retry-${this.reqCounter}`;
    const promise = new Promise<ThreadInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRetries.delete(reqId);
        reject(new Error('retry timed out'));
      }, RETRY_TIMEOUT_MS);
      this.pendingRetries.set(reqId, { resolve, reject, timer });
    });
    this.send({ op: 'retry', threadId, reqId });
    return promise;
  }

  /**
   * Complete an advertised sign-in on a thread parked in `auth_required`. The
   * server authenticates on the agent's live connection and re-opens the
   * session there, so nothing respawns and the transcript is untouched.
   * Resolves once the thread is ready; rejects with what the sign-in failed
   * on (the caller surfaces it — the thread stays on its notice).
   */
  async authenticateThread(threadId: string, methodId: string): Promise<ThreadInfo> {
    this.connectNow();
    await this.waitForOpen(CHANNEL_WAIT_MS);
    this.reqCounter += 1;
    const reqId = `authenticate-${this.reqCounter}`;
    const promise = new Promise<ThreadInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAuths.delete(reqId);
        reject(new Error('sign-in timed out'));
      }, AUTHENTICATE_TIMEOUT_MS);
      this.pendingAuths.set(reqId, { resolve, reject, timer });
    });
    this.send({ op: 'authenticate', threadId, reqId, methodId });
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
      this.receiveServerFrame(event.data);
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
    for (const pending of this.pendingRetries.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ThreadChannelUnavailableError());
    }
    this.pendingRetries.clear();
    for (const pending of this.pendingAuths.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ThreadChannelUnavailableError());
    }
    this.pendingAuths.clear();
    // A dropped socket says nothing about whether the edit applied — settling
    // these as refusals would tell the user their words were lost on no
    // evidence at all.
    for (const pending of this.pendingQueueEdits.values()) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    this.pendingQueueEdits.clear();
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

  /**
   * The transport's whole inbound surface: one raw socket payload in, one
   * store mutation out. Malformed JSON is dropped rather than thrown, because
   * the peer is a separate process whose bytes this client does not control
   * and one bad frame must not take the channel down with it.
   *
   * Named and reachable so a caller can hand the client a frame without a
   * socket. Development tooling uses that to drive the real store, fold, and
   * renderer over synthesized transcripts; the socket remains the only caller
   * that ships.
   */
  receiveServerFrame(data: string): void {
    let frame: ThreadServerFrame;
    try {
      frame = JSON.parse(data) as ThreadServerFrame;
    } catch {
      return;
    }
    this.handleFrame(frame);
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
      case 'retried': {
        const pending = this.pendingRetries.get(frame.reqId);
        if (pending !== undefined) {
          this.pendingRetries.delete(frame.reqId);
          clearTimeout(pending.timer);
          pending.resolve(frame.info);
        }
        this.upsertInfo(frame.info);
        return;
      }
      case 'authenticated': {
        const pending = this.pendingAuths.get(frame.reqId);
        if (pending !== undefined) {
          this.pendingAuths.delete(frame.reqId);
          clearTimeout(pending.timer);
          pending.resolve(frame.info);
        }
        this.upsertInfo(frame.info);
        return;
      }
      case 'subscribed': {
        this.upsertInfo(frame.info);
        const state = this.threads.get(frame.threadId);
        if (state !== undefined) {
          this.threads.set(frame.threadId, { ...state, replayThroughSeq: frame.info.lastSeq });
          this.bump();
        }
        return;
      }
      case 'queue_edited': {
        const pending = this.pendingQueueEdits.get(frame.reqId);
        if (pending !== undefined) {
          this.pendingQueueEdits.delete(frame.reqId);
          clearTimeout(pending.timer);
          pending.resolve();
        }
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
          const pendingRetry = this.pendingRetries.get(frame.reqId);
          if (pendingRetry !== undefined) {
            this.pendingRetries.delete(frame.reqId);
            clearTimeout(pendingRetry.timer);
            pendingRetry.reject(new Error(frame.message));
            return;
          }
          const pendingAuth = this.pendingAuths.get(frame.reqId);
          if (pendingAuth !== undefined) {
            this.pendingAuths.delete(frame.reqId);
            clearTimeout(pendingAuth.timer);
            pendingAuth.reject(new Error(frame.message));
            return;
          }
          const pendingQueueEdit = this.pendingQueueEdits.get(frame.reqId);
          if (pendingQueueEdit !== undefined) {
            this.pendingQueueEdits.delete(frame.reqId);
            clearTimeout(pendingQueueEdit.timer);
            pendingQueueEdit.reject(new Error(frame.message));
            return;
          }
          if (frame.reqId.startsWith('prompt-') || frame.reqId.startsWith('steer-')) {
            // A rejected prompt or steer (thread archived/not ready, or the
            // queue is full) never reaches the transcript — the composer
            // already cleared, so without feedback the message just vanishes.
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
   *
   * Position in `events` is the event's seq, and consumers read it that way,
   * so a batch that opens above the tail is padded rather than closed up. A
   * replay whose durable log cannot supply the low range starts above seq 0,
   * and closing the hole would shift every later event below its true seq —
   * the same reason the persistence reader substitutes a placeholder for a
   * line it cannot parse instead of dropping it.
   *
   * The pad is as long as the hole, which reads as unbounded but is not: the
   * server replays contiguously from the seq it names, so a hole only opens
   * where the durable log has fewer lines than the thread has events, and its
   * size is that thread's own history at the moment persistence broke.
   * Refusing the batch instead would bound it, at the cost of freezing the
   * transcript for good — a reconnect resubscribes from the same tail, so a
   * server that still cannot supply the low range never gets past it.
   */
  private appendEvents(threadId: string, fromSeq: number, events: readonly ThreadEvent[]): void {
    const state = this.threads.get(threadId);
    if (state === undefined || events.length === 0) return;
    const skip = Math.max(state.lastSeq + 1 - fromSeq, 0);
    if (skip >= events.length) return;
    const fresh = skip === 0 ? events : events.slice(skip);
    const missing = Math.max(fromSeq - (state.lastSeq + 1), 0);
    if (missing > 0) {
      console.warn('[agent-threads] replay opened above the transcript tail', {
        threadId,
        fromSeq,
        have: state.lastSeq,
      });
    }
    let info = state.info;
    for (const event of fresh) {
      info = applyEventToInfo(info, event);
    }
    this.threads.set(threadId, {
      info,
      events: [
        ...state.events,
        ...(missing > 0 ? (Array(missing).fill(SEQ_GAP_EVENT) as ThreadEvent[]) : []),
        ...fresh,
      ],
      lastSeq: fromSeq + events.length - 1,
      replayThroughSeq: state.replayThroughSeq,
    });
    this.bump();
  }

  private upsertInfo(info: ThreadInfo): void {
    const existing = this.threads.get(info.threadId);
    if (existing === undefined) {
      this.threads.set(info.threadId, {
        info,
        events: [],
        lastSeq: -1,
        replayThroughSeq: Number.POSITIVE_INFINITY,
      });
      // Seed the unread floor at first observation so a renderer reload
      // doesn't unread every idle `ready` tab — the pulse means "advanced
      // WHILE you were elsewhere in this window", not "you just reloaded".
      if (!this.lastViewedByThread.has(info.threadId)) {
        this.lastViewedByThread.set(info.threadId, info.lastActivityAt);
      }
    } else if (info.archived === true && existing.info.archived !== true) {
      // Live → archived (server-side close/reap). The tab derivation drops it
      // and the retained events would only go stale — free them so a later
      // history open replays fresh from disk.
      this.openedArchived.delete(info.threadId);
      this.modelBuilders.delete(info.threadId);
      this.threads.set(info.threadId, {
        info,
        events: [],
        lastSeq: -1,
        replayThroughSeq: Number.POSITIVE_INFINITY,
      });
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

/**
 * Reactive "has activity the user hasn't seen since last viewing" flag.
 * True only on a settled `ready` tab whose `lastActivityAt` has advanced
 * past the recorded viewed timestamp — a running/error/permission status
 * already tells its own story on the tab's status dot.
 */
export function useAgentThreadUnread(threadId: string): boolean {
  const getSnapshot = () => client.getThreadUnread(threadId);
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
