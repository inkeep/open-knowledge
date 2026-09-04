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

export type GetDocBody = (docName: string) => Promise<string | null> | string | null;

export type GetDocFrontmatter = (
  docName: string,
) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;

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
  now?: () => number;
  newId?: () => string;
}

export interface QueueResult {
  meta: CommentThreadMeta;
  orphaned: boolean;
}

interface DispatchPayload {
  docName: string;
  instruction: string;
  property: string | null;
  passage: { exact: string; prefix: string; suffix: string } | null;
  passageRepeats: boolean;
  anchorLost: boolean;
}

export interface PrepareDispatchResult {
  meta: CommentThreadMeta;
  payload: DispatchPayload;
}

export type BatchItem<T> =
  | ({ threadId: string; ok: true } & T)
  | { threadId: string; ok: false; error: 'not-found' };

function occursMoreThanOnce(body: string, quote: string): boolean {
  if (quote === '') return false;
  const first = body.indexOf(quote);
  return first !== -1 && body.indexOf(quote, first + 1) !== -1;
}

export class DocNotFoundError extends Error {}
export class ThreadNotFoundError extends Error {}
export class PropertyNotFoundError extends Error {}
export class PassageNotFoundError extends Error {}

export class CommentService {
  private readonly store: CommentThreadStore;
  private readonly index: CommentIndex;
  private readonly getDocBody: GetDocBody;
  private readonly getDocFrontmatter: GetDocFrontmatter;
  private readonly now: () => number;
  private readonly newId: () => string;
  private indexReady: Promise<void> | null = null;

  constructor(deps: CommentServiceDeps) {
    this.store = deps.store;
    this.index = deps.index;
    this.getDocBody = deps.getDocBody;
    this.getDocFrontmatter = deps.getDocFrontmatter;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  buildIndex(): Promise<void> {
    this.indexReady ??= this.index.build(this.store);
    return this.indexReady;
  }

  async createThread(input: {
    docName: string;
    start?: number;
    end?: number;
    quote?: string;
    prefix?: string;
    suffix?: string;
    propertyKey?: string;
    propertyPath?: PropertyPath;
    author: string;
    body: string;
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
      const path = input.propertyPath ?? [];
      target = { kind: 'property', key: propertyKey, path };
      const quote = input.quote?.trim();
      if (quote === undefined || quote.length === 0) {
        await this.requirePropertyTarget(input.docName, propertyKey, path);
        anchor = null;
      } else {
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
    return this.mutate(threadId, { queued: true });
  }

  async listThreads(docName?: string): Promise<CommentThreadMeta[]> {
    await this.buildIndex();
    return docName === undefined ? this.index.listAll() : this.index.listForDoc(docName);
  }

  async countThreads(
    scope: { docNames: readonly string[] } | { prefix: string },
  ): Promise<Map<string, number>> {
    await this.buildIndex();
    return 'prefix' in scope
      ? this.index.countsUnderPrefix(scope.prefix)
      : this.index.countsForDocs(scope.docNames);
  }

  async readThread(threadId: string): Promise<CommentThreadMeta> {
    return this.requireMeta(threadId);
  }

  async editComment(threadId: string, body: string): Promise<CommentThreadMeta> {
    return this.mutate(threadId, { latestComment: body, updatedAt: this.now() });
  }

  async resolve(threadId: string): Promise<CommentThreadMeta> {
    return this.mutate(threadId, { state: 'resolved' });
  }

  async reopen(threadId: string): Promise<CommentThreadMeta> {
    await this.mutate(threadId, { state: 'anchored', queued: true });
    return this.refindOnLoad(threadId);
  }

  async replaceAnchor(
    threadId: string,
    input: { start?: number; end?: number; quote?: string; prefix?: string; suffix?: string },
  ): Promise<CommentThreadMeta> {
    const meta = await this.requireMeta(threadId);
    if (meta.target.kind === 'property') {
      throw new PropertyNotFoundError(meta.target.key);
    }
    const docBody = await this.requireDocBody(meta.docName);
    const { start, end } = this.resolveRange(docBody, input);
    const anchor = createAnchor(docBody, start, end);
    return this.mutate(threadId, { anchor, state: 'anchored' });
  }

  async queueForDispatch(threadId: string, docBody?: string | null): Promise<QueueResult> {
    await this.mutate(threadId, { queued: true });
    const state = await this.refindOnLoad(threadId, docBody);
    return { meta: state, orphaned: state.state === 'orphaned' };
  }

  async prepareDispatch(threadId: string): Promise<PrepareDispatchResult> {
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

  async completeDispatch(threadId: string): Promise<CommentThreadMeta> {
    return this.mutate(threadId, { queued: false, state: 'resolved' });
  }

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

  private async latestComment(threadId: string): Promise<string> {
    return (await this.requireMeta(threadId)).latestComment.trim();
  }

  async unqueue(threadId: string): Promise<CommentThreadMeta> {
    return this.mutate(threadId, { queued: false });
  }

  async delete(threadId: string): Promise<void> {
    await this.buildIndex();
    await this.store.delete(threadId);
    this.index.remove(threadId);
  }

  async renameDoc(from: string, to: string): Promise<void> {
    if (from === to) return;
    await this.buildIndex();
    const threadIds = this.index.threadsForDoc(from);
    if (threadIds.length === 0) return;
    this.index.renameDoc(from, to);
    await Promise.all(threadIds.map((id) => this.store.update(id, { docName: to })));
  }

  async deleteDoc(docName: string): Promise<number> {
    await this.buildIndex();
    const threadIds = this.index.threadsForDoc(docName);
    for (const threadId of threadIds) {
      await this.store.delete(threadId);
      this.index.remove(threadId);
    }
    return threadIds.length;
  }

  async refindDoc(docName: string): Promise<boolean> {
    await this.buildIndex();
    const threads = this.index.listForDoc(docName).filter((m) => m.state !== 'resolved');
    if (threads.length === 0) return false;
    const docBody = await this.getDocBody(docName);
    if (docBody === null) return false;
    const frontmatter = threads.some((m) => m.target.kind === 'property')
      ? await this.getDocFrontmatter(docName)
      : null;

    let changed = false;
    for (const meta of threads) {
      if (meta.target.kind === 'property') {
        const result = await this.refindProperty(docName, meta.target, meta.anchor, frontmatter);
        if (result === null) continue;
        if (result.state === meta.state) continue;
        await this.mutate(meta.threadId, { state: result.state });
        changed = true;
        continue;
      }
      if (meta.anchor === null) continue;
      const result = refind(docBody, meta.anchor);
      if (result.status === 'orphaned') {
        if (meta.state === 'orphaned') continue;
        await this.mutate(meta.threadId, { state: 'orphaned' });
        changed = true;
        continue;
      }
      const anchor =
        result.rewritten === true ? createAnchor(docBody, result.start, result.end) : undefined;
      const stateChanged = meta.state !== 'anchored';
      if (anchor === undefined && !stateChanged) continue;
      await this.mutate(meta.threadId, { ...(anchor ? { anchor } : {}), state: 'anchored' });
      if (stateChanged || anchor !== undefined) changed = true;
    }
    return changed;
  }

  async refindOnLoad(threadId: string, body?: string | null): Promise<CommentThreadMeta> {
    const meta = await this.requireMeta(threadId);
    if (meta.state === 'resolved') return meta;

    if (meta.target.kind === 'property') {
      const result = await this.refindProperty(meta.docName, meta.target, meta.anchor);
      if (result === null) return meta;
      if (result.anchor === undefined && result.state === meta.state) return meta;
      return this.mutate(threadId, {
        ...(result.anchor ? { anchor: result.anchor } : {}),
        state: result.state,
      });
    }

    const docBody = body !== undefined ? body : await this.getDocBody(meta.docName);
    if (docBody === null) return meta;

    const bodyAnchor = meta.anchor;
    if (bodyAnchor === null) return meta;

    const result = refind(docBody, bodyAnchor);

    if (result.status === 'orphaned') {
      return meta.state === 'orphaned' ? meta : this.mutate(threadId, { state: 'orphaned' });
    }

    const anchor: Anchor | undefined = result.rewritten
      ? createAnchor(docBody, result.start, result.end)
      : result.start !== bodyAnchor.start || result.end !== bodyAnchor.end
        ? { ...bodyAnchor, start: result.start, end: result.end }
        : undefined;

    if (anchor === undefined && meta.state === 'anchored') return meta;
    return this.mutate(threadId, { ...(anchor ? { anchor } : {}), state: 'anchored' });
  }

  private async mutate(threadId: string, patch: CommentThreadPatch): Promise<CommentThreadMeta> {
    const updated = await this.store.update(threadId, patch);
    if (!updated) throw new ThreadNotFoundError(threadId);
    this.index.upsert(updated);
    return updated;
  }

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

function describeTarget(key: string, path: PropertyPath): string {
  let out = key;
  for (const step of path) out += typeof step === 'number' ? `[${step}]` : `.${step}`;
  return out;
}
