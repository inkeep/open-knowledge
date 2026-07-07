/**
 * Resolves the real write target behind a (possibly symlinked) harness config
 * path, so OpenKnowledge writes *through* a dotfile-managed symlink to its real
 * target instead of replacing the symlink with a regular file and orphaning the
 * stow/chezmoi/dotfiles-repo copy. The atomic tmp+rename stays on the existing
 * write spine; this module only decides *where* to write.
 *
 * Unlike the TOML document engine, this must work for every harness — the four
 * pure-JS JSON harnesses need write-through too, and on a platform with no
 * prebuilt binary the addon is absent. Symlink traversal has no capability gap
 * (Node's `fs` follows links identically to Rust's `std::fs`), so the JS path is
 * a faithful mirror of the native resolver ported from Codex, not a degraded
 * fallback. The native binding is preferred where present because it carries the
 * conformance test suite; a contract test pins both implementations to the same
 * behavior.
 */
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { debugNativeLoadFailure, requireNativeConfigModule } from './load-native-config.ts';

/**
 * Where to read the existing config from and where to write the updated one.
 * `readPath` is `null` when the chain cannot be safely resolved (a cycle or a
 * link/metadata error); `writePath` is then the original path, and writing a
 * fresh regular file there intentionally breaks the broken link.
 */
export interface SymlinkWritePaths {
  readPath: string | null;
  writePath: string;
}

/** The single function the native addon exposes for symlink write-through. */
interface NativeSymlinkBinding {
  resolveSymlinkWritePath(path: string): { readPath?: string | null; writePath: string };
}

/**
 * Resolve the native addon, returning `null` (rather than throwing) when no
 * binary can be loaded for this platform. Shares the dist-relative vs
 * workspace-package lookup with `toml-config-engine.ts` and narrows to the
 * symlink-resolution binding shape.
 */
function requireNativeSymlinkBinding(): NativeSymlinkBinding | null {
  const mod = requireNativeConfigModule();
  return mod && typeof (mod as Partial<NativeSymlinkBinding>).resolveSymlinkWritePath === 'function'
    ? (mod as NativeSymlinkBinding)
    : null;
}

/**
 * Pure-JS symlink-chain resolver mirroring Codex's `resolve_symlink_write_paths`
 * (the algorithm the native addon ports). Follows the chain to the first
 * non-symlink target, guarding cycles with a visited set; a relative target is
 * resolved against its link's parent. A not-yet-created target is a normal
 * first-write (write there); a cycle or an unreadable link declines a read
 * target and writes through the original path to break the link.
 */
function resolveSymlinkWritePathsJs(path: string): SymlinkWritePaths {
  let current = path;
  const visited = new Set<string>();

  for (;;) {
    let isSymlink: boolean;
    try {
      isSymlink = lstatSync(current).isSymbolicLink();
    } catch (err) {
      // A not-yet-created target is the common first-write case: write there.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { readPath: current, writePath: current };
      }
      return { readPath: null, writePath: path };
    }

    if (!isSymlink) return { readPath: current, writePath: current };

    // Re-seeing a path means the chain loops back on itself.
    if (visited.has(current)) return { readPath: null, writePath: path };
    visited.add(current);

    let target: string;
    try {
      target = readlinkSync(current);
    } catch (err) {
      // An unreadable link mid-chain declines the read target and writes through
      // the original path; trace it under OK_DEBUG_NATIVE so the broken link
      // isn't a fully silent decline.
      debugNativeLoadFailure('readlinkSync threw during symlink walk', err);
      return { readPath: null, writePath: path };
    }
    current = isAbsolute(target) ? target : join(dirname(current), target);
  }
}

let cachedBinding: NativeSymlinkBinding | null | undefined;

function cachedNativeBinding(): NativeSymlinkBinding | null {
  if (cachedBinding === undefined) cachedBinding = requireNativeSymlinkBinding();
  return cachedBinding;
}

/**
 * Resolve `configPath`'s symlink chain to its real write target. Prefers the
 * native (conformance-tested) resolver, degrading to the JS mirror when the
 * addon is absent or throws — both follow the same algorithm, so the result is
 * identical across backends.
 *
 * `loadNative` is injectable so a test can force either backend deterministically
 * regardless of whether a `.node` is present on the host.
 */
export function resolveHarnessWritePaths(
  configPath: string,
  loadNative: () => NativeSymlinkBinding | null = cachedNativeBinding,
): SymlinkWritePaths {
  const native = loadNative();
  if (native) {
    try {
      const resolved = native.resolveSymlinkWritePath(configPath);
      return { readPath: resolved.readPath ?? null, writePath: resolved.writePath };
    } catch (err) {
      // An addon that loads but throws on this call degrades to the JS mirror
      // rather than crashing the write path on a binding that can't execute.
      // Surface it under OK_DEBUG_NATIVE so the broken binding is distinguishable
      // from a clean fallback, matching the sibling native catches.
      debugNativeLoadFailure('resolveSymlinkWritePath threw', err);
    }
  }
  return resolveSymlinkWritePathsJs(configPath);
}
