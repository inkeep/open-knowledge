
export interface BundleIdentityCheckInput {
  bundleAnchorPath: string;
  currentInode: number;
  platform: NodeJS.Platform;
  realpath: (path: string) => string;
  statInode: (path: string) => number;
}

export type BundleIdentityState =
  | { kind: 'unchanged' }
  | { kind: 'replaced'; currentInode: number; onDiskInode: number }
  | { kind: 'unreadable'; reason?: string };

export function detectBundleIdentity(input: BundleIdentityCheckInput): BundleIdentityState {
  if (input.platform !== 'darwin') return { kind: 'unchanged' };

  let resolvedPath: string;
  try {
    resolvedPath = input.realpath(input.bundleAnchorPath);
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }

  let onDiskInode: number;
  try {
    onDiskInode = input.statInode(resolvedPath);
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }

  if (onDiskInode === input.currentInode) return { kind: 'unchanged' };
  return { kind: 'replaced', currentInode: input.currentInode, onDiskInode };
}

export interface BundleIdentityWatcherDeps {
  detect: () => BundleIdentityState;
  onReplaced: (state: BundleIdentityState & { kind: 'replaced' }) => void;
  log: (message: string) => void;
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export interface BundleIdentityWatcherHandle {
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export function startBundleIdentityWatcher(
  deps: BundleIdentityWatcherDeps,
): BundleIdentityWatcherHandle {
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  let armed = true;
  let stopped = false;
  let wasUnreadable = false;

  const tick = (): void => {
    if (!armed) return;
    let state: BundleIdentityState;
    try {
      state = deps.detect();
    } catch (err) {
      deps.log(
        `bundle identity check threw unexpectedly (contract violation): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (state.kind === 'unreadable') {
      if (!wasUnreadable) {
        wasUnreadable = true;
        deps.log(
          `bundle identity check unreadable${state.reason ? `: ${state.reason}` : ''} — will retry on next tick`,
        );
      }
      return;
    }
    if (wasUnreadable) {
      wasUnreadable = false;
      deps.log('bundle identity check recovered from unreadable');
    }
    if (state.kind === 'unchanged') return;
    armed = false;
    deps.onReplaced(state);
  };

  const handle = setIntervalFn(tick, intervalMs);
  if (typeof (handle as { unref?: unknown }).unref === 'function') {
    (handle as { unref: () => unknown }).unref();
  }

  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      armed = false;
      clearIntervalFn(handle);
    },
  };
}

interface CaptureBootIdentityDeps {
  realpathSync: (p: string) => string;
  statInoSync: (p: string) => number;
  log: (msg: string) => void;
}

interface BootIdentity {
  resolvedPath: string;
  inode: number;
}

export function captureBootIdentity(
  anchorPath: string,
  deps: CaptureBootIdentityDeps,
): BootIdentity | undefined {
  let resolvedPath: string;
  try {
    resolvedPath = deps.realpathSync(anchorPath);
  } catch (err) {
    deps.log(
      `[mcp] bundle identity boot capture unreadable (realpath failed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  let inode: number;
  try {
    inode = deps.statInoSync(resolvedPath);
  } catch (err) {
    deps.log(
      `[mcp] bundle identity boot capture unreadable (stat failed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  return { resolvedPath, inode };
}
