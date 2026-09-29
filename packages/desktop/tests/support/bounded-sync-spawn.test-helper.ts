import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from 'node:child_process';

export const UNTRAPPABLE_KILL_SIGNAL = 'SIGKILL' as const;

export const RESERVED_SPAWN_OPTIONS = [
  'encoding',
  'timeout',
  'killSignal',
  'shell',
  'windowsVerbatimArguments',
] as const satisfies readonly (keyof SpawnSyncOptionsWithStringEncoding)[];

type ReservedSpawnOption = (typeof RESERVED_SPAWN_OPTIONS)[number];

const STREAM_TAIL_LIMIT = 2_000;

export function capturedTails(result: SpawnSyncReturns<string>): string {
  const tail = (stream: string | null | undefined): string => {
    const trimmed = (stream ?? '').trim();
    return trimmed.length <= STREAM_TAIL_LIMIT
      ? trimmed
      : `...${trimmed.slice(-STREAM_TAIL_LIMIT)}`;
  };
  return `stdout tail: ${tail(result.stdout)}\nstderr tail: ${tail(result.stderr)}`;
}

export class BoundedSpawnTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly result: SpawnSyncReturns<string>;

  constructor(command: string, timeoutMs: number, result: SpawnSyncReturns<string>) {
    super(
      `${command} exceeded its ${timeoutMs}ms spawn budget and was killed with ${UNTRAPPABLE_KILL_SIGNAL}. ` +
        'the signal reached the direct child only, so anything that child had already forked survives it: ' +
        'node delivers one signal to one pid and performs no process-group kill. ' +
        'this is raised rather than returned because the budget cannot be expressed in the exit status: ' +
        'a run killed by the bound and a run killed by anything else both arrive as status null, which ' +
        'silently satisfies any assertion that only requires a non-zero exit, so a timed-out run would ' +
        'otherwise pass for the wrong reason. Raise the budget at the call site only with evidence that ' +
        'the work legitimately needs longer. What the run had emitted when the bound fired is below: ' +
        'spawnSync captured it up to the kill, and it is the only record of how far the run got, so it ' +
        `is carried in this message rather than left on a field no failure log renders.\n${capturedTails(result)}`,
    );
    this.name = 'BoundedSpawnTimeoutError';
    this.timeoutMs = timeoutMs;
    this.result = result;
  }
}

export class BoundedSpawnError extends Error {
  readonly result: SpawnSyncReturns<string>;

  constructor(command: string, result: SpawnSyncReturns<string>, cause: NodeJS.ErrnoException) {
    super(
      `${command} did not run to completion: ${cause.code ?? cause.name}. ` +
        'node reports this on the result rather than by throwing, and the message it builds names ' +
        'only the program, so absorbing it here would leave a caller reading a partial result as a ' +
        'whole one. The reachable case is maxBuffer: node caps the combined bytes of every captured ' +
        'stream at 1 MiB by default, and on overflow it stops reading, kills the child if it is still running, and hands ' +
        'back the truncated stream, which is indistinguishable from a legitimately short run to any ' +
        'assertion that only reads status and ' +
        `output. Node's own text was: ${cause.message}\n${capturedTails(result)}`,
      { cause },
    );
    this.name = 'BoundedSpawnError';
    this.result = result;
  }
}

export const DEFAULT_BOUNDED_SPAWN_TIMEOUT_MS = 60_000;

export const UNREADABLE_TRAIL_NOTICE =
  'the diagnostic trail could not be read, so this failure carries no record of what the run had done';

export function withCallTrail(error: unknown, readTrail: () => string): unknown {
  if (!(error instanceof Error)) return error;
  try {
    error.message += readTrail();
  } catch (trailError) {
    error.message +=
      `\n${UNREADABLE_TRAIL_NOTICE}. A trail is enrichment, and it is read back from a state dir ` +
      'that the killed run, and anything that run had already forked, can still be writing to: the ' +
      'kill reaches one pid and performs no process-group kill, so an entry can be listed and then ' +
      'vanish, or be half written, before the read of it lands. Letting that read raise from here ' +
      'would discard the spawn failure above and report an unrelated filesystem error in its place, ' +
      'which is the misreported cause this bound exists to end, so a trail that cannot be read ' +
      `yields thinner output rather than a different error. The read failed with: ${
        trailError instanceof Error ? trailError.message : String(trailError)
      }`;
  }
  return error;
}

export type BoundedSpawnSyncOptions = Omit<
  SpawnSyncOptionsWithStringEncoding,
  ReservedSpawnOption
> & { readonly timeoutMs: number };

export function spawnSyncBounded(
  file: string,
  args: readonly string[],
  options: BoundedSpawnSyncOptions,
): SpawnSyncReturns<string> {
  const { timeoutMs, ...rest } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `spawnSyncBounded needs a positive finite budget in ms, got ${String(timeoutMs)}. ` +
        'node reads a timeout of 0 exactly as it reads an omitted timeout, so a zero or ' +
        'non-finite budget is an unbounded synchronous spawn: the calling thread parks inside ' +
        "the syscall and no JS timer, vitest's testTimeout included, can preempt it.",
    );
  }
  const caller: Record<string, unknown> = { ...rest };
  for (const reserved of RESERVED_SPAWN_OPTIONS) delete caller[reserved];
  const result = spawnSync(file, [...args], {
    ...(caller as Omit<SpawnSyncOptionsWithStringEncoding, ReservedSpawnOption>),
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: UNTRAPPABLE_KILL_SIGNAL,
  });
  const command = [file, ...args].join(' ');
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === 'ETIMEDOUT') {
    throw new BoundedSpawnTimeoutError(command, timeoutMs, result);
  }
  if (error !== undefined) throw new BoundedSpawnError(command, result, error);
  return result;
}
