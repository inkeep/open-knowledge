/**
 * HEAD watcher — detects coordinated git operations (pull, checkout, merge, rebase).
 *
 * Watches .git/HEAD, MERGE_HEAD, ORIG_HEAD, and index.lock for changes.
 * Emits BatchBegin when activity starts and BatchEnd after a quiet window.
 *
 * BatchEnd includes headMoved (whether HEAD SHA changed) and old/new SHAs.
 * A timeout cap prevents indefinite batching (e.g., long rebase).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveGitDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { getLogger } from './logger.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

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
  /** Current known branch name (or 'detached-<sha12>'). */
  getLastKnownBranch: () => string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const QUIET_WINDOW_MS = 100;
const BATCH_TIMEOUT_MS = 30_000;

/** Files within .git/ that signal coordinated operations. */
const WATCHED_FILES = new Set(['HEAD', 'MERGE_HEAD', 'ORIG_HEAD', 'index.lock']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read current HEAD SHA, or null if unreadable. */
function readHeadSha(gitDir: string): string | null {
  try {
    const headContent = readFileSync(resolve(gitDir, 'HEAD'), 'utf-8').trim();
    // HEAD may be a ref (ref: refs/heads/main) or a detached SHA
    if (headContent.startsWith('ref: ')) {
      const refPath = resolve(gitDir, headContent.slice(5));
      try {
        return readFileSync(refPath, 'utf-8').trim();
      } catch {
        // Ref file may not exist (empty repo)
        // Try packed-refs
        try {
          const packed = readFileSync(resolve(gitDir, 'packed-refs'), 'utf-8');
          const refName = headContent.slice(5);
          const line = packed.split('\n').find((l) => l.endsWith(` ${refName}`));
          if (line) return line.split(' ')[0];
        } catch {
          // No packed-refs
        }
        return null;
      }
    }
    // Detached HEAD — the content is the SHA
    return headContent.length >= 40 ? headContent.slice(0, 40) : null;
  } catch {
    return null;
  }
}

/**
 * Read the branch name from .git/HEAD.
 *
 * Returns the branch name (e.g. "main") for a symref,
 * "detached-<sha12>" for a raw SHA, or null if unreadable.
 */
export function readBranchFromHead(gitDir: string): string | null {
  try {
    const headContent = readFileSync(resolve(gitDir, 'HEAD'), 'utf-8').trim();
    if (headContent.startsWith('ref: refs/heads/')) {
      return headContent.slice('ref: refs/heads/'.length);
    }
    // Detached HEAD — raw SHA
    if (headContent.length >= 40) {
      return `detached-${headContent.slice(0, 12)}`;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Backends ────────────────────────────────────────────────────────────────

type HeadEventDispatch = (rawPath: string) => void;

/**
 * Map a raw watcher event path to the watched `.git` filename it represents, or
 * `null` when it isn't one we track. Pure — shared by both backends and
 * unit-testable without real filesystem events.
 */
export function watchedGitFile(rawPath: string): string | null {
  const fileName = rawPath.split('/').pop() ?? '';
  return WATCHED_FILES.has(fileName) ? fileName : null;
}

/**
 * Try to start a `@parcel/watcher` subscription on the git dir. Returns the
 * unsubscribe fn, or `null` when `@parcel/watcher` can't load (it's a native
 * addon that packaged builds don't bundle) or its `subscribe()` fails
 * (permission / inotify-limit / EACCES). A `null` return tells the caller to
 * fall back to chokidar rather than give up on HEAD watching entirely.
 */
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

/**
 * Chokidar fallback for HEAD watching — mirrors the file-watcher's chokidar
 * fallback so packaged builds (which ship without the `@parcel/watcher` native
 * binary) still detect branch switches. `depth: 0` watches only the top-level
 * `.git` entries, which is exactly where the watched ref files live; git writes
 * them as small atomic renames that chokidar detects reliably. The bulk-event
 * coalescing that makes chokidar lossy for content watching doesn't apply to
 * this handful of ref files.
 */
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
  // Without an 'error' listener, chokidar (an EventEmitter) rethrows watcher
  // errors (EACCES, inotify watcher-limit exhaustion) as uncaught — crashing
  // the server. Log + swallow: a HEAD-watch hiccup must not take the process
  // down; branch-switch detection simply pauses.
  watcher.on('error', (err) => {
    getLogger('head-watcher').warn({ err }, '[head-watcher] chokidar watcher error');
  });
  return () => watcher.close();
}

// ─── Watcher ─────────────────────────────────────────────────────────────────

/**
 * Start watching .git/ for coordinated operations.
 *
 * Returns a handle to stop watching. If `.git/` cannot be resolved (e.g. the
 * project is uninitialized and `ensureProjectGit` has not yet run), returns a
 * no-op handle so callers don't have to special-case the missing state.
 *
 * Backend selection: prefer `@parcel/watcher` (FSEvents — efficient) and fall
 * back to chokidar when it can't load, so HEAD watching stays functional in
 * packaged builds that omit the native addon. `opts.forceBackend` pins one
 * backend (test seam; `'parcel'` throws instead of falling back).
 */
export async function startHeadWatcher(
  projectRoot: string,
  onBatchBegin: OnBatchBegin,
  onBatchEnd: OnBatchEnd,
  opts: { forceBackend?: 'parcel' | 'chokidar' } = {},
): Promise<HeadWatcherHandle> {
  const resolvedGitDir = resolveGitDir(projectRoot);
  if (!resolvedGitDir) {
    // No .git/ to watch — skip attachment without erroring
    return { unsubscribe: async () => {}, getLastKnownBranch: () => null };
  }
  const gitDir: string = resolvedGitDir;

  let inBatch = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let oldHead: string | null = null;
  let lastKnownBranch: string | null = null;

  async function emitBatchEnd(timeout: boolean): Promise<void> {
    // Wait for onBatchBegin to finish before proceeding
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

    // Classify batch kind
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
      // Set inBatch = false AFTER the async callback completes
      // so new file events stay buffered during branch-switch orchestration
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

      // Start timeout cap only after begin completes
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

  // Prefer @parcel/watcher; fall back to chokidar when it can't start so HEAD
  // watching stays functional in packaged builds that omit the native addon.
  let resolvedUnsub: (() => Promise<void>) | null = null;
  let backend: 'parcel' | 'chokidar' = 'chokidar';
  if (opts.forceBackend !== 'chokidar') {
    resolvedUnsub = await tryStartParcelHeadWatcher(gitDir, dispatch);
    if (resolvedUnsub) backend = 'parcel';
  }
  if (!resolvedUnsub) {
    if (opts.forceBackend === 'parcel') {
      // Caller pinned parcel but it couldn't start — surface a genuine failure
      // rather than silently using a different backend (test seam).
      throw new Error('@parcel/watcher unavailable for HEAD watching (forced backend)');
    }
    resolvedUnsub = await startChokidarHeadWatcher(gitDir, dispatch);
    backend = 'chokidar';
  }
  const unsubscribeFn: () => Promise<void> = resolvedUnsub;

  // Read initial state AFTER the watcher is active to avoid missing events
  // that occur between the read and the subscription completing.
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
