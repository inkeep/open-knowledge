/**
 * Typed fetch client for the comment routes (`/api/comments`, `/api/comment`).
 *
 * The app is the only client of this surface — agents reach comments through
 * the dispatch payload, not an API. Every mutation is server-mediated so writes
 * carry attribution; nothing here touches `.ok/` directly.
 */

/**
 * Cover-sheet projection returned by the server — the SAME schema the server
 * parses on disk, not a copy of it.
 *
 * This file used to restate the shape by hand, which meant every field added
 * server-side had to be mirrored here or the two silently disagreed at runtime.
 * That is how `target` and the nullable `anchor` both arrived: as a second edit
 * nobody was reminded to make.
 */
import {
  type CommentThreadMeta,
  CommentThreadMetaSchema,
  CompleteBatchSuccessSchema,
  DeleteSuccessSchema,
  type DispatchPayload,
  PrepareBatchSuccessSchema,
  ProblemDetailsSchema,
  QueueSuccessSchema,
} from '@inkeep/open-knowledge-core';

/**
 * Ingredients for handing a comment to an agent; the client composes the prompt.
 * Shared from core — this was a second hand-written duplicate, and `property`
 * had to be added to it and the server schema separately.
 */
export type { CommentThreadMeta, DispatchPayload };

export type BatchResult<T> =
  | ({ threadId: string; ok: true } & T)
  | { threadId: string; ok: false; error: 'not-found' };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    // Two-step RFC 9457 parse, the same shape every other fetching surface uses
    // (see GraphPanel / OutlinePanel): validate the problem body, fall back to
    // the status line when it is not one.
    //
    // `title` before `detail` is load-bearing here: `errorResponse` takes the
    // human-readable reason as its `title` argument and leaves `detail`
    // optional, so the comment API's messages — "The quoted passage is not in
    // the document" — live in `title`. Reading `detail` first got `undefined`
    // for every one of them and degraded each toast to a bare status code.
    const problem = ProblemDetailsSchema.safeParse(body);
    throw new Error(
      problem.success
        ? (problem.data.title ?? problem.data.detail)
        : `comments request failed (${res.status})`,
    );
  }
  return body as T;
}

function mutate<T>(body: unknown): Promise<T> {
  return request<T>('/api/comment', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Validate an envelope against its shared schema.
 *
 * Throws for the same reason {@link parseThread} does — the caller asked for a
 * specific result, and handing back an unvalidated one moves the failure far
 * from its cause. Only the LIST tolerates bad entries, because there the healthy
 * ones are still worth showing.
 */
function parse<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error('The server returned a response this build cannot read.');
  }
  return parsed.data;
}

function parseThread(value: unknown): CommentThreadMeta {
  const parsed = CommentThreadMetaSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('The server returned a comment thread this build cannot read.');
  }
  return parsed.data;
}

/**
 * Validate a LIST, dropping the entries that fail.
 *
 * Skipping rather than throwing, because the store on the other side already
 * works this way: an unreadable thread file is skipped, not migrated and not
 * fatal. One malformed thread must not blank the panel for every healthy one —
 * the same reasoning, applied one layer out.
 */
function parseThreads(values: readonly unknown[]): CommentThreadMeta[] {
  const out: CommentThreadMeta[] = [];
  for (const value of values) {
    const parsed = CommentThreadMetaSchema.safeParse(value);
    if (parsed.success) out.push(parsed.data);
    else console.warn('[comments] skipped a thread this build cannot read', parsed.error.issues);
  }
  return out;
}

/** Threads for one doc, or project-wide when `docName` is omitted (the queue view). */
export async function listThreads(docName?: string): Promise<CommentThreadMeta[]> {
  const url =
    docName === undefined ? '/api/comments' : `/api/comments?doc=${encodeURIComponent(docName)}`;
  const { threads } = await request<{ threads: unknown[] }>(url);
  return parseThreads(threads);
}

/**
 * Create a thread. Identify the passage by `quote` (what the rich-text editor
 * has — its ProseMirror positions are NOT body offsets) or by explicit body
 * offsets when the caller genuinely has them.
 */
export function createThread(input: {
  docName: string;
  quote?: string;
  /** Rendered text either side of the selection — which occurrence, when the quote repeats. */
  prefix?: string;
  suffix?: string;
  start?: number;
  end?: number;
  /**
   * Comment on a frontmatter key instead of a body passage. `quote` then refers
   * to text inside that VALUE rather than the body; omit it for the whole thing.
   */
  propertyKey?: string;
  /** Steps into the value: `[2]` for the third tag, `['name']` for a nested field. */
  propertyPath?: (string | number)[];
  body: string;
  /** Post straight into the dispatch queue (queue-first compose). */
  queue?: boolean;
}): Promise<CommentThreadMeta> {
  return request<unknown>('/api/comments', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then(parseThread);
}

/** Revise a thread's comment. Replaces the text — the previous one is not kept. */
export function editComment(threadId: string, body: string): Promise<CommentThreadMeta> {
  return mutate<unknown>({ action: 'edit', id: threadId, body }).then(parseThread);
}

export function resolveThread(threadId: string): Promise<CommentThreadMeta> {
  return mutate<unknown>({ action: 'resolve', id: threadId }).then(parseThread);
}

export function reopenThread(threadId: string): Promise<CommentThreadMeta> {
  return mutate<unknown>({ action: 'reopen', id: threadId }).then(parseThread);
}

/** Re-anchor an orphaned thread onto a fresh passage (by quote, or by offsets). */
export function replaceAnchor(
  threadId: string,
  passage: { quote?: string; prefix?: string; suffix?: string; start?: number; end?: number },
): Promise<CommentThreadMeta> {
  return mutate<unknown>({ action: 'replace', id: threadId, ...passage }).then(parseThread);
}

export function queueThread(
  threadId: string,
): Promise<{ meta: CommentThreadMeta; orphaned: boolean }> {
  return mutate<unknown>({ action: 'queue', id: threadId }).then((body) =>
    parse(QueueSuccessSchema, body),
  );
}

export function unqueueThread(threadId: string): Promise<CommentThreadMeta> {
  return mutate<unknown>({ action: 'unqueue', id: threadId }).then(parseThread);
}

/**
 * Delete a thread outright — destructive and irreversible. Distinct from
 * `unqueueThread` (drop from the batch, keep the comment) and `resolveThread`
 * (close it, keep the history).
 */
export function deleteThread(threadId: string): Promise<{ threadId: string }> {
  return request<unknown>(`/api/comment?id=${encodeURIComponent(threadId)}`, {
    method: 'DELETE',
  }).then((body) => parse(DeleteSuccessSchema, body));
}

/**
 * Batch dispatch. `ids` is the reviewer's checked selection in intended
 * run order; results come back in the same order, per item — one id that no
 * longer exists is reported rather than failing the batch.
 */
export function prepareDispatchBatch(
  ids: readonly string[],
): Promise<{ results: BatchResult<{ meta: CommentThreadMeta; payload: DispatchPayload }>[] }> {
  return mutate<unknown>({ action: 'dispatch-prepare-batch', ids }).then((body) =>
    parse(PrepareBatchSuccessSchema, body),
  );
}

export function completeDispatchBatch(
  ids: readonly string[],
): Promise<{ results: BatchResult<{ meta: CommentThreadMeta }>[] }> {
  return mutate<unknown>({ action: 'dispatch-complete-batch', ids }).then((body) =>
    parse(CompleteBatchSuccessSchema, body),
  );
}
