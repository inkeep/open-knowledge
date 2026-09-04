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
  readonly events: readonly ThreadEvent[];
  readonly lastSeq: number;
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

const SEQ_GAP_EVENT: ThreadEvent = Object.freeze({
  kind: 'agent_stderr',
  line: '[missing log entry]',
  ts: 0,
});

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const CREATE_TIMEOUT_MS = 30_000;
const RESUME_TIMEOUT_MS = THREAD_REOPEN_OP_TIMEOUT_MS;
const RETRY_TIMEOUT_MS = THREAD_REOPEN_OP_TIMEOUT_MS;
const AUTHENTICATE_TIMEOUT_MS = 180_000;
const CHANNEL_WAIT_MS = 8_000;
const QUEUE_EDIT_TIMEOUT_MS = 10_000;

export class ThreadResumeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ThreadResumeError';
    this.code = code;
  }
}

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
  private openedArchived = new Set<string>();
  private lastViewedByThread = new Map<string, number>();
  private reqCounter = 0;
  private status: ThreadConnectionStatus = 'idle';
  private version = 0;

  markThreadViewed = (threadId: string): void => {
    const state = this.threads.get(threadId);
    if (state === undefined) return;
    if (state.info.status !== 'ready') return;
    const at = state.info.lastActivityAt;
    if (this.lastViewedByThread.get(threadId) === at) return;
    this.lastViewedByThread.set(threadId, at);
    this.bump();
  };

  getThreadUnread = (threadId: string): boolean => {
    const state = this.threads.get(threadId);
    if (state === undefined) return false;
    if (state.info.status !== 'ready') return false;
    const seen = this.lastViewedByThread.get(threadId);
    if (seen === undefined) return false;
    return state.info.lastActivityAt > seen;
  };

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

  private openTabsSnapshot: ThreadInfo[] = [];
  private openTabsSnapshotVersion = -1;
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

  getThread = (threadId: string): ThreadState | null => this.threads.get(threadId) ?? null;

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

  editQueued(threadId: string, id: string, content: string): Promise<void> {
    const trimmed = content.trim();
    if (trimmed === '') return Promise.resolve();
    this.reqCounter += 1;
    const reqId = `queue-edit-${this.reqCounter}`;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingQueueEdits.delete(reqId);
        resolve();
      }, QUEUE_EDIT_TIMEOUT_MS);
      this.pendingQueueEdits.set(reqId, { resolve, reject, timer });
    });
    this.send({ op: 'queue_edit', threadId, id, content: trimmed, reqId });
    return promise;
  }

  holdQueued(threadId: string, id: string, held: boolean): void {
    this.send({ op: 'queue_hold', threadId, id, held });
  }

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
    this.openedArchived.delete(threadId);
    this.modelBuilders.delete(threadId);
    if (this.threads.delete(threadId)) this.bump();
  }

  openArchivedThread(threadId: string): void {
    const state = this.threads.get(threadId);
    if (state === undefined || state.info.archived !== true) return;
    if (this.openedArchived.has(threadId)) return;
    this.openedArchived.add(threadId);
    this.send({ op: 'subscribe', threadId, sinceSeq: state.lastSeq + 1 });
    this.bump();
  }

  deleteThread(threadId: string): void {
    this.send({ op: 'delete', threadId });
    this.openedArchived.delete(threadId);
    this.modelBuilders.delete(threadId);
    if (this.threads.delete(threadId)) this.bump();
  }

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

  private connectNow(): void {
    if (this.url === null || this.ws !== null) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.connect();
  }

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
    ws.onerror = () => {};
  }

  private teardownSocket(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
      } catch {}
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
    } catch {}
  }

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
          if (!known && info.archived !== true) {
            this.send({ op: 'subscribe', threadId: info.threadId, sinceSeq: 0 });
          }
        }
        let dropped = false;
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
            toast.error(t`Message not sent: ${frame.message}`);
            return;
          }
        }
        console.warn('[agent-threads] server error frame:', frame.code, frame.message);
        return;
      }
      default:
        return;
    }
  }

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
      if (!this.lastViewedByThread.has(info.threadId)) {
        this.lastViewedByThread.set(info.threadId, info.lastActivityAt);
      }
    } else if (info.archived === true && existing.info.archived !== true) {
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

export function useAgentThreads(): ThreadInfo[] {
  return useSyncExternalStore(client.subscribe, client.getThreads, client.getThreads);
}

export function useOpenAgentThreadTabs(): ThreadInfo[] {
  return useSyncExternalStore(client.subscribe, client.getOpenTabs, client.getOpenTabs);
}

export function useArchivedAgentThreads(): ThreadInfo[] {
  return useSyncExternalStore(
    client.subscribe,
    client.getArchivedThreads,
    client.getArchivedThreads,
  );
}

export function useAgentThread(threadId: string): ThreadState | null {
  const getSnapshot = () => client.getThread(threadId);
  return useSyncExternalStore(client.subscribe, getSnapshot, getSnapshot);
}

export function useAgentThreadModel(threadId: string): ThreadRenderModel | null {
  const getSnapshot = () => client.getThreadModel(threadId);
  return useSyncExternalStore(client.subscribe, getSnapshot, getSnapshot);
}

export function useAgentThreadUnread(threadId: string): boolean {
  const getSnapshot = () => client.getThreadUnread(threadId);
  return useSyncExternalStore(client.subscribe, getSnapshot, getSnapshot);
}

export function useAgentThreadConnection(): ThreadConnectionStatus {
  return useSyncExternalStore(
    client.subscribe,
    client.getConnectionStatus,
    client.getConnectionStatus,
  );
}

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
