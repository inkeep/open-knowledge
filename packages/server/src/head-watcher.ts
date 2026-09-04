import {
  discoverGitRepository,
  type GitRepository,
} from '@inkeep/open-knowledge-core/git-repository';
import { getLogger } from './logger.ts';

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

export interface HeadWatcherHandle {
  unsubscribe: () => Promise<void>;
  getLastKnownBranch: () => string | null;
}

const QUIET_WINDOW_MS = 100;
const BATCH_TIMEOUT_MS = 30_000;

const WATCHED_FILES = new Set(['HEAD', 'MERGE_HEAD', 'ORIG_HEAD', 'index.lock']);

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
  const fileName = rawPath.split('/').pop() ?? '';
  return WATCHED_FILES.has(fileName) ? fileName : null;
}

async function tryStartParcelHeadWatcher(
  gitDir: string,
  dispatch: HeadEventDispatch,
): Promise<(() => Promise<void>) | null> {
  let parcel: typeof import('@parcel/watcher');
  try {
    parcel = await import('@parcel/watcher');
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      '[head-watcher] @parcel/watcher unavailable; falling back to chokidar',
    );
    return null;
  }
  try {
    const subscription = await parcel.subscribe(gitDir, (err, events) => {
      if (err) {
        log.warn({ err }, '[head-watcher] parcel subscription error');
        return;
      }
      for (const event of events) dispatch(event.path);
    });
    return () => subscription.unsubscribe();
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

  let inBatch = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let oldHead: string | null = null;
  let lastKnownBranch: string | null = null;
  let batchEndInFlight: Promise<void> | null = null;

  async function emitBatchEnd(timeout: boolean): Promise<void> {
    if (beginInFlight) await beginInFlight;
    if (batchEndInFlight) {
      await batchEndInFlight;
      return;
    }
    if (!inBatch) return;

    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
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
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
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

      timeoutTimer = setTimeout(() => {
        timeoutTimer = null;
        void emitBatchEnd(true);
      }, BATCH_TIMEOUT_MS);
    }

    resetQuietWindow();
  }

  const dispatch: HeadEventDispatch = (rawPath) => {
    const fileName = watchedGitFile(rawPath);
    if (fileName !== null) void handleGitEvent(fileName);
  };

  let resolvedUnsub: (() => Promise<void>) | null = null;
  let backend: 'parcel' | 'chokidar' | 'test' = 'chokidar';
  if (opts.subscribeForTest) {
    resolvedUnsub = await opts.subscribeForTest(gitDir, dispatch);
    backend = 'test';
  } else if (opts.forceBackend !== 'chokidar') {
    resolvedUnsub = await tryStartParcelHeadWatcher(gitDir, dispatch);
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
      if (inBatch) {
        await emitBatchEnd(false);
      }
      if (quietTimer) clearTimeout(quietTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      await unsubscribeFn();
    },
    getLastKnownBranch: () => lastKnownBranch,
  };
}
