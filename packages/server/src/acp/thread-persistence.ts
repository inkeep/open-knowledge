/**
 * Durable transcript storage for ACP threads — `<localDir>/threads/`.
 *
 * Two files per thread, both machine-local and never committed (same trust
 * envelope as `acp-permissions.json` — transcripts embed file diffs):
 *
 *   <threadId>.ndjson     one ThreadEvent per line; LINE INDEX IS THE SEQ.
 *                         Every event a thread ever appends lands here (the
 *                         in-memory log keeps only a bounded window), so a
 *                         subscriber can replay from seq 0 after the memory
 *                         window trimmed or the record was rehydrated.
 *   <threadId>.meta.json  versioned ThreadInfo snapshot + the resume envelope
 *                         (sessionId, cwd, agent ref) — everything needed to
 *                         list a thread at boot and `session/resume` it later.
 *
 * Appends ride the thread manager's 25 ms broadcast flush and are serialized
 * per thread through a promise chain, so line order == seq order without
 * locking. No fsync: a torn final line (crash mid-append) is detected and
 * dropped at read time; the line-index seq contract survives because tears
 * can only hit the tail of an append-only file.
 */

import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ThreadEvent, ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { tracedAppendFile, tracedMkdir, tracedRm, tracedWriteFile } from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';

const THREADS_SUBDIR = 'threads';
const META_VERSION = 1;
/** Events per replay chunk delivered to `onChunk` (mirrors the WS replay chunking). */
const READ_CHUNK_SIZE = 512;

export interface PersistedThreadMeta {
  version: typeof META_VERSION;
  info: ThreadInfo;
  /** ACP sessionId from `session/new` — the resume handle. Null until the handshake completed. */
  sessionId: string | null;
  /** cwd the session was created with. Agents key their session stores by it — resume MUST pass it back verbatim. */
  cwd: string;
  agentRef: { source: 'registry' | 'custom'; id: string };
  docName?: string;
}

export interface ResolvedEventLog {
  /** Complete (newline-terminated) event lines on disk == the next seq to assign. */
  count: number;
  /** The log ends inside a turn (crash while streaming) — the resume path appends a synthetic `turn_ended`. */
  midTurn: boolean;
}

export class ThreadPersistenceStore {
  private readonly dir: string;
  private readonly log: PinoLogger;
  /** Per-thread write chains (events + meta) — order within a thread is the seq contract. */
  private readonly writeQueues = new Map<string, Promise<void>>();
  /** Threads whose appends already failed once — log once, don't spam. */
  private readonly appendBroken = new Set<string>();

  constructor(localDir: string, log: PinoLogger) {
    this.dir = join(localDir, THREADS_SUBDIR);
    this.log = log;
  }

  private enqueue(threadId: string, task: () => Promise<void>): void {
    const prev = this.writeQueues.get(threadId) ?? Promise.resolve();
    this.writeQueues.set(threadId, prev.then(task));
  }

  async init(): Promise<void> {
    await tracedMkdir(this.dir, { recursive: true });
  }

  eventsPath(threadId: string): string {
    return join(this.dir, `${threadId}.ndjson`);
  }

  metaPath(threadId: string): string {
    return join(this.dir, `${threadId}.meta.json`);
  }

  /**
   * Queue an event batch for append. Fire-and-forget by design — persistence
   * must never stall the live broadcast path; a failed append degrades to
   * memory-only behavior for that thread (logged once).
   */
  appendEvents(threadId: string, events: readonly ThreadEvent[]): void {
    if (events.length === 0 || this.appendBroken.has(threadId)) return;
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

  /** Queue a metadata snapshot write, serialized behind pending appends. */
  queueMetaWrite(threadId: string, meta: PersistedThreadMeta): void {
    const body = `${JSON.stringify(meta, null, 1)}\n`;
    this.enqueue(threadId, async () => {
      try {
        await tracedWriteFile(this.metaPath(threadId), body);
      } catch (err) {
        this.log.warn({ err, threadId }, '[acp-persist] meta write failed');
      }
    });
  }

  /** Resolve once every queued write for the thread has hit disk. */
  whenIdle(threadId: string): Promise<void> {
    return this.writeQueues.get(threadId) ?? Promise.resolve();
  }

  /**
   * List every persisted thread's metadata. Metadata only — event logs load
   * lazily on first subscribe/resume, so boot cost is O(#threads) small-file
   * reads. Unreadable or unknown-version files are skipped with a log line,
   * never a boot failure.
   */
  async scan(): Promise<PersistedThreadMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const metas: PersistedThreadMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const path = join(this.dir, name);
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PersistedThreadMeta>;
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
        metas.push(parsed as PersistedThreadMeta);
      } catch (err) {
        this.log.warn({ err, path }, '[acp-persist] skipping unreadable thread meta');
      }
    }
    return metas;
  }

  /**
   * Count the complete event lines on disk (== next seq) and whether the log
   * ends mid-turn. Streams without parsing: complete lines are exactly the
   * newline-terminated ones, and turn markers are recognized by their stable
   * serialized prefix (`kind` is always the first key we write).
   */
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

  /**
   * Replay persisted events for seqs `[fromSeq, toSeqExclusive)` in chunks.
   * Lines that fail to parse mid-file (should never happen in an append-only
   * log) are substituted with a harmless placeholder rather than skipped —
   * skipping would shift every later line off its seq.
   */
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
    await tracedRm(this.eventsPath(threadId), { force: true });
    await tracedRm(this.metaPath(threadId), { force: true });
  }

  /**
   * Iterate newline-TERMINATED lines only: readline emits a trailing line
   * without `\n` too, so the callback is buffered one line behind and the
   * final unterminated fragment (a torn append) never reaches it.
   */
  private async forEachCompleteLine(
    path: string,
    onLine: (line: string) => boolean,
  ): Promise<void> {
    const stream = createReadStream(path, { encoding: 'utf8' });
    // readline does not forward every input-stream error to its async
    // iterator — one emitted between pulls (file deleted mid-read by a
    // concurrent `delete()`, EIO) lands as an uncaught 'error' event on the
    // stream and would crash the process. Capture it here and rethrow below
    // so callers see a rejected op instead.
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
        // Whether the LAST line was complete needs the raw tail byte —
        // readline can't tell. Cheap check: the stream already ended; peek
        // via the stream's recorded bytes is gone, so re-read the final byte.
        endedWithNewline = await fileEndsWithNewline(path);
        if (pending !== null && endedWithNewline) onLine(pending);
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    // Checked on BOTH exits (exhausted and early-stop) — a partial read that
    // raced a stream error must read as failed, not as a clean prefix.
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
