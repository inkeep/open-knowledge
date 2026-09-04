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

function parseThreads(values: readonly unknown[]): CommentThreadMeta[] {
  const out: CommentThreadMeta[] = [];
  for (const value of values) {
    const parsed = CommentThreadMetaSchema.safeParse(value);
    if (parsed.success) out.push(parsed.data);
    else console.warn('[comments] skipped a thread this build cannot read', parsed.error.issues);
  }
  return out;
}

export async function listThreads(docName?: string): Promise<CommentThreadMeta[]> {
  const url =
    docName === undefined ? '/api/comments' : `/api/comments?doc=${encodeURIComponent(docName)}`;
  const { threads } = await request<{ threads: unknown[] }>(url);
  return parseThreads(threads);
}

export function createThread(input: {
  docName: string;
  quote?: string;
  prefix?: string;
  suffix?: string;
  start?: number;
  end?: number;
  propertyKey?: string;
  propertyPath?: (string | number)[];
  body: string;
  queue?: boolean;
}): Promise<CommentThreadMeta> {
  return request<unknown>('/api/comments', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then(parseThread);
}

export function editComment(threadId: string, body: string): Promise<CommentThreadMeta> {
  return mutate<unknown>({ action: 'edit', id: threadId, body }).then(parseThread);
}

export function reopenThread(threadId: string): Promise<CommentThreadMeta> {
  return mutate<unknown>({ action: 'reopen', id: threadId }).then(parseThread);
}

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

export function deleteThread(threadId: string): Promise<{ threadId: string }> {
  return request<unknown>(`/api/comment?id=${encodeURIComponent(threadId)}`, {
    method: 'DELETE',
  }).then((body) => parse(DeleteSuccessSchema, body));
}

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
