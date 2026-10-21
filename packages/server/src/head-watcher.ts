import {
  discoverGitRepository,
  type GitRepository,
} from '@inkeep/open-knowledge-core/git-repository';
import { getLogger } from './logger.ts';
import { incrementWatcherErrors } from './metrics.ts';
import { classifyParcelNotification } from './parcel-recovery.ts';
import { type NativeWatcherBackend, subscribeParcel } from './parcel-subscription.ts';
import { type WatcherClock, type WatcherTimer, watcherClock } from './watcher-clock.ts';
import { createResubscriber } from './watcher-freshness.ts';

const log = getLogger('head-watcher');

type BatchKind = 'within-branch' | 'cross-branch' | 'detached-head';

interface BatchEndInfo {
  headMoved: boolean;
  oldHead: string | null;
  newHead: string | null;
  timeout: boolean;
  batchKind: BatchKind;
  oldBranch: string | null;
  newBranch: string | null;
}

interface BatchBeginInfo {
  trigger: string;
}

type OnBatchBegin = (info: BatchBeginInfo) => void | Promise<void>;
type OnBatchEnd = (info: BatchEndInfo) => void | Promise<void>;

interface HeadWatcherCoverage {
  readonly onGaveUp?: (err: unknown) => void;
  readonly onBack?: () => void;
}

export interface HeadWatcherHandle {
  unsubscribe: () => Promise<void>;
  getLastKnownBranch: () => string | null;
}

const QUIET_WINDOW_MS = 100;
const BATCH_TIMEOUT_MS = 30_000;

const WATCHED_FILES = new Set(['HEAD', 'MERGE_HEAD', 'ORIG_HEAD', 'index', 'index.lock']);

export interface ProjectHeadState {
  readonly branch: string | null;
  readonly oid: string | null;
}

function readRepositoryHeadState(repository: GitRepository): ProjectHeadState {
  const head = repository.readHead();
  if (head.kind === 'detached') {
    return { branch: `detached-${head.oid.slice(0, 12)}`, oid: head.oid };
  }
  if (head.kind !== 'branch') return { branch: null, oid: null };

  const ref = repository.readRef(head.ref);
  const oid = ref.kind === 'present' && ref.value.kind === 'oid' ? ref.value.oid : null;
  return { branch: head.branch, oid };
}

export function readProjectHeadState(projectRoot: string): ProjectHeadState {
  const inspected = discoverGitRepository(projectRoot);
  return inspected.kind === 'repository'
    ? readRepositoryHeadState(inspected.repository)
    : { branch: null, oid: null };
}

type HeadEventDispatch = (rawPath: string) => void;

export function watchedGitFile(rawPath: string): string | null {
  const fileName = rawPath.split(/[\\/]/).pop() ?? '';
  return WATCHED_FILES.has(fileName) ? fileName : null;
}

async function tryStartParcelHeadWatcher(
  gitDir: string,
  dispatch: (rawPath: string) => boolean,
  recover: () => void,
  platform: NodeJS.Platform,
  clock: WatcherClock,
  coverage: HeadWatcherCoverage,
  nativeBackend?: NativeWatcherBackend,
): Promise<(() => Promise<void>) | null> {
  let parcel: NativeWatcherBackend;
  if (nativeBackend) {
    parcel = nativeBackend;
  } else {
    try {
      parcel = await import('@parcel/watcher');
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        '[head-watcher] @parcel/watcher unavailable; falling back to chokidar',
      );
      return null;
    }
  }
  try {
    const notificationsFor =
      (generation: number): Parameters<typeof subscribeParcel>[2] =>
      (err, events) => {
        if (!resubscriber.isLive(generation)) return;
        const notification = classifyParcelNotification(err, events);
        if (notification.kind === 'error') {
          log.warn({ err: notification.error }, '[head-watcher] parcel subscription error');
          incrementWatcherErrors();
          resubscriber.lost('error', generation, notification.error);
          return;
        }
        if (notification.kind === 'rescan') {
          log.warn(
            { err: notification.error, eventCount: notification.events.length },
            '[head-watcher] parcel recovery requested',
          );
        }
        let hadWatchedRecord = false;
        for (const event of notification.events) {
          if (dispatch(event.path)) hadWatchedRecord = true;
        }
        if (notification.kind === 'rescan' && !hadWatchedRecord) recover();
      };
    const resubscriber = createResubscriber({
      clock,
      root: gitDir,
      backendName: 'head-parcel',
      coverageWhileLost:
        'branch switches, pulls and other HEAD moves go unnoticed and the server reports head-watcher as degraded',
      subscribe: (generation) =>
        subscribeParcel(parcel, gitDir, notificationsFor(generation), undefined, platform),
      onResubscribed: recover,
      onGaveUp: coverage.onGaveUp,
      onBack: coverage.onBack,
    });
    await resubscriber.start();
    return () => resubscriber.close();
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      '[head-watcher] @parcel/watcher subscribe failed; falling back to chokidar',
    );
    return null;
  }
}

async function startChokidarHeadWatcher(
  gitDir: string,
  dispatch: HeadEventDispatch,
): Promise<() => Promise<void>> {
  const { watch } = await import('chokidar');
  const watcher = watch(gitDir, {
    ignoreInitial: true,
    depth: 0,
    followSymlinks: false,
  });
  watcher.on('all', (_event, path) => dispatch(path));
  watcher.on('error', (err) => {
    log.warn({ err }, '[head-watcher] chokidar watcher error');
  });
  return () => watcher.close();
}

export async function startHeadWatcher(
  projectRoot: string,
  onBatchBegin: OnBatchBegin,
  onBatchEnd: OnBatchEnd,
  opts: {
    forceBackend?: 'parcel' | 'chokidar';
    platform?: NodeJS.Platform;
    nativeBackend?: NativeWatcherBackend;
    clock?: WatcherClock;
    onGaveUp?: (err: unknown) => void;
    onBack?: () => void;
    subscribeForTest?: (
      gitDir: string,
      dispatch: HeadEventDispatch,
    ) => Promise<() => Promise<void>>;
  } = {},
): Promise<HeadWatcherHandle> {
  const inspected = discoverGitRepository(projectRoot);
  if (inspected.kind !== 'repository') {
    return { unsubscribe: async () => {}, getLastKnownBranch: () => null };
  }
  const repository = inspected.repository;
  const gitDir = repository.gitDir;
  const clock = opts.clock ?? watcherClock();

  let inBatch = false;
  let quietTimer: WatcherTimer | null = null;
  let timeoutTimer: WatcherTimer | null = null;
  let oldHead: string | null = null;
  let lastKnownBranch: string | null = null;
  let batchEndInFlight: Promise<void> | null = null;
  let headWork = Promise.resolve();
  let closed = false;

  async function emitBatchEnd(timeout: boolean): Promise<void> {
    if (beginInFlight) await beginInFlight;
    if (batchEndInFlight) {
      await batchEndInFlight;
      return;
    }
    if (!inBatch) return;

    if (quietTimer) {
      clock.clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (timeoutTimer) {
      clock.clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }

    const head = readRepositoryHeadState(repository);
    const newHead = head.oid;
    const headMoved = oldHead !== newHead;
    const newBranch = head.branch;

    let batchKind: BatchKind;
    if (newBranch?.startsWith('detached-')) {
      batchKind = 'detached-head';
    } else if (lastKnownBranch !== newBranch) {
      batchKind = 'cross-branch';
    } else {
      batchKind = 'within-branch';
    }

    const oldBranch = lastKnownBranch;

    const end = Promise.resolve().then(async () => {
      try {
        await onBatchEnd({
          headMoved,
          oldHead,
          newHead,
          timeout,
          batchKind,
          oldBranch,
          newBranch,
        });
      } catch (e) {
        log.error({ err: e }, 'onBatchEnd callback failed');
      } finally {
        inBatch = false;
        oldHead = newHead;
        lastKnownBranch = newBranch;
      }
    });
    batchEndInFlight = end;
    try {
      await end;
    } finally {
      if (batchEndInFlight === end) batchEndInFlight = null;
    }
  }

  function resetQuietWindow(): void {
    if (quietTimer) clock.clearTimeout(quietTimer);
    quietTimer = clock.setTimeout(() => {
      quietTimer = null;
      void emitBatchEnd(false);
    }, QUIET_WINDOW_MS);
  }

  let beginInFlight: Promise<void> | null = null;

  async function handleGitEvent(trigger: string): Promise<void> {
    if (batchEndInFlight) await batchEndInFlight;
    if (!inBatch) {
      inBatch = true;
      if (oldHead === null) oldHead = readRepositoryHeadState(repository).oid;
      const beginPromise = (async () => {
        try {
          await onBatchBegin({ trigger });
        } catch (e) {
          log.error({ err: e }, 'onBatchBegin callback failed');
        }
      })();
      beginInFlight = beginPromise;
      await beginPromise;
      beginInFlight = null;

      timeoutTimer = clock.setTimeout(() => {
        timeoutTimer = null;
        void emitBatchEnd(true);
      }, BATCH_TIMEOUT_MS);
    }

    resetQuietWindow();
  }

  const admitHeadEvent = (trigger: string): Promise<void> => {
    const work = headWork.then(async () => {
      try {
        await handleGitEvent(trigger);
      } catch (err) {
        log.error({ err }, 'HEAD event handling failed');
      }
    });
    headWork = work;
    return work;
  };

  const dispatch = (rawPath: string): boolean => {
    if (closed) return false;
    const fileName = watchedGitFile(rawPath);
    if (fileName === null) return false;
    void admitHeadEvent(fileName);
    return true;
  };
  const recover = (): void => {
    if (closed) return;
    void admitHeadEvent('rescan');
  };

  let resolvedUnsub: (() => Promise<void>) | null = null;
  let backend: 'parcel' | 'chokidar' | 'test' = 'chokidar';
  if (opts.subscribeForTest) {
    resolvedUnsub = await opts.subscribeForTest(gitDir, dispatch);
    backend = 'test';
  } else if (opts.forceBackend !== 'chokidar') {
    resolvedUnsub = await tryStartParcelHeadWatcher(
      gitDir,
      dispatch,
      recover,
      opts.platform ?? process.platform,
      clock,
      { onGaveUp: opts.onGaveUp, onBack: opts.onBack },
      opts.nativeBackend,
    );
    if (resolvedUnsub) backend = 'parcel';
  }
  if (!resolvedUnsub) {
    if (opts.forceBackend === 'parcel') {
      throw new Error('@parcel/watcher unavailable for HEAD watching (forced backend)');
    }
    resolvedUnsub = await startChokidarHeadWatcher(gitDir, dispatch);
    backend = 'chokidar';
  }
  const unsubscribeFn: () => Promise<void> = resolvedUnsub;

  const initialHead = readRepositoryHeadState(repository);
  oldHead = initialHead.oid;
  lastKnownBranch = initialHead.branch;

  log.info({ gitDir, backend }, 'watching for HEAD changes');

  return {
    unsubscribe: async () => {
      closed = true;
      try {
        await unsubscribeFn();
      } finally {
        await headWork;
        if (inBatch) await emitBatchEnd(false);
        if (quietTimer) clock.clearTimeout(quietTimer);
        if (timeoutTimer) clock.clearTimeout(timeoutTimer);
      }
    },
    getLastKnownBranch: () => lastKnownBranch,
  };
}
