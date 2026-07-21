/**
 * ACP terminal surface — the client half of `terminal/*`. The agent asks OK
 * to run a command (`terminal/create`); OK spawns it, retains a byte-bounded
 * copy of its combined stdout+stderr, and answers `terminal/output` /
 * `terminal/wait_for_exit` / `terminal/kill` / `terminal/release` against the
 * live record. One `AcpTerminalSet` per thread; every spawned command dies
 * with its thread (close/exit/destroy) via {@link AcpTerminalSet.disposeAll}.
 *
 * Trust model: the command comes from the agent process, which already runs
 * arbitrary code with the user's privileges — executing it here grants
 * nothing new. What gates a command is the agent's own permission flow
 * (`session/request_permission`) before it calls `terminal/create`, exactly
 * as when the agent runs commands in-process.
 *
 * Transcript emission is bounded separately from the retained buffer: chunks
 * stream to the sink until {@link TERMINAL_TRANSCRIPT_BYTE_CAP}, then pause;
 * on exit the final tail of the retained buffer is emitted with a truncation
 * marker so the transcript always ends with the part that explains the exit
 * code. `terminal/output` (the agent-facing read) is never truncated beyond
 * the agent's own `outputByteLimit`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { PinoLogger } from '../logger.ts';
import {
  envPath,
  mergedEnv,
  resolveWindowsCommand,
  terminateAgentTree,
  windowsCmdWrap,
} from './launch.ts';

/** Retained-output default when the agent sends no `outputByteLimit`. */
const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
/** Live transcript budget per terminal, before emission pauses until exit. */
const TERMINAL_TRANSCRIPT_BYTE_CAP = 256 * 1024;
/** Tail of the paused (never-streamed) output replayed into the transcript on exit. */
const TERMINAL_TRANSCRIPT_TAIL_BYTES = 16 * 1024;
const KILL_GRACE_MS = 2_000;
/**
 * Defense-in-depth resource bound: each record holds a ChildProcess handle
 * plus a retained buffer, so a looping agent must not grow the map without
 * limit. Released terminals free their slot.
 */
const MAX_TERMINALS_PER_THREAD = 64;

export interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

export interface CreateTerminalParams {
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  cwd?: string | null;
  outputByteLimit?: number | null;
}

interface TerminalRecord {
  child: ChildProcess;
  /** Combined stdout+stderr, front-truncated to `byteLimit`. */
  output: string;
  outputBytes: number;
  byteLimit: number;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  exitWaiters: Array<(status: TerminalExitStatus) => void>;
  /** Bytes already streamed to the transcript sink. */
  transcriptBytes: number;
  transcriptPaused: boolean;
  /**
   * Tail of the output that arrived AFTER the transcript paused (never
   * streamed live), bounded to {@link TERMINAL_TRANSCRIPT_TAIL_BYTES}. The
   * exit-time replay sends exactly this — never bytes the live stream
   * already carried, so the transcript can't repeat itself.
   */
  pausedTail: string;
}

/**
 * Drop leading UTF-8 continuation bytes so a front-truncated buffer decodes
 * from a character boundary (the ACP contract for `outputByteLimit`).
 */
function trimToCharBoundary(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && (buf[start] & 0b1100_0000) === 0b1000_0000) start++;
  return buf.subarray(start);
}

/** Keep the last `limit` bytes of `text`, cutting on a character boundary. */
function tailBytes(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return text;
  return trimToCharBoundary(buf.subarray(buf.length - limit)).toString('utf8');
}

/**
 * Enforce the retained-output byte limit by dropping the buffer's front.
 * Called lazily (on read and on exit) plus amortized at 2× the limit during
 * ingestion — re-encoding the whole buffer per chunk would be quadratic on
 * the stream's hot path.
 */
function trimRecordToLimit(record: TerminalRecord): void {
  if (record.outputBytes <= record.byteLimit) return;
  const kept = trimToCharBoundary(
    Buffer.from(record.output, 'utf8').subarray(record.outputBytes - record.byteLimit),
  );
  record.output = kept.toString('utf8');
  record.outputBytes = kept.length;
  record.truncated = true;
}

export class AcpTerminalSet {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly emit: (event: ThreadEvent) => void;
  private readonly defaultCwd: string;
  private readonly log: PinoLogger;
  private disposed = false;

  constructor(opts: {
    /** Absolute directory commands run in when the agent sends no `cwd`. */
    defaultCwd: string;
    /** Transcript sink — the thread manager's `appendEvent`. */
    emit: (event: ThreadEvent) => void;
    log: PinoLogger;
  }) {
    this.defaultCwd = opts.defaultCwd;
    this.emit = opts.emit;
    this.log = opts.log;
  }

  /** Live (not yet exited) terminal count — a test/diagnostic seam. */
  liveCount(): number {
    let count = 0;
    for (const record of this.terminals.values()) {
      if (record.exitStatus === null) count++;
    }
    return count;
  }

  create(params: CreateTerminalParams): { terminalId: string } {
    // A create dispatched from the agent connection can race thread teardown
    // — after disposeAll, refusing is the only answer that doesn't spawn a
    // process nothing will ever kill.
    if (this.disposed) {
      throw new Error('thread is closing — no new terminals');
    }
    if (this.terminals.size >= MAX_TERMINALS_PER_THREAD) {
      throw new Error(
        `terminal limit reached (${MAX_TERMINALS_PER_THREAD} per thread) — release finished terminals first`,
      );
    }
    const terminalId = crypto.randomUUID();
    const overlay: Record<string, string> = {};
    for (const entry of params.env ?? []) overlay[entry.name] = entry.value;
    const env = mergedEnv(overlay);
    const cwd =
      params.cwd != null
        ? isAbsolute(params.cwd)
          ? params.cwd
          : resolve(this.defaultCwd, params.cwd)
        : this.defaultCwd;

    const win = process.platform === 'win32';
    const resolved = win ? resolveWindowsCommand(params.command, envPath(env)) : params.command;
    const wrap = win && /\.(cmd|bat)$/i.test(resolved);
    const { cmd, args } = wrap
      ? windowsCmdWrap(resolved, params.args ?? [])
      : { cmd: resolved, args: params.args ?? [] };
    // Group-leader on POSIX for the same reason agent spawns are: a shell
    // command's own children must die with it on kill/release.
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: !win,
      windowsHide: true,
      windowsVerbatimArguments: wrap,
    });

    const rawLimit = params.outputByteLimit;
    const record: TerminalRecord = {
      child,
      output: '',
      outputBytes: 0,
      byteLimit:
        typeof rawLimit === 'number' && rawLimit > 0
          ? Math.floor(rawLimit)
          : DEFAULT_OUTPUT_BYTE_LIMIT,
      truncated: false,
      exitStatus: null,
      exitWaiters: [],
      transcriptBytes: 0,
      transcriptPaused: false,
      pausedTail: '',
    };
    this.terminals.set(terminalId, record);
    this.safeEmit({
      kind: 'terminal_created',
      terminalId,
      command: params.command,
      args: params.args ?? [],
      ts: Date.now(),
    });

    const onChunk = (chunk: string): void => this.ingestChunk(terminalId, record, chunk);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', onChunk);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', onChunk);
    // 'error' also fires on a LIVE process when a later signal can't be
    // delivered (Node docs) — settling then would stamp a running command as
    // exited and make kill/release skip it forever. Only a pre-spawn failure
    // (ENOENT and friends) settles here; everything else waits for 'close'.
    let spawned = false;
    child.on('spawn', () => {
      spawned = true;
    });
    child.on('error', (err) => {
      if (spawned) {
        this.log.warn({ err, terminalId }, '[acp-terminals] child error after spawn');
        return;
      }
      // Surface it as output + a failed exit so the agent's `wait_for_exit`
      // never hangs on a process that never started.
      onChunk(`${err.message}\n`);
      this.settleExit(terminalId, record, { exitCode: 127, signal: null });
    });
    // 'close' (not 'exit'): it fires only after stdio has drained, so the
    // final output burst of a command is in the buffer before the exit
    // settles — 'exit' can beat the last 'data' events.
    child.on('close', (code, signal) => {
      this.settleExit(terminalId, record, { exitCode: code, signal });
    });
    return { terminalId };
  }

  output(terminalId: string): {
    output: string;
    truncated: boolean;
    exitStatus: TerminalExitStatus | null;
  } {
    const record = this.mustGet(terminalId);
    // Ingestion trims amortized (at 2× the limit); the agent-facing read is
    // where the exact `outputByteLimit` contract must hold.
    trimRecordToLimit(record);
    return {
      output: record.output,
      truncated: record.truncated,
      exitStatus: record.exitStatus,
    };
  }

  waitForExit(terminalId: string): Promise<TerminalExitStatus> {
    const record = this.mustGet(terminalId);
    if (record.exitStatus !== null) return Promise.resolve(record.exitStatus);
    return new Promise((resolvePromise) => {
      record.exitWaiters.push(resolvePromise);
    });
  }

  /** Kill the command (tree-wide) without dropping its retained output. */
  async kill(terminalId: string): Promise<void> {
    const record = this.mustGet(terminalId);
    if (record.exitStatus !== null) return;
    await terminateAgentTree(record.child, { graceMs: KILL_GRACE_MS });
  }

  /** Kill if still running, then drop the record entirely. */
  async release(terminalId: string): Promise<void> {
    const record = this.terminals.get(terminalId);
    if (record === undefined) return;
    if (record.exitStatus === null) {
      await terminateAgentTree(record.child, { graceMs: KILL_GRACE_MS });
    }
    this.terminals.delete(terminalId);
  }

  /** Thread teardown: kill every live command and drop all records. */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    const ids = [...this.terminals.keys()];
    await Promise.allSettled(ids.map((id) => this.release(id)));
  }

  private mustGet(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (record === undefined) throw new Error(`unknown terminal '${terminalId}'`);
    return record;
  }

  /**
   * Transcript emission is best-effort display data; it must never break the
   * control-flow contracts with the agent (`wait_for_exit` resolution) or
   * crash the stream 'data' handlers it is called from.
   */
  private safeEmit(event: ThreadEvent): void {
    try {
      this.emit(event);
    } catch (err) {
      this.log.warn({ err, kind: event.kind }, '[acp-terminals] transcript emit failed');
    }
  }

  private ingestChunk(terminalId: string, record: TerminalRecord, chunk: string): void {
    if (chunk === '') return;
    record.output += chunk;
    record.outputBytes += Buffer.byteLength(chunk, 'utf8');
    if (record.outputBytes > record.byteLimit * 2) {
      trimRecordToLimit(record);
    } else if (record.outputBytes > record.byteLimit) {
      // Over the limit but under the amortization threshold: the read path
      // (`output()`) trims exactly; only the flag must be truthful now.
      record.truncated = true;
    }
    if (!record.transcriptPaused) {
      const bytes = Buffer.byteLength(chunk, 'utf8');
      if (record.transcriptBytes + bytes <= TERMINAL_TRANSCRIPT_BYTE_CAP) {
        record.transcriptBytes += bytes;
        this.safeEmit({ kind: 'terminal_output', terminalId, chunk, ts: Date.now() });
        return;
      }
      record.transcriptPaused = true;
    }
    // Paused: accumulate ONLY never-streamed bytes for the exit-time replay,
    // keeping just the tail (bounded).
    record.pausedTail = tailBytes(record.pausedTail + chunk, TERMINAL_TRANSCRIPT_TAIL_BYTES);
  }

  private settleExit(terminalId: string, record: TerminalRecord, status: TerminalExitStatus): void {
    if (record.exitStatus !== null) return;
    record.exitStatus = status;
    trimRecordToLimit(record);
    if (record.transcriptPaused && record.pausedTail !== '') {
      // The live stream stopped at the cap — replay the tail of what was
      // never streamed so the transcript ends with the output that explains
      // the exit status, without repeating bytes it already carried.
      this.safeEmit({
        kind: 'terminal_output',
        terminalId,
        chunk: `\n… [output truncated — resuming at the end]\n${record.pausedTail}`,
        ts: Date.now(),
      });
    }
    this.safeEmit({
      kind: 'terminal_exit',
      terminalId,
      exitCode: status.exitCode,
      signal: status.signal,
      ts: Date.now(),
    });
    const waiters = record.exitWaiters;
    record.exitWaiters = [];
    for (const waiter of waiters) {
      try {
        waiter(status);
      } catch (err) {
        this.log.warn({ err, terminalId }, '[acp-terminals] exit waiter threw');
      }
    }
  }
}
