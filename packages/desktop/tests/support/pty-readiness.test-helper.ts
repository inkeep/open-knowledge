/**
 * Host probe + wait primitives shared by the real-shell PTY harness and its
 * contract tests.
 *
 * `createPtyHostProbe` wraps `setupPtyHost` in a recording `parentPort` and
 * exposes one `PtyStream` per PTY id, so a waiter can see both what the shell
 * has emitted and whether it failed.
 *
 * A PTY carries no "the shell is ready to read input" event. The first bytes a
 * terminal emits are its own setup paint, and on ConPTY that lands well before
 * the shell has attached a console input reader; anything written into that
 * window is dropped rather than buffered the way a POSIX tty's line discipline
 * would. So "some byte arrived" is spawn liveness, not readiness, and a caller
 * that treats it as readiness types into a shell that is not listening.
 * POSIX `waitForShellReady` therefore takes readiness to be "the stream
 * produced output and then stopped changing". The real Windows harness starts
 * each input-driven scenario with a structured launch marker instead: seeing
 * that marker proves PowerShell executed its startup command without injecting
 * an edit or control event into a line editor that may not exist yet.
 *
 * Every wait also watches the stream's failure channel, so a shell that dies or
 * never spawns aborts with its own reason instead of expiring as an anonymous
 * timeout that names only the condition nobody reached.
 */

import {
  type PtyHostIncomingMessage,
  type PtyHostOutgoingMessage,
  type SpawnPty,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';

/** One PTY's observable surface: its bytes, and its failure channel. */
export interface PtyStream {
  /** Everything this PTY has emitted so far. */
  read(): string;
  /** A description of a spawn failure or exit, once one has occurred. */
  failure(): string | null;
}

export interface PtyHostProbe {
  send(message: PtyHostIncomingMessage): void;
  streamOf(ptyId: string): PtyStream;
  dataOf(ptyId: string): string;
  exitOf(ptyId: string): { exitCode: number | undefined; signal: number | null } | null;
  errorOf(ptyId: string): string | null;
  killActive(): void;
}

export interface PtyHostProbeOptions {
  spawn: SpawnPty;
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  shellExists?: (path: string) => boolean;
}

export function createPtyHostProbe(options: PtyHostProbeOptions): PtyHostProbe {
  let handler: ((event: { data: unknown }) => void) | null = null;
  const data = new Map<string, string>();
  const exits = new Map<string, { exitCode: number | undefined; signal: number | null }>();
  const errors = new Map<string, string>();
  const handle = setupPtyHost({
    parentPort: {
      on(_event, h) {
        handler = h;
      },
      postMessage(msg: PtyHostOutgoingMessage) {
        if (msg.type === 'data') data.set(msg.ptyId, (data.get(msg.ptyId) ?? '') + msg.data);
        else if (msg.type === 'exit')
          exits.set(msg.ptyId, { exitCode: msg.exitCode, signal: msg.signal });
        else if (msg.type === 'spawn-error') errors.set(msg.ptyId, msg.message);
      },
    },
    spawn: options.spawn,
    env: options.env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    shellExists: options.shellExists,
  });
  const dataOf = (ptyId: string): string => data.get(ptyId) ?? '';
  const exitOf = (ptyId: string): { exitCode: number | undefined; signal: number | null } | null =>
    exits.get(ptyId) ?? null;
  const errorOf = (ptyId: string): string | null => errors.get(ptyId) ?? null;
  return {
    send: (msg) => handler?.({ data: msg }),
    dataOf,
    exitOf,
    errorOf,
    killActive: () => handle.killActive(),
    streamOf: (ptyId) => ({
      read: () => dataOf(ptyId),
      failure: () => {
        const error = errorOf(ptyId);
        if (error !== null) return `spawn-error: ${error}`;
        const exit = exitOf(ptyId);
        if (exit === null) return null;
        return `exited (code ${exit.exitCode ?? 'none'}, signal ${exit.signal ?? 'none'})`;
      },
    }),
  };
}

export interface WaitOptions {
  /** Budget before the awaited condition is declared unreachable. */
  timeoutMs?: number;
  /** Gap between samples. */
  intervalMs?: number;
}

export interface ShellReadyOptions extends WaitOptions {
  /** Consecutive unchanged samples required to call startup finished. */
  quietSamples?: number;
}

const DEFAULT_INTERVAL_MS = 15;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_READY_INTERVAL_MS = 50;
/** 20 samples x 50ms: a quiet window wide enough to span a cold shell's
 *  intra-startup stalls (profile load, module JIT) without reading one as the
 *  prompt. */
const DEFAULT_QUIET_SAMPLES = 20;
const DEFAULT_READY_TIMEOUT_MS = 12_000;
const RECEIVED_TAIL_CHARS = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The tail of what a PTY emitted, so a timeout says what it saw instead of
 *  discarding the only evidence that separates a dropped write from a dead
 *  shell. */
function describeReceived(text: string): string {
  if (text.length === 0) return 'nothing';
  const tail = text.length > RECEIVED_TAIL_CHARS ? text.slice(-RECEIVED_TAIL_CHARS) : text;
  return `${text.length > RECEIVED_TAIL_CHARS ? '...' : ''}${JSON.stringify(tail)}`;
}

export async function waitForCondition(
  stream: PtyStream,
  predicate: () => boolean,
  label: string,
  options: WaitOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (;;) {
    // Predicate before failure: a scenario that awaits an exit is satisfied by
    // the very event the failure channel reports, and must read it as success.
    if (predicate()) return;
    const failure = stream.failure();
    if (failure !== null) {
      throw new Error(`shell failed before ${label}: ${failure}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timeout waiting for: ${label} (received ${describeReceived(stream.read())})`,
      );
    }
    await sleep(intervalMs);
  }
}

export async function waitForShellReady(
  stream: PtyStream,
  label: string,
  options: ShellReadyOptions = {},
): Promise<void> {
  const quietSamples = options.quietSamples ?? DEFAULT_QUIET_SAMPLES;
  let previous: string | null = null;
  let stable = 0;
  await waitForCondition(
    stream,
    () => {
      const current = stream.read();
      stable = current.length > 0 && current === previous ? stable + 1 : 0;
      previous = current;
      return stable >= quietSamples;
    },
    label,
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      intervalMs: options.intervalMs ?? DEFAULT_READY_INTERVAL_MS,
    },
  );
}

/** Build a command whose relative file read proves the shell accepted the
 * requested cwd without relying on Windows path spelling or casing. */
export function buildCwdFileProofCommand(platform: NodeJS.Platform, fileName: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(fileName) || fileName === '.' || fileName === '..') {
    throw new Error(`invalid cwd proof file name: ${fileName}`);
  }
  if (platform === 'win32') {
    return `Write-Output "CWD_PROOF=$(Get-Content -Raw -LiteralPath './${fileName}')"`;
  }
  return `printf 'CWD_PROOF=%s\\n' "$(cat './${fileName}')"`;
}
