import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';

const POLL_INTERVAL_MS = 200;

const TIMESTAMP_GRANULARITY_BOUND_NS = 3_000_000_000n;

const NS_PER_MS = 1_000_000n;

type PathEvent = 'add' | 'change' | 'unlink';

interface PolledPathWatcherOptions {
  listPaths: () => Promise<ReadonlyArray<string>>;
  onEvent: (event: PathEvent, path: string) => void;
  onError: (err: unknown, path?: string) => void;
}

interface Observation {
  readonly size: bigint;
  readonly signature: string;
  readonly racy: boolean;
  readonly digest: string | undefined;
}

const readsAsAbsent = (err: unknown): boolean => {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const signatureOf = (stats: BigIntStats): string =>
  `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;

const isRacy = (stats: BigIntStats, sampledAtNs: bigint): boolean =>
  stats.ctimeNs + TIMESTAMP_GRANULARITY_BOUND_NS > sampledAtNs ||
  (stats.mtimeNs + TIMESTAMP_GRANULARITY_BOUND_NS > sampledAtNs &&
    stats.mtimeNs <= sampledAtNs + TIMESTAMP_GRANULARITY_BOUND_NS);

const unchanged = (known: Observation, observed: Observation): boolean =>
  known.signature === observed.signature && (!known.racy || known.digest === observed.digest);

const retained = (observation: Observation): Observation =>
  observation.racy ? observation : { ...observation, digest: undefined };

async function fileStats(path: string): Promise<BigIntStats | undefined> {
  let stats: BigIntStats;
  try {
    stats = await stat(path, { bigint: true });
  } catch (err) {
    if (readsAsAbsent(err)) return undefined;
    throw err;
  }
  return stats.isFile() ? stats : undefined;
}

async function contentDigest(path: string): Promise<string | undefined> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch (err) {
    if (readsAsAbsent(err)) return undefined;
    throw err;
  }
}

async function observe(
  path: string,
  known: Observation | undefined,
  isClosed: () => boolean,
): Promise<Observation | undefined> {
  const sampledAtNs = BigInt(Date.now()) * NS_PER_MS;
  const first = await fileStats(path);
  if (first === undefined) return undefined;
  if (!known?.racy && !isRacy(first, sampledAtNs)) {
    return { size: first.size, signature: signatureOf(first), racy: false, digest: undefined };
  }
  if (isClosed()) return undefined;
  const digest = await contentDigest(path);
  if (digest === undefined || isClosed()) return undefined;
  const second = await fileStats(path);
  if (second === undefined) return undefined;
  return {
    size: second.size,
    signature: signatureOf(second),
    racy: isRacy(second, sampledAtNs),
    digest,
  };
}

export async function startPolledPathWatcher({
  listPaths,
  onEvent,
  onError,
}: PolledPathWatcherOptions): Promise<() => Promise<void>> {
  const log = getLogger('polled-path-watcher');
  const failingCodes = new Map<string, string | undefined>();
  let closed = false;

  const report = (err: unknown, path?: string): void => {
    if (closed) return;
    try {
      onError(err, path);
    } catch (thrown) {
      try {
        log.error({ err, error: thrown, path }, 'onError threw while reporting a watcher error');
      } catch {}
    }
  };

  const sample = async (
    kept: ReadonlyMap<string, Observation>,
  ): Promise<Map<string, Observation>> => {
    const listed = new Set(await listPaths());
    for (const path of failingCodes.keys()) {
      if (!listed.has(path)) failingCodes.delete(path);
    }
    const observed = new Map<string, Observation>();
    await Promise.all(
      Array.from(listed, async (path) => {
        let observation: Observation | undefined;
        try {
          observation = await observe(path, kept.get(path), () => closed);
        } catch (err) {
          const code = errnoCode(err);
          if (!failingCodes.has(path) || failingCodes.get(path) !== code) {
            failingCodes.set(path, code);
            report(err, path);
          }
          const last = kept.get(path);
          if (last) observed.set(path, last);
          return;
        }
        failingCodes.delete(path);
        if (observation) observed.set(path, observation);
      }),
    );
    return observed;
  };

  const reference = await sample(new Map());
  const pendingSizes = new Map<string, bigint>();

  const compare = (observed: ReadonlyMap<string, Observation>): void => {
    for (const [path, observation] of observed) {
      const known = reference.get(path);
      if (known !== undefined && unchanged(known, observation)) {
        pendingSizes.delete(path);
        if (known.racy) reference.set(path, retained(observation));
      } else if (pendingSizes.get(path) === observation.size) {
        pendingSizes.delete(path);
        reference.set(path, retained(observation));
        onEvent(known ? 'change' : 'add', path);
      } else {
        pendingSizes.set(path, observation.size);
      }
    }
    for (const path of reference.keys()) {
      if (observed.has(path)) continue;
      reference.delete(path);
      onEvent('unlink', path);
    }
    for (const path of pendingSizes.keys()) {
      if (!observed.has(path)) pendingSizes.delete(path);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async (): Promise<void> => {
    try {
      const observed = await sample(reference);
      if (!closed) compare(observed);
    } catch (err) {
      report(err);
    }
  };

  const schedule = (): void => {
    timer = setTimeout(() => {
      void poll().finally(() => {
        if (!closed) schedule();
      });
    }, POLL_INTERVAL_MS);
  };

  schedule();

  return async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
  };
}
