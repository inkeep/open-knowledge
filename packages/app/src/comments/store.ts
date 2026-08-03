/**
 * Comment-thread store — a thin client cache over the server's comment API.
 *
 * Threads live in `.ok/local/comments/` and every mutation is server-mediated
 * (so writes carry attribution); this module holds the last-fetched view and
 * re-fetches when the server signals a change. It keeps the window-scoped
 * pub/sub idiom of `ask-ai-composer-events.ts` for the UI-only signals
 * (focus a thread, open a popover, start the composer).
 *
 * useSyncExternalStore contract: `getThreads(docName)` returns a referentially
 * stable array between refreshes — the array identity changes only when data
 * actually changes — so React's snapshot comparison never loops.
 *
 * Delivery (handing a comment to an agent) is NOT here: it needs the app's
 * Ask-AI handoff hook, which is React context. Callers pass their own hand-off
 * into {@link dispatchComments}; this module owns only the server round-trips
 * that bracket it (`dispatch-prepare-batch` → hand off → `dispatch-complete-batch`).
 */

import { t } from '@lingui/core/macro';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import type { DispatchPayload } from './comments-client';
import * as api from './comments-client';
import { revealQueue } from './reveal-queue';
import type { CommentThread } from './types';

const EMPTY: readonly CommentThread[] = Object.freeze([]);
const EMPTY_QUEUE: readonly string[] = Object.freeze([]);

const threadsByDoc = new Map<string, CommentThread[]>();
/** Project-wide view backing the queue (threads on docs you don't have open). */
let allThreads: CommentThread[] = [];
const listeners = new Set<() => void>();
const loadedDocs = new Set<string>();
let allLoaded = false;

/**
 * Which queued threads are checked for the next batch. Purely client-side: the
 * server records *queued*, the reviewer decides *selected*. Nothing to persist
 * — a selection is a decision about the click you are about to make.
 */
let deselected = new Set<string>();

/**
 * Write counters — the key every derived snapshot is cached against.
 *
 * `useSyncExternalStore` needs a getter that returns the same reference between
 * writes, and this is how the derived views get it: rebuild when the counter
 * moved, otherwise hand back what you built last time. What this replaces was
 * hand-comparing each view's fields, which went quietly stale on any field
 * nobody remembered to list and made adding a field to {@link CommentThread} a
 * two-place edit.
 *
 * Two counters rather than one because they are genuinely independent axes:
 * unchecking a queued comment changes what a send would carry, but the queue
 * itself is untouched, and collapsing them would churn the queue on every
 * checkbox.
 *
 * The remaining cost is coarseness: a refetch returning identical data still
 * counts as a write and still re-renders, where a content comparison could have
 * suppressed it. Comment writes are user-initiated clicks, not a stream, so that
 * is cheap — the same trade the ACP thread store makes.
 */
let version = 0;
let selectionVersion = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

/** The fetched thread data changed. */
function bump(): void {
  version += 1;
  notify();
}

/** Only the reviewer's checked subset changed. */
function bumpSelection(): void {
  selectionVersion += 1;
  notify();
}

// ---------------------------------------------------------------------------
// Server → UI mapping
// ---------------------------------------------------------------------------

/** Cover sheet → the display shape the panel renders. */
function toThread(meta: api.CommentThreadMeta): CommentThread {
  return {
    id: meta.threadId,
    docName: meta.docName,
    // Taken as-is: the response is schema-parsed at the client boundary, and the
    // schema defaults `target` to `body` and `path` to `[]`, so anything that
    // reaches here already has both.
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
    // The live comment rides the cover sheet — a thread renders as its current
    // request, and there is no history behind it to render.
    body: meta.latestComment,
    createdAt: meta.createdAt,
    // "Queued for the next batch" is what the UI shows as in-flight; the server
    // deliberately does not persist "an agent is working right now".
    queued: meta.queued,
  };
}

/**
 * Every thread in the project, in one request.
 *
 * This used to fetch the open doc's threads, then the project's threads, then
 * every thread's full event log — `2 + 2N` round trips per mutation, to render
 * a list that only ever shows each thread's newest comment. The server projects
 * that comment onto the cover sheet, so the project-wide list is a superset of
 * every per-doc view and one call serves all of them.
 */
async function fetchThreads(): Promise<CommentThread[]> {
  const metas = await api.listThreads();
  return metas.map(toThread).sort((a, b) => b.createdAt - a.createdAt);
}

/** Refresh every loaded view from one fetch. */
export async function refresh(docName?: string): Promise<void> {
  if (docName !== undefined) loadedDocs.add(docName);
  const nextAll = await fetchThreads();
  allThreads = nextAll;
  allLoaded = true;
  // Every per-doc cache is a slice of the same fetch, so a change made from the
  // queue panel shows up in an open doc's panel without a second round trip.
  for (const doc of loadedDocs) {
    threadsByDoc.set(
      doc,
      nextAll.filter((t) => t.docName === doc),
    );
  }
  // One write, one bump. The derived queue views rebuild off the new version on
  // whatever reads them next, so a subscriber reading during this same tick
  // cannot see them disagree with `allThreads`.
  bump();
}

/**
 * Refetch when the server says comments changed.
 *
 * Our own mutations already refresh themselves, so this is what carries a
 * change made anywhere else — a second window, or the queue panel in a doc this
 * tab doesn't have open. Installed on first read rather than at module scope:
 * the node test tier imports this module with no `window` to listen on.
 */
let cc1Installed = false;
function ensureCc1Subscription(): void {
  if (cc1Installed || typeof window === 'undefined') return;
  cc1Installed = true;
  subscribeToDocumentsChanged((channels) => {
    if (!channels.includes('comments')) return;
    // Quiet by design: this is a background signal nobody clicked, so a failed
    // refetch has no action attached to it and toasting would interrupt work
    // the user is doing elsewhere. The next signal re-syncs.
    void refresh().catch(() => undefined);
  });
}

/** Load a doc's threads once; subsequent refreshes come from mutations + CC1. */
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

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

/** React binding — re-renders whenever `docName`'s threads change. */
export function useCommentThreads(docName: string): readonly CommentThread[] {
  return useSyncExternalStore(
    subscribe,
    () => getThreads(docName),
    () => EMPTY,
  );
}

/** Look a thread up across every doc (the queue is project-wide). */
export function getThreadById(threadId: string): CommentThread | null {
  for (const threads of threadsByDoc.values()) {
    const found = threads.find((t) => t.id === threadId);
    if (found) return found;
  }
  return allThreads.find((t) => t.id === threadId) ?? null;
}

// ---------------------------------------------------------------------------
// Writes — each round-trips to the server, then refreshes
// ---------------------------------------------------------------------------

/**
 * Post a comment. The passage is identified by its quoted text — the editor has
 * ProseMirror positions, which are not the body offsets the server anchors
 * against, so the server locates the words itself. Queue-first: posting adds it
 * to the batch rather than dispatching on its own.
 */
export function createThread(args: {
  docName: string;
  quote: string;
  body: string;
  /** Rendered text either side of the pick — which occurrence, when the quote repeats. */
  prefix?: string;
  suffix?: string;
  /**
   * Runs once the server has accepted the comment, with its new id.
   *
   * A callback rather than a `dispatch` flag because sending goes through the
   * open-session path, which imports this module — doing it here would close an
   * import cycle. The sequencing still has to live behind the request: only this
   * side holds the id, and sending before the server accepts would hand an agent
   * a thread that failed to anchor.
   */
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
      // Voided + caught rather than left floating: it is NOT chained into the
      // outer `.catch` below, so a rejection here would surface as an unhandled
      // promise. A stale panel is the whole cost of a failed refetch, and the
      // next CC1 signal corrects it — the creation itself already succeeded.
      void refresh(args.docName).catch(() => undefined);
      if (args.onCreated !== undefined) {
        // Going straight to an agent: no queue reveal, because the comment is
        // not sitting in the queue waiting to be noticed.
        args.onCreated(meta.threadId);
        return;
      }
      // Only after the server accepted it. Revealing optimistically would open
      // the queue on a comment that then failed to anchor.
      revealQueue();
      emitCommentPosted();
    })
    .catch((err: unknown) => {
      // A failed post used to vanish — the comment simply never appeared, with
      // nothing to explain why. Surface it: the usual cause is a passage the
      // server can't locate in the document body.
      toast.error(
        err instanceof Error && err.message
          ? t`Couldn't add that comment: ${err.message}`
          : t`Couldn't add that comment.`,
      );
    });
}

/**
 * Post a comment on a frontmatter key. Same queue-first flow as a passage
 * comment — it joins the batch rather than dispatching on its own.
 *
 * The key is sent by name, so none of the passage machinery runs: no quote to
 * locate, no context to disambiguate, and no way to land on the wrong target.
 */
export function createPropertyThread(args: {
  docName: string;
  propertyKey: string;
  /** Steps into the value — one list item, one nested field. Omit for the value itself. */
  propertyPath?: (string | number)[];
  /** Selected text INSIDE the value. Omit to comment on the whole thing. */
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
      // Same as the passage path above: not chained into the outer `.catch`, so
      // it has to carry its own.
      void refresh(args.docName).catch(() => undefined);
      revealQueue();
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

/**
 * Every mutation's tail: refresh on success, SAY SO on failure.
 *
 * These used to end in `.catch(() => undefined)`. A rejected edit or delete then
 * looked exactly like a successful one — the card sat there unchanged and the
 * reviewer had no way to tell the server had refused. The message is the
 * server's own: `request` lifts the RFC 9457 `title`, which is where the comment
 * API puts its reasons ("The quoted passage is not in the document").
 */
function settle(promise: Promise<unknown>, docName: string | undefined, failed: string): void {
  void promise
    .then(() => refresh(docName))
    .catch((err: unknown) => {
      toast.error(err instanceof Error && err.message ? `${failed} ${err.message}` : failed);
      // Re-sync anyway: a rejection can still have changed server state (a
      // thread deleted by another window), and leaving the stale row on screen
      // would be a second, quieter lie.
      void refresh(docName).catch(() => undefined);
    });
}

export function editComment(threadId: string, body: string): void {
  const docName = getThreadById(threadId)?.docName;
  settle(api.editComment(threadId, body), docName, t`Couldn't save that edit.`);
}

export function resolveThread(threadId: string): void {
  const docName = getThreadById(threadId)?.docName;
  settle(api.resolveThread(threadId), docName, t`Couldn't resolve that comment.`);
}

export function reopenThread(threadId: string): void {
  const docName = getThreadById(threadId)?.docName;
  settle(api.reopenThread(threadId), docName, t`Couldn't reopen that comment.`);
}

/**
 * Delete a thread outright. Destructive: both files go, and the conversation
 * with them. The queue's ✕ only *unqueues* — this is the separate, explicit act.
 */
export function deleteThread(threadId: string): void {
  const docName = getThreadById(threadId)?.docName;
  settle(api.deleteThread(threadId), docName, t`Couldn't delete that comment.`);
}

/** Re-place an orphaned thread onto a fresh passage. */
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

// ---------------------------------------------------------------------------
// Queue — `queued` is server state; the checked subset is local UI state
// ---------------------------------------------------------------------------

/**
 * Derived queue arrays, cached against {@link version}.
 *
 * `useSyncExternalStore` compares snapshots with `Object.is`, so a getter that
 * builds a fresh array on every call reports a change on every render and loops
 * forever ("Maximum update depth exceeded"). Rebuilding only when the version
 * moved gives the stable reference without anyone having to enumerate which
 * fields count as a change — and `selected` derives from both `allThreads` and
 * `deselected`, which one counter already covers.
 */
let queueSnapshot: readonly string[] = EMPTY_QUEUE;
let queueSnapshotVersion = -1;
let selectedSnapshot: readonly string[] = EMPTY_QUEUE;
let selectedSnapshotVersion = -1;
let selectedSnapshotSelectionVersion = -1;

export function getQueue(): readonly string[] {
  ensureAllLoaded();
  if (queueSnapshotVersion !== version) {
    // OLDEST first — the order the comments were written, which is the order a
    // reviewer means by "these comments." `allThreads` is sorted newest-first
    // for the panel, and inheriting that sort silently numbered the composed
    // batch backwards. Display order and run order are different concerns, so
    // the queue sorts for itself.
    //
    // `createdAt` rather than the `queued` event's timestamp: posting a comment
    // queues it, so the two agree in practice, and the client no longer reads
    // event logs at all.
    const ids = allThreads
      .filter((t) => t.queued && t.status !== 'resolved')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => t.id);
    queueSnapshot = ids.length === 0 ? EMPTY_QUEUE : ids;
    queueSnapshotVersion = version;
  }
  return queueSnapshot;
}

export function useQueue(): readonly string[] {
  return useSyncExternalStore(subscribe, getQueue, () => EMPTY_QUEUE);
}

/** Queued minus whatever the reviewer unchecked — what a batch send actually ships. */
export function getSelectedQueue(): readonly string[] {
  const queued = getQueue();
  // Derives from both axes, so it rebuilds when either moves.
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

export function isQueued(threadId: string): boolean {
  return getQueue().includes(threadId);
}

export function addToQueue(threadId: string): void {
  const docName = getThreadById(threadId)?.docName;
  // Re-queuing clears any earlier deselection.
  if (deselected.has(threadId)) {
    const next = new Set(deselected);
    next.delete(threadId);
    deselected = next;
    bumpSelection();
  }
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

export function toggleQueue(threadId: string): void {
  if (isQueued(threadId)) removeFromQueue(threadId);
  else addToQueue(threadId);
}

/**
 * Re-check everything in the queue.
 *
 * Deselection is sticky — it lives in `deselected` until something clears it —
 * so "put the queue on this message" has to mean the WHOLE queue. Without this,
 * re-attaching after unchecking every item would attach a batch that carries
 * nothing, and the control would look broken twice over.
 */
export function selectAllQueued(): void {
  if (deselected.size === 0) return;
  deselected = new Set();
  bumpSelection();
}

/** Check / uncheck a queued item without removing it from the queue. */
export function toggleQueueSelection(threadId: string): void {
  const next = new Set(deselected);
  if (next.has(threadId)) next.delete(threadId);
  else next.add(threadId);
  deselected = next;
  bumpSelection();
}

export function clearQueue(): void {
  const ids = getQueue();
  if (ids.length === 0) return;
  // Per-item tolerance, then ONE report: clearing twenty comments must not fire
  // twenty toasts, but a partial clear cannot pass for a complete one either.
  void Promise.all(
    ids.map((id) =>
      api
        .unqueueThread(id)
        .then(() => true)
        .catch(() => false),
    ),
  ).then((results) => {
    const failed = results.filter((ok) => !ok).length;
    if (failed > 0) {
      toast.error(t`${failed} of ${ids.length} comments could not be cleared.`);
    }
    void refresh().catch(() => undefined);
  });
}

// ---------------------------------------------------------------------------
// Dispatch — the server brackets it; the app's Ask-AI plumbing delivers
// ---------------------------------------------------------------------------

/**
 * Hand a prepared batch to an agent. `true` when it landed, `false` when it did
 * not — a hand-off that never happened must not resolve its threads.
 *
 * Passed in per call rather than registered in a module slot. The slot version
 * was only installed while the Comments tab was mounted, which made the whole
 * dispatch path silently inert anywhere else and forced a second, unguarded
 * delivery route to exist alongside it.
 */
export type ComposeDispatch = (items: readonly BatchPreparedItem[]) => Promise<boolean>;

export interface BatchPreparedItem {
  threadId: string;
  payload: DispatchPayload;
}

/**
 * One dispatch at a time, across every surface that sends the queue.
 *
 * A send is not atomic: it awaits the server's anchor re-find, then the
 * hand-off, and only then does `completeDispatchBatch` drain what shipped. For
 * that whole window `getSelectedQueue()` still returns the same ids — so a
 * second Enter in the composer, or a second click on the queue panel's Send,
 * reads the identical batch and hands it to a second agent turn. Neither
 * surface disables its button across that window.
 *
 * Module scope so the flag spans surfaces rather than sitting in one component:
 * the composer and the panel drain ONE queue, and they must not race each
 * other either. Same shape as the launcher's `inflightLaunches`.
 */
let dispatchInFlight = false;

/**
 * THE dispatch path. Prepare the batch, hand it over, resolve what shipped.
 *
 * Every surface routes through here — the composer, the queue panel's send, and
 * the append-to-an-open-session path — so the re-entrancy guard, the
 * re-anchor-on-prepare, and the single `completeDispatchBatch` call site apply
 * to all of them rather than to whichever one remembered.
 *
 * Returns the ids that shipped, so a caller can clear its draft only on a real
 * send. A batch that fails to deliver leaves every thread queued.
 */
export async function dispatchComments({
  compose,
  threadIds,
  resolve = true,
}: {
  compose: ComposeDispatch;
  /**
   * Send exactly these instead of the checked queue — the selection composer
   * hands over the ONE comment just written, which is not in the checked set.
   */
  threadIds?: readonly string[];
  /**
   * Close the threads once handed over. True for a turn that RUNS: the agent
   * has it. False when the batch only lands staged in a live input — the human
   * still has to press enter, and marking work done that nobody has acted on is
   * the failure the queue exists to prevent.
   */
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
    // The send is over before it began, and the button gives no other feedback —
    // silence here read as "the click did nothing".
    toast.error(
      err instanceof Error && err.message
        ? t`Couldn't read the comments waiting to send: ${err.message}`
        : t`Couldn't read the comments waiting to send — nothing was sent.`,
    );
    return [];
  }
  // Prepare re-anchors, which can flip a thread to orphaned; surface that even
  // when the hand-off below fails.
  bump();
  const items = prepared.results.flatMap((item) =>
    item.ok ? [{ threadId: item.threadId, payload: item.payload }] : [],
  );
  if (items.length === 0) {
    // Every id came back missing — the threads were deleted between queueing and
    // now, which the re-sync below makes visible. Nothing failed, so nothing to
    // report.
    await refresh().catch(() => undefined);
    return [];
  }
  let delivered = false;
  try {
    delivered = await compose(items);
  } catch {
    // Leave them queued — a hand-off that never happened must not resolve.
    delivered = false;
  }
  const shipped = delivered ? items.map((item) => item.threadId) : [];
  if (shipped.length > 0 && resolve) {
    // The batch DID reach the agent; only the bookkeeping failed. Say which, or
    // the reviewer sees comments still sitting there to send and sends them a
    // second time.
    await api.completeDispatchBatch(shipped).catch(() => {
      toast.error(
        t`Sent, but the comments could not be marked done — they're still waiting to send.`,
      );
    });
  }
  // Background re-sync. Deliberately quiet: the send already reported itself,
  // and a failed refetch only means the panel is briefly stale, which the next
  // CC1 signal or panel open corrects.
  await refresh().catch(() => undefined);
  return shipped;
}

// ---------------------------------------------------------------------------
// UI-only signals (no server state)
// ---------------------------------------------------------------------------

const FOCUS_EVENT = 'ok:comment-focus-thread';
const POPOVER_EVENT = 'ok:comment-open-popover';
const START_EVENT = 'ok:comment-start';
const POSTED_EVENT = 'ok:comment-posted';

// The node-env unit tier imports this module and has no `window`, so touching
// these emitters there would throw. One module-level stand-in (not a per-call
// default) so subscribe and dispatch still meet on the same target.
const bus: EventTarget = typeof window === 'undefined' ? new EventTarget() : window;

export function emitFocusThread(threadId: string): void {
  bus.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: threadId }));
}

export function subscribeFocusThread(onFocus: (threadId: string) => void): () => void {
  const handler = (event: Event): void => onFocus((event as CustomEvent<string>).detail);
  bus.addEventListener(FOCUS_EVENT, handler);
  return () => bus.removeEventListener(FOCUS_EVENT, handler);
}

/**
 * Which thread the reader is on right now — its popover is open, or the pointer
 * is on its card or margin marker. `null` for none.
 *
 * This is what tells two comments sharing a passage apart. Every commented
 * passage carries the same pale wash, so overlapping ones read as one mark;
 * deepening the active thread's own range is what says which is which. Kept out
 * of {@link subscribe} deliberately — pointing at a comment must not re-render
 * every panel that reads the thread list.
 */
let pinnedThreadId: string | null = null;
let pointedThreadId: string | null = null;
let activeThreadId: string | null = null;
const activeListeners = new Set<() => void>();

/** Pointing at something wins over the open popover; it's the newer intent. */
function recomputeActive(): void {
  const next = pointedThreadId ?? pinnedThreadId;
  if (next === activeThreadId) return;
  activeThreadId = next;
  for (const listener of activeListeners) listener();
}

export function getActiveThread(): string | null {
  return activeThreadId;
}

/** Pointer or keyboard focus arrived on a thread's card or margin marker. */
export function setActiveThread(threadId: string | null): void {
  pointedThreadId = threadId;
  recomputeActive();
}

/**
 * Stand down only if this thread is still the pointed-at one — the pointer can
 * reach the next card before the last one's leave handler runs, and an
 * unconditional clear would blank the highlight that just lit up. An open
 * popover keeps its thread active underneath.
 */
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

/**
 * Which thread's in-doc popover is open — `null` for none.
 *
 * One signal both ways, rather than "open" one-way. The popover used to close
 * itself privately (Escape, outside click, thread resolved), so the margin rail
 * never learned about it: the rail kept a marker lit for a popover that was gone,
 * and could not tell whether clicking a marker should open or close.
 */
export function emitOpenThreadPopover(threadId: string | null): void {
  pinnedThreadId = threadId;
  recomputeActive();
  bus.dispatchEvent(new CustomEvent(POPOVER_EVENT, { detail: threadId }));
}

export function subscribeOpenThreadPopover(
  onChange: (threadId: string | null) => void,
): () => void {
  const handler = (event: Event): void => onChange((event as CustomEvent<string | null>).detail);
  bus.addEventListener(POPOVER_EVENT, handler);
  return () => bus.removeEventListener(POPOVER_EVENT, handler);
}

/**
 * A comment was successfully posted.
 *
 * The composer pins a selection until you send or dismiss it, deliberately, so
 * it survives clicking away into the input. But filing a comment means you are
 * DONE with that passage — leaving it pinned sends the same words to the agent
 * twice, once as the comment's quoted passage and once as an unrelated
 * in-scope selection.
 */
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
