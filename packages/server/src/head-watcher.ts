
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveGitDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { getLogger } from './logger.ts';


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


function readHeadSha(gitDir: string): string | null {
  try {
    const headContent = readFileSync(resolve(gitDir, 'HEAD'), 'utf-8').trim();
    if (headContent.startsWith('ref: ')) {
      const refPath = resolve(gitDir, headContent.slice(5));
      try {
        return readFileSync(refPath, 'utf-8').trim();
      } catch {
        try {
          const packed = readFileSync(resolve(gitDir, 'packed-refs'), 'utf-8');
          const refName = headContent.slice(5);
          const line = packed.split('\n').find((l) => l.endsWith(` ${refName}`));
          if (line) return line.split(' ')[0];
        } catch {
        }
        return null;
      }
    }
    return headContent.length >= 40 ? headContent.slice(0, 40) : null;
  } catch {
    return null;
  }
}

export function readBranchFromHead(gitDir: string): string | null {
  try {
    const headContent = readFileSync(resolve(gitDir, 'HEAD'), 'utf-8').trim();
    if (headContent.startsWith('ref: refs/heads/')) {
      return headContent.slice('ref: refs/heads/'.length);
    }
    if (headContent.length >= 40) {
      return `detached-${headContent.slice(0, 12)}`;
    }
    return null;
  } catch {
    return null;
  }
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
    getLogger('head-watcher').debug(
      { err: err instanceof Error ? err.message : String(err) },
      '[head-watcher] @parcel/watcher unavailable; falling back to chokidar',
    );
    return null;
  }
  try {
    const subscription = await parcel.subscribe(gitDir, (err, events) => {
      if (err) {
        getLogger('head-watcher').warn({ err }, '[head-watcher] parcel subscription error');
        return;
      }
      for (const event of events) dispatch(event.path);
    });
    return () => subscription.unsubscribe();
  } catch (err) {
    getLogger('head-watcher').debug(
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
    getLogger('head-watcher').warn({ err }, '[head-watcher] chokidar watcher error');
  });
  return () => watcher.close();
}


export async function startHeadWatcher(
  projectRoot: string,
  onBatchBegin: OnBatchBegin,
  onBatchEnd: OnBatchEnd,
  opts: { forceBackend?: 'parcel' | 'chokidar' } = {},
): Promise<HeadWatcherHandle> {
  const resolvedGitDir = resolveGitDir(projectRoot);
  if (!resolvedGitDir) {
    return { unsubscribe: async () => {}, getLastKnownBranch: () => null };
  }
  const gitDir: string = resolvedGitDir;

  let inBatch = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let oldHead: string | null = null;
  let lastKnownBranch: string | null = null;

  async function emitBatchEnd(timeout: boolean): Promise<void> {
    if (beginInFlight) await beginInFlight;
    if (!inBatch) return;

    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }

    const newHead = readHeadSha(gitDir);
    const headMoved = oldHead !== newHead;
    const newBranch = readBranchFromHead(gitDir);

    let batchKind: BatchKind;
    if (newBranch?.startsWith('detached-')) {
      batchKind = 'detached-head';
    } else if (lastKnownBranch !== newBranch) {
      batchKind = 'cross-branch';
    } else {
      batchKind = 'within-branch';
    }

    const oldBranch = lastKnownBranch;

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
      console.error('[head-watcher] onBatchEnd callback failed:', e);
    } finally {
      inBatch = false;
      oldHead = newHead;
      lastKnownBranch = newBranch;
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
    if (!inBatch) {
      inBatch = true;
      oldHead = readHeadSha(gitDir);
      const beginPromise = (async () => {
        try {
          await onBatchBegin({ trigger });
        } catch (e) {
          console.error('[head-watcher] onBatchBegin callback failed:', e);
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
  let backend: 'parcel' | 'chokidar' = 'chokidar';
  if (opts.forceBackend !== 'chokidar') {
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

  oldHead = readHeadSha(gitDir);
  lastKnownBranch = readBranchFromHead(gitDir);

  getLogger('head-watcher').info({ gitDir, backend }, 'watching for HEAD changes');

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
