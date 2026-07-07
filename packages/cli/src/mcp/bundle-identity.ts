/**
 * Detect when the `ok mcp` child process's mapped image diverges from the
 * on-disk binary at its `process.execPath` — i.e., the user drag-replaced
 * the OpenKnowledge bundle while this MCP child kept running off the
 * previous inode.
 *
 * Why this exists. When a host (Claude Desktop / Cursor / Codex / Windsurf
 * / VS Code) spawns `ok mcp`, the kernel maps the Electron Mach-O binary
 * (and its `Frameworks/*.framework/Versions/A/*` dylibs) into the child's
 * virtual memory. A subsequent Finder drag-replace of `OpenKnowledge.app`
 * swaps the bundle's directory entries; on-disk inodes are fresh. The
 * still-running child keeps its `txt` mappings to the unlinked previous
 * inodes (POSIX preserves the inode while any FD/mapping holds it). The
 * child therefore serves stale MCP-mediated writes off the previous
 * version's code path, while `ok --version` from a fresh shell follows the
 * symlink to the new bundle and reports the new version. The product has
 * no other signal to recycle the child; hosts' transport-recycle policies
 * differ host-to-host and don't trigger on bundle swap.
 *
 * The detection function compares an inode captured at process start
 * against the inode of `realpath(process.execPath)` at any later point. A
 * mismatch is the only signal that proves the binary changed — path
 * comparison alone misses the case where the bundle was replaced in place
 * (path stays the same, inode changes), and codesign / quarantine writes
 * change mtime without changing the inode. Inode equality is the precise
 * signal.
 *
 * Pure: no I/O performed directly. Callers inject `realpath` and
 * `statInode`; failures of either are classified as `'unreadable'` so the
 * call site can decide conservatively (no exit). Non-darwin platforms
 * short-circuit to `'unchanged'` — the bundle-drag-replace vector is a
 * macOS UX pattern; Windows uses installer-with-restart and Linux desktop
 * parity is deferred.
 */

export interface BundleIdentityCheckInput {
  /**
   * An absolute path to a file inside the bundle whose inode serves as the
   * bundle identity anchor. Typically derived via
   * `fileURLToPath(import.meta.url)` at module load — NOT `process.execPath`
   * (which resolves to the host runtime binary like Bun/Node, outside the OK
   * bundle).
   */
  bundleAnchorPath: string;
  /** Inode of the realpath-resolved anchor at process start. Captured once at MCP boot. */
  currentInode: number;
  /** Platform string (typically `process.platform`). Anything but `'darwin'` short-circuits. */
  platform: NodeJS.Platform;
  /** Resolves a path to its canonical absolute path. May throw (missing, permission). */
  realpath: (path: string) => string;
  /** Returns the inode number for the given path. May throw (missing, permission). */
  statInode: (path: string) => number;
}

export type BundleIdentityState =
  /** Realpath inode matches process-start inode — same binary still on disk. */
  | { kind: 'unchanged' }
  /** Realpath inode differs from process-start inode — bundle was drag-replaced mid-session. */
  | { kind: 'replaced'; currentInode: number; onDiskInode: number }
  /**
   * realpath() or statInode() threw — cannot classify; caller should no-op.
   * `reason` carries the underlying error message so operators debugging a
   * persistent unreadable state can distinguish ENOENT (bundle gone) from
   * EACCES (permission) from EIO (transient).
   */
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
  /** Returns the current bundle-identity state. Contractually never throws. */
  detect: () => BundleIdentityState;
  /** Fired exactly once per session when `detect` first returns `'replaced'`. Contractually never throws. */
  onReplaced: (state: BundleIdentityState & { kind: 'replaced' }) => void;
  /** Operator breadcrumb sink — used for `'unreadable'` ticks and contract violations. Contractually never throws. */
  log: (message: string) => void;
  /** Tick cadence. Defaults to 5 minutes, matching the sibling desktop detector. */
  intervalMs?: number;
  /** Injectable for tests; defaults to global setInterval. */
  setInterval?: typeof setInterval;
  /** Injectable for tests; defaults to global clearInterval. */
  clearInterval?: typeof clearInterval;
}

export interface BundleIdentityWatcherHandle {
  /** Stop the periodic timer. Idempotent. */
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Arm a periodic bundle-identity check. The watcher polls `detect` every
 * `intervalMs` (default 5 min) and fires `onReplaced` at most once per
 * session — the host then respawns the child off the new bundle on its
 * next tool call.
 *
 * `unreadable` ticks are skipped without disarming so transient fs hiccups
 * recover on subsequent ticks. The diagnostic log is edge-triggered on
 * state transitions (first unreadable in an episode, first non-unreadable
 * after one) — without that gate, a persistent unreadable state (e.g.,
 * bundle moved to the Trash mid-session) would produce one log line every
 * `intervalMs` indefinitely against an external host's stdio capture.
 *
 * `detect` is documented as never-throwing, but the tick is wrapped in a
 * try/catch so a future contract violation surfaces as a log line rather
 * than an uncaughtException that kills a long-lived stdio process.
 *
 * The interval handle is `.unref()`'d so a stale timer never blocks
 * process exit on signal-driven shutdown.
 */
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
  // Real Node/Bun setInterval handles support .unref(); test fakes may not,
  // so feature-detect rather than call unconditionally.
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

/**
 * Resolve an in-bundle anchor path to its current realpath + inode at MCP boot,
 * for later comparison by the periodic identity watcher.
 *
 * Returns `undefined` when the anchor is unreadable at boot — the caller is
 * expected to skip arming the watcher in that case (fail-open). The helper
 * logs a warning so operators can see why the watcher didn't arm.
 *
 * Pure modulo the injected fs deps and logger.
 */
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
