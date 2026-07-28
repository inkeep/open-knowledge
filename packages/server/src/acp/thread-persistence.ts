/**
 * Durable transcript storage for ACP threads — `<dir>/threads/`.
 *
 * Two files per thread, both machine-local and never committed (transcripts
 * embed file diffs):
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
 * Location: threads live under a machine-global `~/.ok/threads/` so they
 * survive project-folder churn and are shared like `~/.ok/acp-agents` and
 * `~/.ok/runtimes`. Because that dir is shared across a machine's projects,
 * `scan()` returns only threads whose `meta.cwd` canonically matches this
 * server's contentDir (realpath-compared, so `/var`↔`/private/var` and
 * symlinks agree). A read-only LEGACY dir — the pre-move per-project
 * `<projectDir>/.ok/local/threads/` — is also scanned, UNFILTERED (it was
 * already project-scoped by its location); threads found there stay there for
 * every op (read, append, delete), never split across dirs, and no migration
 * runs. New threads always write to the global dir. With no global dir
 * configured (tests) the store is single-dir and behaves exactly as before.
 *
 * Trade-offs of the global dir: deleting a project folder no longer deletes
 * its transcripts (they orphan under the cwd filter), and transcripts leave
 * the project's own volume — accepted, matching how CLI agents keep sessions
 * globally; the per-project permission grants deliberately did NOT move.
 *
 * Appends ride the thread manager's 25 ms broadcast flush and are serialized
 * per thread through a promise chain, so line order == seq order without
 * locking. No fsync: a torn final line (crash mid-append) is detected and
 * dropped at read time; the line-index seq contract survives because tears
 * can only hit the tail of an append-only file.
 */

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

export interface ThreadPersistenceStoreOptions {
  /** Parent of the primary `threads/` dir — where new threads write and reads look first. */
  primaryDir: string;
  /** Parent of a read-only fallback `threads/` dir (pre-move per-project state), or null. */
  legacyDir?: string | null;
  /**
   * Canonical contentDir for cwd-scoping the shared primary dir: `scan()`
   * returns a primary-dir thread only when `realpath(meta.cwd)` matches
   * `realpath(cwd)`. Null disables filtering (single-dir / test mode); the
   * legacy dir is never cwd-filtered.
   */
  cwd?: string | null;
  log: PinoLogger;
}

export class ThreadPersistenceStore {
  /** `<primaryDir>/threads` — reads look here first; new threads write here. */
  private readonly primaryThreadsDir: string;
  /** `<legacyDir>/threads` read-only fallback, or null. */
  private readonly legacyThreadsDir: string | null;
  private readonly cwd: string | null;
  private readonly log: PinoLogger;
  /** Where NEW threads write. Normally the primary dir; falls back to legacy if the primary mkdir fails. */
  private writeThreadsDir: string;
  /** threadId → the `threads/` dir owning its files. Pinned at scan (rehydrated) or on first write (new). */
  private readonly homeByThread = new Map<string, string>();
  /** Per-thread write chains (events + meta) — order within a thread is the seq contract. */
  private readonly writeQueues = new Map<string, Promise<void>>();
  /** Threads whose appends already failed once — log once, don't spam. */
  private readonly appendBroken = new Set<string>();

  constructor(opts: ThreadPersistenceStoreOptions) {
    this.primaryThreadsDir = join(opts.primaryDir, THREADS_SUBDIR);
    this.legacyThreadsDir = opts.legacyDir != null ? join(opts.legacyDir, THREADS_SUBDIR) : null;
    this.cwd = opts.cwd ?? null;
    this.log = opts.log;
    this.writeThreadsDir = this.primaryThreadsDir;
  }

  /** The `threads/` dir that owns this thread's files (its home, else the write dir). */
  private threadsDirFor(threadId: string): string {
    return this.homeByThread.get(threadId) ?? this.writeThreadsDir;
  }

  /** Pin a not-yet-seen thread to the current write dir (called on first write). */
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
      // A bad / read-only HOME must not fail server boot. Degrade to the legacy
      // per-project dir when there is one (still writable — it's inside the
      // project); otherwise per-thread writes fail and degrade to memory-only.
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

  /**
   * Queue an event batch for append. Fire-and-forget by design — persistence
   * must never stall the live broadcast path; a failed append degrades to
   * memory-only behavior for that thread (logged once).
   */
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

  /** Queue a metadata snapshot write, serialized behind pending appends. */
  queueMetaWrite(threadId: string, meta: PersistedThreadMeta): void {
    this.pinHome(threadId);
    const body = `${JSON.stringify(meta, null, 1)}\n`;
    this.enqueue(threadId, async () => {
      const path = this.metaPath(threadId);
      const tmp = `${path}.tmp`;
      try {
        // tmp + rename so a concurrent scan (a sibling project's boot shares
        // the global dir) never reads a half-written meta.
        await tracedWriteFile(tmp, body);
        await tracedRename(tmp, path);
      } catch (err) {
        this.log.warn({ err, threadId }, '[acp-persist] meta write failed');
        try {
          // Don't leave a half-written `.tmp` behind to accumulate.
          await tracedRm(tmp, { force: true });
        } catch {
          // Best-effort cleanup — the failed write is already logged.
        }
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
    const metas: PersistedThreadMeta[] = [];
    const seen = new Set<string>();
    const canonCwd = this.cwd !== null ? await canonicalPath(this.cwd) : null;
    // Primary dir first so it wins any threadId collision with legacy.
    await this.scanDir(this.primaryThreadsDir, canonCwd, metas, seen);
    if (this.legacyThreadsDir !== null && this.legacyThreadsDir !== this.primaryThreadsDir) {
      await this.scanDir(this.legacyThreadsDir, null, metas, seen);
    }
    return metas;
  }

  /**
   * Read one dir's metas into `out`, recording each thread's home dir so later
   * ops resolve to the right files. A non-null `canonCwd` cwd-filters this dir
   * (realpath-compared); null admits all. `seen` is the per-scan dedup set —
   * a threadId an earlier dir already returned is skipped (primary wins).
   */
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
      // A missing dir is the normal case (no legacy threads yet, or a fresh
      // global dir). Anything else — EACCES on a locked-down HOME, EIO —
      // silently hides EVERY thread in it, so it has to be said out loud.
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
      if (seen.has(threadId)) continue; // an earlier dir already claimed it this scan
      if (canonCwd !== null && (await canonicalPath(meta.cwd)) !== canonCwd) continue;
      seen.add(threadId);
      // Record the home only if not already pinned (a live thread written this
      // session keeps its write-dir home).
      if (!this.homeByThread.has(threadId)) this.homeByThread.set(threadId, dir);
      out.push(meta);
    }
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
    // Resolve paths (via the home map) BEFORE forgetting the home. The two
    // removals are independent: `force` only swallows ENOENT, so a failing
    // events rm (EACCES/EIO) must not strand the meta on disk — the next
    // boot's scan would rehydrate the "deleted" thread as a phantom.
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

/** realpath, falling back to a lexical resolve when the path doesn't exist yet. */
async function canonicalPath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}
