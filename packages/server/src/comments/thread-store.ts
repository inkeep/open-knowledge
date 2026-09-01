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
  anchor: Anchor | null;
  createdBy: string;
  createdAt: number;
  body: string;
}

export class CommentThreadStore {
  private readonly dir: string;
  private readonly log: PinoLogger;
  private readonly writeQueues = new Map<string, Promise<void>>();
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

  async whenIdle(threadId: string): Promise<void> {
    await (this.writeQueues.get(threadId) ?? Promise.resolve());
  }

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
    await this.enqueueResult(threadId, async () => {
      await tracedRm(this.metaPath(threadId), { force: true });
      await tracedRm(join(this.dir, `${threadId}.ndjson`), { force: true });
    });
  }
}

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
