import { type ChildProcess, spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { PinoLogger } from '../logger.ts';
import {
  envPath,
  mergedEnv,
  overlaySetsPath,
  resolveWindowsCommand,
  terminateAgentTree,
  windowsCmdWrap,
  withHostedAgentMarker,
  withLoginShellPathEnv,
} from './launch.ts';

const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const TERMINAL_TRANSCRIPT_BYTE_CAP = 256 * 1024;
const TERMINAL_TRANSCRIPT_TAIL_BYTES = 16 * 1024;
const KILL_GRACE_MS = 2_000;
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
  output: string;
  outputBytes: number;
  byteLimit: number;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  exitWaiters: Array<(status: TerminalExitStatus) => void>;
  transcriptBytes: number;
  transcriptPaused: boolean;
  pausedTail: string;
}

function trimToCharBoundary(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && (buf[start] & 0b1100_0000) === 0b1000_0000) start++;
  return buf.subarray(start);
}

function tailBytes(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return text;
  return trimToCharBoundary(buf.subarray(buf.length - limit)).toString('utf8');
}

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
  private readonly loginShellPath: string | null;
  private disposed = false;

  constructor(opts: {
    defaultCwd: string;
    emit: (event: ThreadEvent) => void;
    log: PinoLogger;
    loginShellPath?: string | null;
  }) {
    this.defaultCwd = opts.defaultCwd;
    this.emit = opts.emit;
    this.log = opts.log;
    this.loginShellPath = opts.loginShellPath ?? null;
  }

  liveCount(): number {
    let count = 0;
    for (const record of this.terminals.values()) {
      if (record.exitStatus === null) count++;
    }
    return count;
  }

  create(params: CreateTerminalParams): { terminalId: string } {
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
    const env = withHostedAgentMarker(this.spawnEnv(overlay));
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
    let spawned = false;
    child.on('spawn', () => {
      spawned = true;
    });
    child.on('error', (err) => {
      if (spawned) {
        this.log.warn({ err, terminalId }, '[acp-terminals] child error after spawn');
        return;
      }
      onChunk(`${err.message}\n`);
      this.settleExit(terminalId, record, { exitCode: 127, signal: null });
    });
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

  async kill(terminalId: string): Promise<void> {
    const record = this.mustGet(terminalId);
    if (record.exitStatus !== null) return;
    await terminateAgentTree(record.child, { graceMs: KILL_GRACE_MS });
  }

  async release(terminalId: string): Promise<void> {
    const record = this.terminals.get(terminalId);
    if (record === undefined) return;
    if (record.exitStatus === null) {
      await terminateAgentTree(record.child, { graceMs: KILL_GRACE_MS });
    }
    this.terminals.delete(terminalId);
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    const ids = [...this.terminals.keys()];
    await Promise.allSettled(ids.map((id) => this.release(id)));
  }

  private spawnEnv(overlay: Record<string, string>): Record<string, string> {
    const env = mergedEnv(overlay);
    if (this.loginShellPath === null || overlaySetsPath(overlay)) return env;
    return withLoginShellPathEnv(env, this.loginShellPath);
  }

  private mustGet(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (record === undefined) throw new Error(`unknown terminal '${terminalId}'`);
    return record;
  }

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
    record.pausedTail = tailBytes(record.pausedTail + chunk, TERMINAL_TRANSCRIPT_TAIL_BYTES);
  }

  private settleExit(terminalId: string, record: TerminalRecord, status: TerminalExitStatus): void {
    if (record.exitStatus !== null) return;
    record.exitStatus = status;
    trimRecordToLimit(record);
    if (record.transcriptPaused && record.pausedTail !== '') {
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
