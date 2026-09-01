import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ThreadEvent, ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import {
  tracedAppendFile,
  tracedMkdir,
  tracedRename,
  tracedRm,
  tracedWriteFile,
} from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';

const THREADS_SUBDIR = 'threads';
const META_VERSION = 1;
const READ_CHUNK_SIZE = 512;

export interface PersistedThreadMeta {
  version: typeof META_VERSION;
  info: ThreadInfo;
  sessionId: string | null;
  cwd: string;
  agentRef: { source: 'registry' | 'custom'; id: string };
  docName?: string;
}

export interface ResolvedEventLog {
  count: number;
  midTurn: boolean;
}

export interface ThreadPersistenceStoreOptions {
  primaryDir: string;
  legacyDir?: string | null;
  cwd?: string | null;
  log: PinoLogger;
}

export class ThreadPersistenceStore {
  private readonly primaryThreadsDir: string;
  private readonly legacyThreadsDir: string | null;
  private readonly cwd: string | null;
  private readonly log: PinoLogger;
  private writeThreadsDir: string;
  private readonly homeByThread = new Map<string, string>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly appendBroken = new Set<string>();

  constructor(opts: ThreadPersistenceStoreOptions) {
    this.primaryThreadsDir = join(opts.primaryDir, THREADS_SUBDIR);
    this.legacyThreadsDir = opts.legacyDir != null ? join(opts.legacyDir, THREADS_SUBDIR) : null;
    this.cwd = opts.cwd ?? null;
    this.log = opts.log;
    this.writeThreadsDir = this.primaryThreadsDir;
  }

  private threadsDirFor(threadId: string): string {
    return this.homeByThread.get(threadId) ?? this.writeThreadsDir;
  }

  private pinHome(threadId: string): void {
    if (!this.homeByThread.has(threadId)) this.homeByThread.set(threadId, this.writeThreadsDir);
  }

  private enqueue(threadId: string, task: () => Promise<void>): void {
    const prev = this.writeQueues.get(threadId) ?? Promise.resolve();
    this.writeQueues.set(threadId, prev.then(task));
  }

  async init(): Promise<void> {
    try {
      await tracedMkdir(this.primaryThreadsDir, { recursive: true });
    } catch (err) {
      this.log.warn(
        { err, dir: this.primaryThreadsDir },
        '[acp-persist] primary threads dir unavailable',
      );
      if (this.legacyThreadsDir !== null) {
        this.writeThreadsDir = this.legacyThreadsDir;
        try {
          await tracedMkdir(this.legacyThreadsDir, { recursive: true });
        } catch (legacyErr) {
          this.log.error(
            { err: legacyErr, dir: this.legacyThreadsDir },
            '[acp-persist] legacy threads dir also unavailable; threads are memory-only',
          );
        }
      }
    }
  }

  eventsPath(threadId: string): string {
    return join(this.threadsDirFor(threadId), `${threadId}.ndjson`);
  }

  metaPath(threadId: string): string {
    return join(this.threadsDirFor(threadId), `${threadId}.meta.json`);
  }

  appendEvents(threadId: string, events: readonly ThreadEvent[]): void {
    if (events.length === 0 || this.appendBroken.has(threadId)) return;
    this.pinHome(threadId);
    const lines = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    this.enqueue(threadId, async () => {
      if (this.appendBroken.has(threadId)) return;
      try {
        await tracedAppendFile(this.eventsPath(threadId), lines);
      } catch (err) {
        this.appendBroken.add(threadId);
        this.log.error(
          { err, threadId },
          '[acp-persist] event append failed; thread continues memory-only',
        );
      }
    });
  }

  queueMetaWrite(threadId: string, meta: PersistedThreadMeta): void {
    this.pinHome(threadId);
    const body = `${JSON.stringify(meta, null, 1)}\n`;
    this.enqueue(threadId, async () => {
      const path = this.metaPath(threadId);
      const tmp = `${path}.tmp`;
      try {
        await tracedWriteFile(tmp, body);
        await tracedRename(tmp, path);
      } catch (err) {
        this.log.warn({ err, threadId }, '[acp-persist] meta write failed');
        try {
          await tracedRm(tmp, { force: true });
        } catch {}
      }
    });
  }

  whenIdle(threadId: string): Promise<void> {
    return this.writeQueues.get(threadId) ?? Promise.resolve();
  }

  async scan(): Promise<PersistedThreadMeta[]> {
    const metas: PersistedThreadMeta[] = [];
    const seen = new Set<string>();
    const canonCwd = this.cwd !== null ? await canonicalPath(this.cwd) : null;
    await this.scanDir(this.primaryThreadsDir, canonCwd, metas, seen);
    if (this.legacyThreadsDir !== null && this.legacyThreadsDir !== this.primaryThreadsDir) {
      await this.scanDir(this.legacyThreadsDir, null, metas, seen);
    }
    return metas;
  }

  private async scanDir(
    dir: string,
    canonCwd: string | null,
    out: PersistedThreadMeta[],
    seen: Set<string>,
  ): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn({ err, dir }, '[acp-persist] could not read a threads dir');
      }
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const path = join(dir, name);
      let parsed: Partial<PersistedThreadMeta>;
      try {
        parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PersistedThreadMeta>;
      } catch (err) {
        this.log.warn({ err, path }, '[acp-persist] skipping unreadable thread meta');
        continue;
      }
      if (
        parsed.version !== META_VERSION ||
        typeof parsed.info !== 'object' ||
        parsed.info === null ||
        typeof parsed.info.threadId !== 'string' ||
        typeof parsed.cwd !== 'string' ||
        typeof parsed.agentRef !== 'object' ||
        parsed.agentRef === null
      ) {
        this.log.warn({ path }, '[acp-persist] skipping unreadable thread meta');
        continue;
      }
      const meta = parsed as PersistedThreadMeta;
      const threadId = meta.info.threadId;
      if (seen.has(threadId)) continue;
      if (canonCwd !== null && (await canonicalPath(meta.cwd)) !== canonCwd) continue;
      seen.add(threadId);
      if (!this.homeByThread.has(threadId)) this.homeByThread.set(threadId, dir);
      out.push(meta);
    }
  }

  async resolveEventLog(threadId: string): Promise<ResolvedEventLog> {
    const path = this.eventsPath(threadId);
    if (!existsSync(path)) return { count: 0, midTurn: false };
    let count = 0;
    let midTurn = false;
    await this.forEachCompleteLine(path, (line) => {
      count += 1;
      if (line.startsWith('{"kind":"turn_started"')) midTurn = true;
      else if (line.startsWith('{"kind":"turn_ended"')) midTurn = false;
      return true;
    });
    return { count, midTurn };
  }

  async readEvents(
    threadId: string,
    fromSeq: number,
    toSeqExclusive: number,
    onChunk: (chunkFromSeq: number, events: ThreadEvent[]) => void,
  ): Promise<void> {
    const path = this.eventsPath(threadId);
    if (fromSeq >= toSeqExclusive || !existsSync(path)) return;
    let seq = 0;
    let chunk: ThreadEvent[] = [];
    let chunkFrom = fromSeq;
    const flush = (): void => {
      if (chunk.length === 0) return;
      onChunk(chunkFrom, chunk);
      chunkFrom += chunk.length;
      chunk = [];
    };
    await this.forEachCompleteLine(path, (line) => {
      if (seq >= toSeqExclusive) return false;
      if (seq >= fromSeq) {
        chunk.push(parseEventLine(line));
        if (chunk.length >= READ_CHUNK_SIZE) flush();
      }
      seq += 1;
      return true;
    });
    flush();
  }

  async delete(threadId: string): Promise<void> {
    this.appendBroken.delete(threadId);
    this.writeQueues.delete(threadId);
    const paths = [this.eventsPath(threadId), this.metaPath(threadId)];
    const results = await Promise.allSettled(paths.map((p) => tracedRm(p, { force: true })));
    this.homeByThread.delete(threadId);
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.log.warn(
          { err: result.reason, threadId, path: paths[i] },
          '[acp-persist] thread file removal failed',
        );
      }
    }
  }

  private async forEachCompleteLine(
    path: string,
    onLine: (line: string) => boolean,
  ): Promise<void> {
    const stream = createReadStream(path, { encoding: 'utf8' });
    let streamError: Error | null = null;
    stream.on('error', (err) => {
      streamError = err;
    });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    let endedWithNewline = false;
    let pending: string | null = null;
    let stopped = false;
    try {
      for await (const line of rl) {
        if (pending !== null && !onLine(pending)) {
          stopped = true;
          break;
        }
        pending = line;
      }
      if (!stopped) {
        endedWithNewline = await fileEndsWithNewline(path);
        if (pending !== null && endedWithNewline) onLine(pending);
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    if (streamError !== null) throw streamError;
  }
}

async function fileEndsWithNewline(path: string): Promise<boolean> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

function parseEventLine(line: string): ThreadEvent {
  try {
    return JSON.parse(line) as ThreadEvent;
  } catch {
    return { kind: 'agent_stderr', line: '[unreadable log entry]', ts: 0 };
  }
}

async function canonicalPath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}
