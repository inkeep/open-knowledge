/**
 * Comment orchestration — ties the store, the boot index, and the anchor
 * engine together and owns the anchor lifecycle (create, re-find on load,
 * explicit orphaning, re-placement) and the dispatch-queue storage side.
 *
 * Transport-agnostic: the HTTP routes (`comment-api.ts`) are thin adapters
 * over this. It reaches document text through an injected `getDocBody` so it
 * stays testable without a live CRDT. All state changes go through the store,
 * so the per-thread meta file stays the single source of truth.
 */

import { randomUUID } from 'node:crypto';
import { findAllPassages } from '@inkeep/open-knowledge-core';
import { bestByContext, createAnchor, literalSpans, refind } from './anchor.ts';
import type { CommentIndex } from './comment-index.ts';
import type { CommentThreadStore } from './thread-store.ts';
import type {
  Anchor,
  CommentTarget,
  CommentThreadMeta,
  CommentThreadPatch,
  PropertyPath,
} from './types.ts';

/** Body text of a doc (everything after frontmatter), or null if the doc is gone. */
export type GetDocBody = (docName: string) => Promise<string | null> | string | null;

/**
 * The doc's current frontmatter as a raw record, or null if the doc is gone.
 *
 * Values, not just keys: a property thread can point into a value (one tag, a
 * nested field) or at a passage inside one, so re-find has to walk the same
 * structure the comment addressed. Returning the record keeps that walk in the
 * service, next to the re-find it feeds, rather than splitting it across the
 * transport that supplies the document.
 */
export type GetDocFrontmatter = (
  docName: string,
) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;

/**
 * Walk a frontmatter record to the value a property target addresses.
 *
 * `undefined` for a path that no longer resolves — a renamed key, a list that
 * shrank past the index, a field that changed shape. Distinct from a value that
 * IS null, which resolves fine and is simply empty.
 */
function resolvePropertyPath(
  record: Record<string, unknown>,
  key: string,
  path: PropertyPath,
): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  let current: unknown = record[key];
  for (const step of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof step === 'number') {
      if (!Array.isArray(current) || step >= current.length) return undefined;
      current = current[step];
      continue;
    }
    if (typeof current !== 'object' || Array.isArray(current)) return undefined;
    const asRecord = current as Record<string, unknown>;
    if (!Object.hasOwn(asRecord, step)) return undefined;
    current = asRecord[step];
  }
  return current;
}

/**
 * The addressed value as anchorable TEXT, or null when there is none.
 *
 * Only scalars have text. A list or a map is structure — you comment on it as a
 * whole, or you address one of its members with a longer path — so returning a
 * serialization of it would invite anchoring into punctuation that no editor
 * ever showed the reader.
 */
function propertyValueText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export interface CommentServiceDeps {
  store: CommentThreadStore;
  index: CommentIndex;
  getDocBody: GetDocBody;
  getDocFrontmatter: GetDocFrontmatter;
  /** Injectable for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for deterministic tests; defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

export interface QueueResult {
  meta: CommentThreadMeta;
  /** True when the pre-dispatch re-find lost the anchor: the thread stays queued but is held (Q3). */
  orphaned: boolean;
}

/**
 * What the client needs to hand a comment to an agent.
 *
 * Ingredients, not a finished prompt: delivery targets differ (an in-app agent
 * thread, the docked terminal, a deep link into an external app) and the app's
 * existing Ask-AI composer already fits a passage to each target's transport and
 * budget — a deep link has a URL length limit a server-composed string would
 * blow past. So the server supplies the request and the passage; the client
 * builds the prompt with the machinery it already uses for Ask AI.
 */
interface DispatchPayload {
  docName: string;
  /** What the thread is asking for: its newest comment (edits supersede). */
  instruction: string;
  /**
   * The frontmatter key the comment is on, or null for a passage comment.
   *
   * A key is sent by NAME and nothing else. The passage machinery below exists
   * because prose has to be re-identified after it moves; a key is already the
   * identifier, so quoting its value would only give an agent a second, staler
   * copy of something it is about to read anyway.
   */
  property: string | null;
  /**
   * The anchored passage plus its stored context.
   *
   * Null when the comment is on a whole thing — a property with no quoted
   * passage. Present alongside `property` when the reviewer selected inside a
   * value, in which case these words are a passage in THAT value, not the body.
   */
  passage: { exact: string; prefix: string; suffix: string } | null;
  /**
   * The quoted text occurs more than once in the document.
   *
   * The agent gets the words, not an offset — offsets shift the moment it makes
   * its first edit in a batch — so a repeated quote is the one case where the
   * words alone cannot say which passage was meant. When this is set the client
   * spells out the surrounding context; when it is not, the extra prose would
   * only pad the prompt.
   */
  passageRepeats: boolean;
  /**
   * The passage could not be found in the document's current text.
   *
   * A lost anchor no longer blocks dispatch — the payload carries the quoted
   * words themselves, so the agent is not being pointed at a stale offset, and
   * it can see for itself what is and is not there. The flag exists so the
   * composer can say so explicitly: without it, an agent that cannot find the
   * passage may "fix" a different occurrence, or re-add text a rewrite
   * deliberately removed. That silent-wrong-target case is the one the
   * anchoring design exists to prevent, and naming it costs a line of prompt.
   */
  anchorLost: boolean;
}

export interface PrepareDispatchResult {
  meta: CommentThreadMeta;
  /** Always present — a lost anchor is sent with `payload.anchorLost` set, not withheld. */
  payload: DispatchPayload;
}

/**
 * One entry of a batch result. Per-item rather than all-or-nothing: a batch
 * carries ids the user selected earlier, and one that has since been deleted
 * must not take the rest of the batch down with it: a failure on one item
 * leaves the others intact and surfaces the failure in that item.
 */
export type BatchItem<T> =
  | ({ threadId: string; ok: true } & T)
  | { threadId: string; ok: false; error: 'not-found' };

/** Cheap "is this quote ambiguous" test — stops at the second hit. */
function occursMoreThanOnce(body: string, quote: string): boolean {
  if (quote === '') return false;
  const first = body.indexOf(quote);
  return first !== -1 && body.indexOf(quote, first + 1) !== -1;
}

export class DocNotFoundError extends Error {}
export class ThreadNotFoundError extends Error {}
/** The frontmatter key a property comment names is not in the document. */
export class PropertyNotFoundError extends Error {}
/** The quoted passage isn't in the document's body — the caller's selection is stale. */
export class PassageNotFoundError extends Error {}

export class CommentService {
  private readonly store: CommentThreadStore;
  private readonly index: CommentIndex;
  private readonly getDocBody: GetDocBody;
  private readonly getDocFrontmatter: GetDocFrontmatter;
  private readonly now: () => number;
  private readonly newId: () => string;
  /** Memoized lazy index build — the first index-touching call scans the cover sheets once. */
  private indexReady: Promise<void> | null = null;

  constructor(deps: CommentServiceDeps) {
    this.store = deps.store;
    this.index = deps.index;
    this.getDocBody = deps.getDocBody;
    this.getDocFrontmatter = deps.getDocFrontmatter;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * Build the doc -> threads index from the store's cover sheets, once. Every
   * index-touching method awaits this first, so the index is correct without a
   * separate boot step; the scan is memoized so it runs at most once per
   * process.
   */
  buildIndex(): Promise<void> {
    this.indexReady ??= this.index.build(this.store);
    return this.indexReady;
  }

  /**
   * Create an anchored thread on `[start, end)` of the doc's current body. The
   * anchor is measured against the live body so the write-time invariant holds
   * by construction. `body` is the opening comment.
   */
  async createThread(input: {
    docName: string;
    /**
     * Where the passage is. Either body offsets (a caller that already measured
     * against the markdown source, e.g. source mode) or the quoted text itself.
     *
     * The rich-text editor only has ProseMirror positions, which are NOT body
     * offsets — markdown syntax characters and the frontmatter region make the
     * two coordinate systems disagree. Rather than have every client attempt a
     * lossy conversion, it sends the words and the server locates them.
     */
    start?: number;
    end?: number;
    quote?: string;
    /**
     * Rendered text around the caller's selection. The one thing that says WHICH
     * occurrence was meant when the quoted words repeat.
     */
    prefix?: string;
    suffix?: string;
    /**
     * The frontmatter key to comment on, instead of a body passage.
     *
     * With no `quote`, the comment is on the addressed value as a whole. With
     * one, it is on that passage INSIDE the value — which is how a
     * paragraph-length field gets commented a sentence at a time, using the same
     * anchoring the body uses over a much smaller haystack.
     */
    propertyKey?: string;
    /** Steps into the key's value: `[2]` for the third tag, `['name']` for a field. */
    propertyPath?: PropertyPath;
    author: string;
    body: string;
    /**
     * Post straight into the dispatch queue (the queue-first compose flow):
     * posting a comment adds it to the batch you later send, rather than
     * dispatching it on its own.
     */
    queue?: boolean;
  }): Promise<CommentThreadMeta> {
    await this.buildIndex();
    const propertyKey = input.propertyKey;
    let target: CommentTarget;
    let anchor: Anchor | null;
    if (propertyKey === undefined) {
      const docBody = await this.requireDocBody(input.docName);
      const { start, end } = this.resolveRange(docBody, input);
      target = { kind: 'body' };
      anchor = createAnchor(docBody, start, end);
    } else {
      // An address that isn't there is refused rather than stored orphaned: the
      // only caller offers this on a row it is currently rendering, so a missing
      // key means the request and the document disagree — and a thread born
      // orphaned points at nothing a human ever chose.
      const path = input.propertyPath ?? [];
      target = { kind: 'property', key: propertyKey, path };
      const quote = input.quote?.trim();
      if (quote === undefined || quote.length === 0) {
        await this.requirePropertyTarget(input.docName, propertyKey, path);
        anchor = null;
      } else {
        // Anchored inside the value: same `createAnchor` the body uses, with the
        // value as the haystack, so the offsets it stores index that value and
        // never the document.
        const text = await this.requirePropertyText(input.docName, propertyKey, path);
        const { start, end } = this.resolveRange(text, input);
        anchor = createAnchor(text, start, end);
      }
    }
    const threadId = this.newId();
    const ts = this.now();
    const meta = await this.store.createThread({
      threadId,
      docName: input.docName,
      target,
      anchor,
      createdBy: input.author,
      createdAt: ts,
      body: input.body,
    });
    this.index.upsert(meta);
    if (input.queue !== true) return meta;
    // Queue-first compose: the comment joins the batch immediately. No
    // pre-dispatch re-find here — the anchor was just measured against the live
    // body, and the re-find that matters runs at `prepareDispatch`.
    return this.mutate(threadId, { queued: true });
  }

  /**
   * Cover sheets for threads. Pass a `docName` for one doc's threads; omit it
   * for the project-wide view the queue panel renders (comments queued on docs
   * you don't currently have open).
   *
   * Served entirely from the in-memory index — no disk reads. The app refetches
   * the whole project on every mutation and every push notification, so a
   * per-thread file read here made one click cost O(every comment ever made).
   */
  async listThreads(docName?: string): Promise<CommentThreadMeta[]> {
    await this.buildIndex();
    return docName === undefined ? this.index.listAll() : this.index.listForDoc(docName);
  }

  /**
   * Unresolved-thread counts, keyed by docName — the read-side signal agents
   * get through MCP enrichment. Pass `docNames` for an exact set (every name
   * gets an entry, 0 included) or `prefix` for a folder subtree (sparse — only
   * docs that carry threads).
   *
   * Counts rather than threads because the listing callers are per-file rows,
   * and shipping every comment body for a 200-file `ls` would dwarf the listing
   * it annotates. A reader that wants the text asks for the one doc.
   */
  async countThreads(
    scope: { docNames: readonly string[] } | { prefix: string },
  ): Promise<Map<string, number>> {
    await this.buildIndex();
    return 'prefix' in scope
      ? this.index.countsUnderPrefix(scope.prefix)
      : this.index.countsForDocs(scope.docNames);
  }

  /** One thread. */
  async readThread(threadId: string): Promise<CommentThreadMeta> {
    return this.requireMeta(threadId);
  }

  /**
   * Revise a thread's comment — it replaces the previous text. A thread holds
   * one comment that can be rewritten, not a discussion: the reader is an
   * agent, so refining the ask is the move that comes up, not replying.
   */
  /**
   * Revise a thread's comment. Replaces the text — a thread holds one comment
   * that can be rewritten, not a discussion.
   *
   * Takes no author. It used to, back when an append-only event log recorded who
   * wrote each revision; that log was dropped deliberately (see `types.ts`) and
   * the parameter outlived it, so callers were handing over attribution this
   * discarded. The ROUTE still requires a known actor before allowing the edit —
   * that is an identity gate, not attribution, and nothing here can record it.
   */
  async editComment(threadId: string, body: string): Promise<CommentThreadMeta> {
    return this.mutate(threadId, { latestComment: body });
  }

  async resolve(threadId: string): Promise<CommentThreadMeta> {
    return this.mutate(threadId, { state: 'resolved' });
  }

  /**
   * Reopen a closed thread. Its anchor state was not preserved under `resolved`
   * — deliberately, since a closed thread's anchor is moot — so the re-find
   * immediately re-establishes whether the passage is still there.
   */
  async reopen(threadId: string): Promise<CommentThreadMeta> {
    await this.mutate(threadId, { state: 'anchored' });
    return this.refindOnLoad(threadId);
  }

  /**
   * Human re-placement: re-anchor onto a fresh selection of the current
   * body and append `anchored` — the thread returns from orphaned.
   */
  async replaceAnchor(
    threadId: string,
    input: { start?: number; end?: number; quote?: string; prefix?: string; suffix?: string },
  ): Promise<CommentThreadMeta> {
    const meta = await this.requireMeta(threadId);
    // Re-placement moves a comment onto a fresh PASSAGE. A property thread that
    // lost its key is fixed by restoring the key or deleting the thread, not by
    // pointing it at prose — which would silently change what it is a comment on.
    if (meta.target.kind === 'property') {
      throw new PropertyNotFoundError(meta.target.key);
    }
    const docBody = await this.requireDocBody(meta.docName);
    const { start, end } = this.resolveRange(docBody, input);
    const anchor = createAnchor(docBody, start, end);
    return this.mutate(threadId, { anchor, state: 'anchored' });
  }

  /**
   * Ask-AI storage side (spec §Dispatch loop step 1): append `queued`, then
   * re-run re-find. If the anchor is lost the thread stays queued but held —
   * an `orphaned` event is appended and the caller must NOT start an agent turn
   * until a human re-places it. The actual agent turn (session correlation +
   * edit-landing stamp) is the ACP wiring, layered on top of this.
   */
  async queueForDispatch(threadId: string, docBody?: string | null): Promise<QueueResult> {
    await this.mutate(threadId, { queued: true });
    const state = await this.refindOnLoad(threadId, docBody);
    return { meta: state, orphaned: state.state === 'orphaned' };
  }

  /**
   * "Ask AI", step 1: queue the thread, verify the anchor still resolves, and
   * hand back what the client needs to deliver it.
   *
   * Delivery is the client's job because the target set is the app's, not the
   * server's — an in-app agent thread, the docked terminal, or a deep link into
   * an external app. Only the client can reach the latter two, and its Ask-AI
   * composer already fits a passage to each target's transport and budget.
   *
   * A lost anchor does not block the send; it is reported on the payload
   * (`anchorLost`) so the agent is told the passage is gone rather than left to
   * guess. The thread's own state still records the loss via the `orphaned`
   * event, so the UI can still offer re-placement.
   */
  async prepareDispatch(threadId: string): Promise<PrepareDispatchResult> {
    // One document read for the whole call. The pre-dispatch re-find and the
    // repeated-quote check both want the same body, and a batch runs this
    // sequentially per thread — two reads apiece is the batch's dominant cost
    // for information that hasn't changed between them.
    const docBody = await this.getDocBody((await this.requireMeta(threadId)).docName);
    const queued = await this.queueForDispatch(threadId, docBody);
    const { anchor, docName, target } = queued.meta;
    const instruction = await this.latestComment(threadId);
    if (target.kind === 'property') {
      return {
        meta: queued.meta,
        payload: {
          docName,
          instruction,
          property: describeTarget(target.key, target.path),
          passage:
            anchor === null
              ? null
              : { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix },
          anchorLost: queued.orphaned,
          // An address is unique within its frontmatter by construction, and a
          // quote inside one value has only that value to be confused with — the
          // client's locating note exists for a document-wide ambiguity that
          // cannot arise here.
          passageRepeats: false,
        },
      };
    }
    return {
      meta: queued.meta,
      payload: {
        docName,
        instruction,
        property: null,
        passage:
          anchor === null
            ? null
            : { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix },
        anchorLost: queued.orphaned,
        passageRepeats:
          anchor !== null && docBody !== null && occursMoreThanOnce(docBody, anchor.exact),
      },
    };
  }

  /**
   * "Ask AI", step 2: the client delivered it — close the thread.
   *
   * Closing on send (rather than when the agent's edit lands) is a deliberate
   * product call: the server has no reliable way to recognize *that agent's*
   * write — an ACP thread and its agent's MCP identity share no join key, and
   * agents commonly edit through their own file tools, which land with no agent
   * identity at all. Delivery to a terminal or an external app is one-way in any
   * case. The accepted tradeoff is that a thread closes even if the agent errors,
   * declines, or edits nothing; reopening is one click.
   *
   * If delivery failed, the client calls `unqueue` instead and the thread stays
   * open for a retry.
   */
  async completeDispatch(threadId: string): Promise<CommentThreadMeta> {
    return this.mutate(threadId, { queued: false, state: 'resolved' });
  }

  /**
   * Batch form of {@link prepareDispatch}: the reviewer selects which
   * queued comments to send, and the whole selection goes out in one action.
   *
   * `ids` order IS the intended run order — nothing stored carries a batch
   * ordering, so the caller's array is what supplies it and results come back
   * in the same order. Processed sequentially rather than concurrently so that
   * order is real.
   */
  async prepareDispatchBatch(ids: readonly string[]): Promise<BatchItem<PrepareDispatchResult>[]> {
    const out: BatchItem<PrepareDispatchResult>[] = [];
    for (const threadId of ids) {
      try {
        const result = await this.prepareDispatch(threadId);
        out.push({ threadId, ok: true, ...result });
      } catch (e) {
        if (e instanceof ThreadNotFoundError) {
          out.push({ threadId, ok: false, error: 'not-found' });
          continue;
        }
        throw e;
      }
    }
    return out;
  }

  /** Batch form of {@link completeDispatch}. Same per-item tolerance and ordering. */
  async completeDispatchBatch(
    ids: readonly string[],
  ): Promise<BatchItem<{ meta: CommentThreadMeta }>[]> {
    const out: BatchItem<{ meta: CommentThreadMeta }>[] = [];
    for (const threadId of ids) {
      try {
        out.push({ threadId, ok: true, meta: await this.completeDispatch(threadId) });
      } catch (e) {
        if (e instanceof ThreadNotFoundError) {
          out.push({ threadId, ok: false, error: 'not-found' });
          continue;
        }
        throw e;
      }
    }
    return out;
  }

  /**
   * What the thread is asking for — the live comment, which a reviewer may have
   * revised since opening it. Threads hold one comment that can be rewritten,
   * not a discussion, so an edit replaces the text outright and there are no
   * superseded drafts to pick between.
   */
  private async latestComment(threadId: string): Promise<string> {
    return (await this.requireMeta(threadId)).latestComment.trim();
  }

  /** Leave the queue without sending (human un-queue, or a concluded dispatch). */
  async unqueue(threadId: string): Promise<CommentThreadMeta> {
    return this.mutate(threadId, { queued: false });
  }

  async delete(threadId: string): Promise<void> {
    await this.buildIndex();
    await this.store.delete(threadId);
    this.index.remove(threadId);
  }

  /**
   * Follow a doc rename: re-point every thread on `from` to `to` in the
   * index and rewrite each affected cover sheet's `docName`. Wired into the
   * existing rename walk alongside the link/tag index renames. No stable doc id
   * in v1 — the rename is driven deliberately, name to name.
   */
  async renameDoc(from: string, to: string): Promise<void> {
    if (from === to) return;
    await this.buildIndex();
    const threadIds = this.index.threadsForDoc(from);
    if (threadIds.length === 0) return;
    this.index.renameDoc(from, to);
    await Promise.all(threadIds.map((id) => this.store.update(id, { docName: to })));
  }

  /**
   * Delete every thread on a doc, because the doc itself is gone. Returns how
   * many went.
   *
   * This is the one place the store destroys a comment the user did not ask it
   * to — and it is not the system inferring anything. Losing a *passage* is an
   * inference (the words moved, or we can't find them) and always orphans
   * rather than deletes. Losing the whole document is a fact.
   *
   * Keeping them would preserve nothing reachable: the panel needs the document
   * open and the queue only lists what is waiting to send, so a thread on a
   * deleted doc is invisible from every surface while still being sendable —
   * and a missing document reads as a healthy anchor, so it would go to an agent
   * claiming nothing was wrong.
   */
  async deleteDoc(docName: string): Promise<number> {
    await this.buildIndex();
    const threadIds = this.index.threadsForDoc(docName);
    for (const threadId of threadIds) {
      await this.store.delete(threadId);
      this.index.remove(threadId);
    }
    return threadIds.length;
  }

  /**
   * Re-anchor every open thread on a doc against its settled content, and
   * report whether any of them changed state.
   *
   * Comments are a derived view of document text, like backlinks and tags: a
   * passage that gets deleted has to read as orphaned, and one that comes back
   * has to recover. Without this the state only refreshed when a comment was
   * queued or dispatched, so deleting a commented passage left the comment
   * looking healthy — its highlight silently gone, the card unchanged — right
   * up until the moment you tried to send it.
   *
   * Cheap by construction on the path that runs constantly: it returns before
   * touching the document when the doc has no threads, and it writes only when
   * a thread actually crosses between anchored and orphaned. A passage that
   * merely moved is left alone — the position is a hint, and re-capturing it
   * on every settle would mean a write per thread per keystroke burst.
   */
  async refindDoc(docName: string): Promise<boolean> {
    await this.buildIndex();
    const threads = this.index.listForDoc(docName).filter((m) => m.state !== 'resolved');
    if (threads.length === 0) return false;
    const docBody = await this.getDocBody(docName);
    if (docBody === null) return false;
    // One read for the whole pass, and only when a property thread is actually
    // present — this runs on every settle, so the common all-body doc must not
    // pay for a frontmatter parse it has no use for.
    const frontmatter = threads.some((m) => m.target.kind === 'property')
      ? await this.getDocFrontmatter(docName)
      : null;

    let changed = false;
    for (const meta of threads) {
      let state: 'anchored' | 'orphaned';
      if (meta.target.kind === 'property') {
        // Unreadable frontmatter is not evidence the address is gone; skip,
        // exactly as an unreadable body leaves every body thread alone above.
        const result = await this.refindProperty(docName, meta.target, meta.anchor, frontmatter);
        if (result === null) continue;
        state = result.state;
      } else {
        // A body thread without an anchor is malformed rather than orphaned —
        // leave it as it is instead of reporting a loss the document didn't cause.
        if (meta.anchor === null) continue;
        state = refind(docBody, meta.anchor).status === 'anchored' ? 'anchored' : 'orphaned';
      }
      if (state === meta.state) continue;
      await this.mutate(meta.threadId, { state });
      changed = true;
    }
    return changed;
  }

  /**
   * Re-find a thread's anchor against the current body and reconcile state
   * (spec §5.2). A routine re-find that only moved the position updates the
   * cover-sheet hint SILENTLY (no event). Losing the spot appends `orphaned`;
   * recovering it appends `anchored`. Resolved threads are skipped — their
   * anchor is moot until reopened. Returns the (possibly updated) cover sheet.
   */
  async refindOnLoad(threadId: string, body?: string | null): Promise<CommentThreadMeta> {
    const meta = await this.requireMeta(threadId);
    if (meta.state === 'resolved') return meta;

    if (meta.target.kind === 'property') {
      const result = await this.refindProperty(meta.docName, meta.target, meta.anchor);
      if (result === null) return meta;
      // A moved passage inside a value updates its hint silently, exactly as the
      // body path does — only a crossing between anchored and orphaned is news.
      if (result.anchor === undefined && result.state === meta.state) return meta;
      return this.mutate(threadId, {
        ...(result.anchor ? { anchor: result.anchor } : {}),
        state: result.state,
      });
    }

    // `body` is a document already read by the caller, passed in so a dispatch
    // doesn't read the same document twice. Tri-state on purpose: `undefined`
    // means nobody has read it yet, `null` means it was read and is gone.
    const docBody = body !== undefined ? body : await this.getDocBody(meta.docName);
    if (docBody === null) return meta; // doc temporarily unavailable — leave state untouched

    // A body thread always carries an anchor; this narrows the nullable field
    // rather than asserting past it, so a malformed thread is left alone instead
    // of crashing the settle pass that re-finds every thread in the document.
    const bodyAnchor = meta.anchor;
    if (bodyAnchor === null) return meta;

    const result = refind(docBody, bodyAnchor);

    if (result.status === 'orphaned') {
      return meta.state === 'orphaned' ? meta : this.mutate(threadId, { state: 'orphaned' });
    }

    // Recovered from its brackets: the passage was EDITED, so the stored quote no
    // longer matches the document. Re-capture the whole anchor rather than only
    // the offsets — a stale `exact` would be handed to an agent as the passage
    // to act on, naming text that is not there any more.
    const anchor: Anchor | undefined = result.rewritten
      ? createAnchor(docBody, result.start, result.end)
      : result.start !== bodyAnchor.start || result.end !== bodyAnchor.end
        ? // Same words, new position: the cheap hint update.
          { ...bodyAnchor, start: result.start, end: result.end }
        : undefined;

    // A routine re-find that only moved the position is silent — the caller
    // sees a fresh hint, not a state change.
    if (anchor === undefined && meta.state === 'anchored') return meta;
    return this.mutate(threadId, { ...(anchor ? { anchor } : {}), state: 'anchored' });
  }

  /**
   * Apply a patch and return the updated thread, treating a vanished thread as
   * the error every caller here already handles.
   */
  private async mutate(threadId: string, patch: CommentThreadPatch): Promise<CommentThreadMeta> {
    const updated = await this.store.update(threadId, patch);
    if (!updated) throw new ThreadNotFoundError(threadId);
    // Every write funnels through here, which is what lets the index serve
    // reads without going back to disk.
    this.index.upsert(updated);
    return updated;
  }

  /**
   * Resolve a caller's passage reference to body offsets. Explicit offsets win;
   * otherwise the quote is located in the body — literally first, then treating
   * the body's markdown syntax as elastic, since the editor's callers only have
   * the passage as it RENDERS (`bold`, not `**bold**`; a bullet's text without
   * its `- `).
   *
   * A quote occurring more than once is decided by the context the caller
   * captured around its selection, scored the same way re-find scores its own
   * stored context. Taking the first occurrence instead would anchor the comment
   * to a passage nobody selected — and `createAnchor` would then widen the
   * context around THAT one until it was unambiguous, cementing the wrong
   * target with no signal that anything went wrong. A caller that sends no
   * context still lands on the first occurrence; there is nothing better to go on.
   */
  private resolveRange(
    docBody: string,
    input: { start?: number; end?: number; quote?: string; prefix?: string; suffix?: string },
  ): { start: number; end: number } {
    if (input.start !== undefined && input.end !== undefined) {
      return { start: input.start, end: input.end };
    }
    const quote = input.quote?.trim();
    if (quote === undefined || quote.length === 0) {
      throw new Error('either start/end offsets or a non-empty quote is required');
    }
    const literal = literalSpans(docBody, quote);
    // The caller's quote is the passage as the editor RENDERS it, so the body's
    // markdown syntax has to be treated as elastic — see `findAllPassages`.
    const hits =
      literal.length > 0 ? literal : findAllPassages(docBody, quote, { syntaxIn: 'haystack' });
    if (hits.length === 0) throw new PassageNotFoundError(quote);
    if (hits.length === 1) return hits[0];
    return bestByContext(docBody, hits, { prefix: input.prefix, suffix: input.suffix })[0];
  }

  private async requireMeta(threadId: string): Promise<CommentThreadMeta> {
    const meta = await this.store.readMeta(threadId);
    if (!meta) throw new ThreadNotFoundError(threadId);
    return meta;
  }

  private async requireDocBody(docName: string): Promise<string> {
    const body = await this.getDocBody(docName);
    if (body === null) throw new DocNotFoundError(docName);
    return body;
  }

  /**
   * The text a property target's anchor is measured against, for creating one.
   *
   * Throws rather than returning null so the create path reports WHICH thing was
   * missing: an unreadable doc, an address that no longer resolves, or a
   * container the caller tried to quote into.
   */
  private async requirePropertyText(
    docName: string,
    key: string,
    path: PropertyPath,
  ): Promise<string> {
    const record = await this.getDocFrontmatter(docName);
    if (record === null) throw new DocNotFoundError(docName);
    const value = resolvePropertyPath(record, key, path);
    if (value === undefined) throw new PropertyNotFoundError(describeTarget(key, path));
    const text = propertyValueText(value);
    if (text === null) throw new PropertyNotFoundError(describeTarget(key, path));
    return text;
  }

  /** Assert the address resolves, without requiring it to be quotable text. */
  private async requirePropertyTarget(
    docName: string,
    key: string,
    path: PropertyPath,
  ): Promise<void> {
    const record = await this.getDocFrontmatter(docName);
    if (record === null) throw new DocNotFoundError(docName);
    if (resolvePropertyPath(record, key, path) === undefined) {
      throw new PropertyNotFoundError(describeTarget(key, path));
    }
  }

  /**
   * Property re-find: does the address still resolve, and — when the thread
   * quoted a passage inside it — are those words still in that value?
   *
   * Two steps, cheapest first, mirroring the body path's ladder at a much
   * smaller scale. The address is exact, so step one cannot mis-target; step two
   * runs the ordinary anchor search over ONE value, where a repeated quote has
   * far less to be confused with than in a whole document.
   *
   * `null` when the document could not be read, which every caller treats as
   * "leave the state alone" — the same tri-state the body path uses, and for the
   * same reason: a doc that is momentarily unavailable must not orphan threads.
   */
  private async refindProperty(
    docName: string,
    target: Extract<CommentTarget, { kind: 'property' }>,
    anchor: Anchor | null,
    record?: Record<string, unknown> | null,
  ): Promise<{ state: 'anchored' | 'orphaned'; anchor?: Anchor } | null> {
    const fm = record !== undefined ? record : await this.getDocFrontmatter(docName);
    if (fm === null) return null;
    const value = resolvePropertyPath(fm, target.key, target.path);
    if (value === undefined) return { state: 'orphaned' };
    if (anchor === null) return { state: 'anchored' };

    const text = propertyValueText(value);
    // The address still resolves but no longer holds text — the field became a
    // list or a map. The quoted words are not there to be found, and inventing a
    // serialization to search would anchor into punctuation nobody ever saw.
    if (text === null) return { state: 'orphaned' };

    const result = refind(text, anchor);
    if (result.status === 'orphaned') return { state: 'orphaned' };
    if (result.rewritten) {
      return { state: 'anchored', anchor: createAnchor(text, result.start, result.end) };
    }
    if (result.start !== anchor.start || result.end !== anchor.end) {
      return { state: 'anchored', anchor: { ...anchor, start: result.start, end: result.end } };
    }
    return { state: 'anchored' };
  }
}

/** `tags`, `tags[2]`, `author.name` — how a property address reads to a human and an agent. */
function describeTarget(key: string, path: PropertyPath): string {
  let out = key;
  for (const step of path) out += typeof step === 'number' ? `[${step}]` : `.${step}`;
  return out;
}
