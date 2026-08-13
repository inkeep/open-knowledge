/**
 * Durable comment-thread storage — `<localDir>/comments/`, machine-local and
 * never committed (thread text can quote document content; same trust envelope
 * as the ACP thread store).
 *
 *   <threadId>.meta.json   the whole thread
 *
 * Writes are serialized per thread through a promise chain, so a read-modify-
 * write can't interleave with another one, and each write lands atomically
 * (tmp + rename). Together that means a thread on disk is always a complete
 * thread: the previous one or the next one, never a blend of the two.
 *
 * A crash therefore costs at most the transition being written — a resolve that
 * didn't stick — and never the thread itself. That matters because a thread's
 * identity (`docName`, `anchor`, `createdBy`, `createdAt`) exists only here and
 * cannot be reconstructed from anything else.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import { tracedAtomicFs, tracedMkdir, tracedRm } from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';
import {
  type Anchor,
  type CommentTarget,
  type CommentThreadMeta,
  CommentThreadMetaSchema,
  type CommentThreadPatch,
} from './types.ts';

const COMMENTS_SUBDIR = 'comments';

export interface CreateThreadInput {
  threadId: string;
  docName: string;
  target: CommentTarget;
  /** Null for a property target, which is located by key name rather than words. */
  anchor: Anchor | null;
  createdBy: string;
  createdAt: number;
  /** The opening comment. */
  body: string;
}

export class CommentThreadStore {
  private readonly dir: string;
  private readonly log: PinoLogger;
  /** Per-thread write chains, so a read-modify-write can't interleave. */
  private readonly writeQueues = new Map<string, Promise<void>>();
  /** Memoized directory creation — every write path awaits this, so boot order can't race. */
  private dirReady: Promise<void> | null = null;

  constructor(localDir: string, log: PinoLogger) {
    this.dir = join(localDir, COMMENTS_SUBDIR);
    this.log = log;
  }

  init(): Promise<void> {
    return this.ensureDir();
  }

  private ensureDir(): Promise<void> {
    this.dirReady ??= tracedMkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.dirReady;
  }

  metaPath(threadId: string): string {
    return join(this.dir, `${threadId}.meta.json`);
  }

  /**
   * Serialize a write task behind the thread's pending writes and resolve with
   * its result. Callers enter this queue SYNCHRONOUSLY (no await before the
   * call) so queue order is call order — see {@link update}.
   */
  private enqueueResult<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeQueues.get(threadId) ?? Promise.resolve();
    const run = prev.then(() => task());
    this.writeQueues.set(
      threadId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Resolve once every queued write for the thread has hit disk. */
  async whenIdle(threadId: string): Promise<void> {
    await (this.writeQueues.get(threadId) ?? Promise.resolve());
  }

  /** Create a thread: open, anchored, not queued, carrying its opening comment. */
  createThread(input: CreateThreadInput): Promise<CommentThreadMeta> {
    const meta: CommentThreadMeta = CommentThreadMetaSchema.parse({
      threadId: input.threadId,
      docName: input.docName,
      target: input.target,
      anchor: input.anchor,
      state: 'anchored',
      queued: false,
      latestComment: input.body,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
    });
    return this.enqueueResult(input.threadId, async () => {
      await this.ensureDir();
      await this.write(meta);
      return meta;
    });
  }

  /**
   * Apply a patch to a thread and persist it. Returns the updated thread, or
   * null if it is gone.
   *
   * Enters the per-thread write queue SYNCHRONOUSLY: the read, the merge, and
   * the write all happen inside the queued task, so two concurrent updates
   * cannot both read the same starting state and have the second overwrite the
   * first's field.
   */
  update(threadId: string, patch: CommentThreadPatch): Promise<CommentThreadMeta | null> {
    return this.enqueueResult(threadId, async () => {
      await this.ensureDir();
      const meta = await this.readMeta(threadId);
      if (!meta) return null;
      const updated = CommentThreadMetaSchema.parse({ ...meta, ...patchable(patch) });
      await this.write(updated);
      return updated;
    });
  }

  private write(meta: CommentThreadMeta): Promise<void> {
    return atomicWriteFile(this.metaPath(meta.threadId), serialize(meta), { fs: tracedAtomicFs });
  }

  /** Read one thread, or null if absent/unreadable/invalid. */
  async readMeta(threadId: string): Promise<CommentThreadMeta | null> {
    let raw: string;
    try {
      raw = await readFile(this.metaPath(threadId), 'utf8');
    } catch {
      return null;
    }
    const result = CommentThreadMetaSchema.safeParse(safeJson(raw));
    if (!result.success) {
      this.log.warn({ threadId }, '[comments] skipping unreadable thread meta');
      return null;
    }
    return result.data;
  }

  /**
   * Every thread on disk. This is what the boot index consumes; the cost is
   * O(#threads) small-file reads and nothing more.
   */
  async scanCoverSheets(): Promise<CommentThreadMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const metas: CommentThreadMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const meta = await this.readMeta(name.slice(0, -'.meta.json'.length));
      if (meta) metas.push(meta);
    }
    return metas;
  }

  async delete(threadId: string): Promise<void> {
    // ENQUEUED, not jumped ahead of. Dropping the queue entry and unlinking
    // immediately let a write that was already in flight finish afterwards and
    // recreate the thread that had just been deleted — serializing behind the
    // pending writes is the entire point of the per-thread chain.
    //
    // The map entry is deliberately left behind (holding a settled promise):
    // removing it here would let the NEXT enqueue for this id start a second,
    // parallel chain while an earlier one was still running.
    await this.enqueueResult(threadId, async () => {
      await tracedRm(this.metaPath(threadId), { force: true });
      // Threads written before the event log was dropped still have one sitting
      // beside them. Nothing reads it, but leaving it behind on delete would
      // keep a deleted thread's text on disk indefinitely.
      await tracedRm(join(this.dir, `${threadId}.ndjson`), { force: true });
    });
  }
}

/**
 * Keep only the fields a patch is allowed to touch, by naming them.
 *
 * The patch TYPE already excludes identity, but a type is a compile-time
 * promise and this data is the one place a thread's provenance exists. Picking
 * explicitly means a caller cannot rewrite who wrote a comment or when, whether
 * by mistake or through an `as` cast.
 */
function patchable(patch: CommentThreadPatch): CommentThreadPatch {
  const { docName, anchor, state, queued, latestComment, updatedAt } = patch;
  return {
    ...(docName !== undefined && { docName }),
    ...(anchor !== undefined && { anchor }),
    ...(state !== undefined && { state }),
    ...(queued !== undefined && { queued }),
    ...(latestComment !== undefined && { latestComment }),
    ...(updatedAt !== undefined && { updatedAt }),
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
