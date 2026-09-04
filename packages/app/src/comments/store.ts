import { t } from '@lingui/core/macro';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import type { DispatchPayload } from './comments-client';
import * as api from './comments-client';
import { revealComments } from './reveal-queue';
import type { CommentThread } from './types';

const EMPTY: readonly CommentThread[] = Object.freeze([]);
const EMPTY_QUEUE: readonly string[] = Object.freeze([]);

const threadsByDoc = new Map<string, CommentThread[]>();
let allThreads: CommentThread[] = [];
const listeners = new Set<() => void>();
const loadedDocs = new Set<string>();
let allLoaded = false;

let deselected = new Set<string>();

let version = 0;
let selectionVersion = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

function bump(): void {
  version += 1;
  notify();
}

function bumpSelection(): void {
  selectionVersion += 1;
  notify();
}

function toThread(meta: api.CommentThreadMeta): CommentThread {
  return {
    id: meta.threadId,
    docName: meta.docName,
    target: meta.target,
    anchor:
      meta.anchor === null
        ? null
        : {
            quote: meta.anchor.exact,
            prefix: meta.anchor.prefix,
            suffix: meta.anchor.suffix,
            start: meta.anchor.start,
            end: meta.anchor.end,
          },
    status: meta.state === 'anchored' ? 'open' : meta.state,
    body: meta.latestComment,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt ?? meta.createdAt,
    queued: meta.queued,
  };
}

async function fetchThreads(): Promise<CommentThread[]> {
  const metas = await api.listThreads();
  return metas.map(toThread).sort((a, b) => b.createdAt - a.createdAt);
}

export async function refresh(docName?: string): Promise<void> {
  if (docName !== undefined) loadedDocs.add(docName);
  const nextAll = await fetchThreads();
  allThreads = nextAll;
  allLoaded = true;
  for (const doc of loadedDocs) {
    threadsByDoc.set(
      doc,
      nextAll.filter((t) => t.docName === doc),
    );
  }
  bump();
  standDownIfGone(nextAll);
}

function standDownIfGone(threads: readonly CommentThread[]): void {
  if (openThreadId === null) return;
  if (threads.some((thread) => thread.id === openThreadId && thread.status === 'open')) return;
  emitOpenThread(null);
}

let cc1Installed = false;
function ensureCc1Subscription(): void {
  if (cc1Installed || typeof window === 'undefined') return;
  cc1Installed = true;
  subscribeToDocumentsChanged((channels) => {
    if (!channels.includes('comments')) return;
    void refresh().catch(() => undefined);
  });
}

function ensureLoaded(docName: string): void {
  ensureCc1Subscription();
  if (loadedDocs.has(docName)) return;
  loadedDocs.add(docName);
  void refresh(docName).catch(() => {
    loadedDocs.delete(docName);
  });
}

function ensureAllLoaded(): void {
  ensureCc1Subscription();
  if (allLoaded) return;
  allLoaded = true;
  void refresh().catch(() => {
    allLoaded = false;
  });
}

export function getThreads(docName: string): readonly CommentThread[] {
  ensureLoaded(docName);
  return threadsByDoc.get(docName) ?? EMPTY;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCommentThreads(docName: string): readonly CommentThread[] {
  return useSyncExternalStore(
    subscribe,
    () => getThreads(docName),
    () => EMPTY,
  );
}

export function getAllThreads(): readonly CommentThread[] {
  ensureAllLoaded();
  return allThreads;
}

export function useAllThreads(): readonly CommentThread[] {
  return useSyncExternalStore(subscribe, getAllThreads, () => EMPTY);
}

export function getThreadById(threadId: string): CommentThread | null {
  for (const threads of threadsByDoc.values()) {
    const found = threads.find((t) => t.id === threadId);
    if (found) return found;
  }
  return allThreads.find((t) => t.id === threadId) ?? null;
}

export function createThread(args: {
  docName: string;
  quote: string;
  body: string;
  prefix?: string;
  suffix?: string;
  onCreated?: (threadId: string) => void;
}): void {
  void api
    .createThread({
      docName: args.docName,
      quote: args.quote,
      prefix: args.prefix,
      suffix: args.suffix,
      body: args.body,
      queue: true,
    })
    .then((meta) => {
      void refresh(args.docName).catch(() => undefined);
      if (args.onCreated !== undefined) {
        args.onCreated(meta.threadId);
        return;
      }
      revealComments('doc', args.docName);
      emitCommentPosted();
    })
    .catch((err: unknown) => {
      toast.error(
        err instanceof Error && err.message
          ? t`Couldn't add that comment: ${err.message}`
          : t`Couldn't add that comment.`,
      );
    });
}

export function createPropertyThread(args: {
  docName: string;
  propertyKey: string;
  propertyPath?: (string | number)[];
  quote?: string;
  body: string;
}): void {
  void api
    .createThread({
      docName: args.docName,
      propertyKey: args.propertyKey,
      propertyPath: args.propertyPath,
      quote: args.quote,
      body: args.body,
      queue: true,
    })
    .then(() => {
      void refresh(args.docName).catch(() => undefined);
      revealComments('doc', args.docName);
      emitCommentPosted();
    })
    .catch((err: unknown) => {
      toast.error(
        err instanceof Error && err.message
          ? t`Couldn't add that comment: ${err.message}`
          : t`Couldn't add that comment.`,
      );
    });
}

function settle(promise: Promise<unknown>, docName: string | undefined, failed: string): void {
  void promise.then(
    () => {
      void refresh(docName).catch(() => undefined);
    },
    (err: unknown) => {
      toast.error(err instanceof Error && err.message ? `${failed} ${err.message}` : failed);
      void refresh(docName).catch(() => undefined);
    },
  );
}

export function editComment(threadId: string, body: string): void {
  const docName = getThreadById(threadId)?.docName;
  settle(api.editComment(threadId, body), docName, t`Couldn't save that edit.`);
}

export function reopenThread(threadId: string): void {
  const docName = getThreadById(threadId)?.docName;
  clearDeselection(threadId);
  settle(api.reopenThread(threadId), docName, t`Couldn't reopen that comment.`);
}

export function deleteThread(threadId: string): void {
  const docName = getThreadById(threadId)?.docName;
  settle(api.deleteThread(threadId), docName, t`Couldn't delete that comment.`);
}

export function replaceOrphan(
  threadId: string,
  quote: string,
  context?: { prefix: string; suffix: string },
): void {
  const docName = getThreadById(threadId)?.docName;
  settle(
    api.replaceAnchor(threadId, { quote, prefix: context?.prefix, suffix: context?.suffix }),
    docName,
    t`Couldn't re-place that comment.`,
  );
}

let queueSnapshot: readonly string[] = EMPTY_QUEUE;
let queueSnapshotVersion = -1;
let selectedSnapshot: readonly string[] = EMPTY_QUEUE;
let selectedSnapshotVersion = -1;
let selectedSnapshotSelectionVersion = -1;

export function getQueue(): readonly string[] {
  ensureAllLoaded();
  if (queueSnapshotVersion !== version) {
    const ids = allThreads
      .filter((t) => t.queued && t.status !== 'resolved')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => t.id);
    queueSnapshot = ids.length === 0 ? EMPTY_QUEUE : ids;
    queueSnapshotVersion = version;
  }
  return queueSnapshot;
}

export function getSelectedQueue(): readonly string[] {
  const queued = getQueue();
  if (
    selectedSnapshotVersion !== version ||
    selectedSnapshotSelectionVersion !== selectionVersion
  ) {
    const ids = queued.filter((id) => !deselected.has(id));
    selectedSnapshot = ids.length === 0 ? EMPTY_QUEUE : ids;
    selectedSnapshotVersion = version;
    selectedSnapshotSelectionVersion = selectionVersion;
  }
  return selectedSnapshot;
}

export function useQueueSelection(): readonly string[] {
  return useSyncExternalStore(subscribe, getSelectedQueue, () => EMPTY_QUEUE);
}

export function getSelectedQueueForDoc(docName: string): readonly string[] {
  return getSelectedQueue().filter((id) => getThreadById(id)?.docName === docName);
}

function clearDeselection(threadId: string): void {
  if (!deselected.has(threadId)) return;
  const next = new Set(deselected);
  next.delete(threadId);
  deselected = next;
  bumpSelection();
}

function addToQueue(threadId: string): void {
  const docName = getThreadById(threadId)?.docName;
  clearDeselection(threadId);
  settle(api.queueThread(threadId), docName, t`Couldn't mark that comment to send.`);
}

export function removeFromQueue(threadId: string): void {
  const docName = getThreadById(threadId)?.docName;
  settle(
    api.unqueueThread(threadId),
    docName,
    t`Couldn't unmark that comment — it's still waiting to send.`,
  );
}

export function toggleSending(threadId: string): void {
  if (getSelectedQueue().includes(threadId)) removeFromQueue(threadId);
  else addToQueue(threadId);
}

export function setSendingAll(threadIds: readonly string[], sending: boolean): void {
  const wanted = new Set(getSelectedQueue());
  const ids = threadIds.filter((id) => wanted.has(id) !== sending);
  if (ids.length === 0) return;
  if (sending && deselected.size > 0) {
    const next = new Set(deselected);
    for (const id of ids) next.delete(id);
    deselected = next;
    bumpSelection();
  }
  void Promise.all(
    ids.map((id) =>
      (sending ? api.queueThread(id) : api.unqueueThread(id)).then(
        () => true,
        () => false,
      ),
    ),
  ).then((results) => {
    const failed = results.filter((ok) => !ok).length;
    if (failed > 0) {
      toast.error(t`${failed} of ${ids.length} comments could not be updated.`);
    }
    void refresh().catch(() => undefined);
  });
}

export function toggleQueueSelection(threadId: string): void {
  const next = new Set(deselected);
  if (next.has(threadId)) next.delete(threadId);
  else next.add(threadId);
  deselected = next;
  bumpSelection();
}

export type ComposeDispatch = (items: readonly BatchPreparedItem[]) => Promise<boolean>;

export interface BatchPreparedItem {
  threadId: string;
  payload: DispatchPayload;
}

let dispatchInFlight = false;

export async function dispatchComments({
  compose,
  threadIds,
  resolve = true,
}: {
  compose: ComposeDispatch;
  threadIds?: readonly string[];
  resolve?: boolean;
}): Promise<string[]> {
  const ids = threadIds ?? getSelectedQueue();
  if (ids.length === 0) return [];
  if (dispatchInFlight) return [];
  dispatchInFlight = true;
  try {
    return await runDispatch(ids, compose, resolve);
  } finally {
    dispatchInFlight = false;
  }
}

async function runDispatch(
  ids: readonly string[],
  compose: ComposeDispatch,
  resolve: boolean,
): Promise<string[]> {
  let prepared: Awaited<ReturnType<typeof api.prepareDispatchBatch>>;
  try {
    prepared = await api.prepareDispatchBatch(ids);
  } catch (err) {
    toast.error(
      err instanceof Error && err.message
        ? t`Couldn't read the comments waiting to send: ${err.message}`
        : t`Couldn't read the comments waiting to send — nothing was sent.`,
    );
    return [];
  }
  bump();
  const items = prepared.results.flatMap((item) =>
    item.ok ? [{ threadId: item.threadId, payload: item.payload }] : [],
  );
  if (items.length === 0) {
    await refresh().catch(() => undefined);
    return [];
  }
  let delivered = false;
  try {
    delivered = await compose(items);
  } catch (err) {
    console.warn('[comments] dispatch compose failed; leaving threads queued', err);
    delivered = false;
  }
  const shipped = delivered ? items.map((item) => item.threadId) : [];
  if (shipped.length > 0 && resolve) {
    await api.completeDispatchBatch(shipped).catch(() => {
      toast.error(
        t`Sent, but the comments could not be marked done — they're still waiting to send.`,
      );
    });
  }
  await refresh().catch(() => undefined);
  return shipped;
}

const FOCUS_EVENT = 'open-knowledge:comment-focus-thread';
const OPEN_THREAD_EVENT = 'open-knowledge:comment-open-thread';
const START_EVENT = 'open-knowledge:comment-start';
const POSTED_EVENT = 'open-knowledge:comment-posted';

const bus: EventTarget = typeof window === 'undefined' ? new EventTarget() : window;

export function emitFocusThread(threadId: string): void {
  bus.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: threadId }));
}

export function subscribeFocusThread(onFocus: (threadId: string) => void): () => void {
  const handler = (event: Event): void => onFocus((event as CustomEvent<string>).detail);
  bus.addEventListener(FOCUS_EVENT, handler);
  return () => bus.removeEventListener(FOCUS_EVENT, handler);
}

let openThreadId: string | null = null;
let pointedThreadId: string | null = null;
let activeThreadId: string | null = null;
const activeListeners = new Set<() => void>();

function recomputeActive(): void {
  const next = pointedThreadId ?? openThreadId;
  if (next === activeThreadId) return;
  activeThreadId = next;
  for (const listener of activeListeners) listener();
}

export function getActiveThread(): string | null {
  return activeThreadId;
}

export function setActiveThread(threadId: string | null): void {
  pointedThreadId = threadId;
  recomputeActive();
}

export function clearActiveThread(threadId: string): void {
  if (pointedThreadId !== threadId) return;
  pointedThreadId = null;
  recomputeActive();
}

export function subscribeActiveThread(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}

export function useOpenThread(): string | null {
  return useSyncExternalStore(subscribeOpenThreadChanges, getOpenThread, () => null);
}

function subscribeOpenThreadChanges(listener: () => void): () => void {
  return subscribeOpenThread(() => listener());
}

export function getOpenThread(): string | null {
  return openThreadId;
}

export function emitOpenThread(threadId: string | null): void {
  openThreadId = threadId;
  recomputeActive();
  if (threadId !== null) requestDocPanelTab('comments');
  bus.dispatchEvent(new CustomEvent(OPEN_THREAD_EVENT, { detail: threadId }));
}

export function subscribeOpenThread(onChange: (threadId: string | null) => void): () => void {
  const handler = (event: Event): void => onChange((event as CustomEvent<string | null>).detail);
  bus.addEventListener(OPEN_THREAD_EVENT, handler);
  return () => bus.removeEventListener(OPEN_THREAD_EVENT, handler);
}

export function emitCommentPosted(): void {
  bus.dispatchEvent(new CustomEvent(POSTED_EVENT));
}

export function subscribeCommentPosted(onPosted: () => void): () => void {
  const handler = (): void => onPosted();
  bus.addEventListener(POSTED_EVENT, handler);
  return () => bus.removeEventListener(POSTED_EVENT, handler);
}

export function emitStartComment(): void {
  bus.dispatchEvent(new CustomEvent(START_EVENT));
}

export function subscribeStartComment(onStart: () => void): () => void {
  const handler = (): void => onStart();
  bus.addEventListener(START_EVENT, handler);
  return () => bus.removeEventListener(START_EVENT, handler);
}
