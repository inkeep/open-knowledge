import {
  type PtyHostIncomingMessage,
  type PtyHostOutgoingMessage,
  type SpawnPty,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';

export interface PtyStream {
  read(): string;
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
  timeoutMs?: number;
  intervalMs?: number;
}

export interface ShellReadyOptions extends WaitOptions {
  quietSamples?: number;
}

const DEFAULT_INTERVAL_MS = 15;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_READY_INTERVAL_MS = 50;
const DEFAULT_QUIET_SAMPLES = 20;
const DEFAULT_READY_TIMEOUT_MS = 12_000;
const RECEIVED_TAIL_CHARS = 400;
const DEFAULT_INPUT_READY_ATTEMPTS = 4;
const DEFAULT_INPUT_READY_TIMEOUT_MS = 4_000;
const INPUT_READY_RESET_FROM_ATTEMPT = 2;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

export const INPUT_READY_RESET = '\u0003';

export interface EvaluatedInputProbe {
  input: string;
  marker: string;
  reset: string;
}

export interface EvaluatedInputOptions extends WaitOptions {
  attempts?: number;
}

export async function waitForEvaluatedInput(
  stream: PtyStream,
  send: (data: string) => void,
  probe: EvaluatedInputProbe,
  label: string,
  options: EvaluatedInputOptions = {},
): Promise<number> {
  if (probe.input.includes(probe.marker)) {
    throw new Error(`readiness probe input must not contain its marker: ${probe.marker}`);
  }
  const attempts = options.attempts ?? DEFAULT_INPUT_READY_ATTEMPTS;
  const waitOptions: WaitOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_INPUT_READY_TIMEOUT_MS,
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
  };
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt >= INPUT_READY_RESET_FROM_ATTEMPT) send(probe.reset);
    send(probe.input);
    try {
      await waitForCondition(
        stream,
        () => stream.read().includes(probe.marker),
        label,
        waitOptions,
      );
      return attempt + 1;
    } catch (error) {
      lastError = error as Error;
      if (stream.failure() !== null) throw lastError;
    }
  }
  const detail = lastError?.message ?? `timeout waiting for: ${label}`;
  throw new Error(`${detail} (gave up after ${attempts} attempts)`, { cause: lastError });
}

export function buildCwdFileProofCommand(platform: NodeJS.Platform, fileName: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(fileName) || fileName === '.' || fileName === '..') {
    throw new Error(`invalid cwd proof file name: ${fileName}`);
  }
  if (platform === 'win32') {
    return `Write-Output "CWD_PROOF=$(Get-Content -Raw -LiteralPath './${fileName}')"`;
  }
  return `printf 'CWD_PROOF=%s\\n' "$(cat './${fileName}')"`;
}
