/**
 * Locates the native-config addon at runtime across the shapes OpenKnowledge
 * ships it in, returning the loaded module or null when no binary is available
 * for this platform — the normal no-prebuilt-binary case, where each consumer
 * keeps a non-destructive fallback (smol-toml parse / JS symlink mirror).
 *
 * The no-binary case is silent (expected), but a binary that is PRESENT yet
 * fails to load (an ABI / glibc-too-old / musl↔gnu mismatch / corrupt download —
 * a foreseeable mode across the prebuilt targets) is surfaced under
 * `OK_DEBUG_NATIVE`, so the broken-binary case is distinguishable from the
 * no-binary case instead of both degrading identically and silently.
 *
 * Resolution order:
 *  (a) the prebuilt binaries bundled into the published CLI at `dist/native/`.
 *      The npm CLI tarball carries every target's `.node` there (shipped via
 *      `files: ["dist"]`), and the packaged desktop ships that same bundled CLI,
 *      so its spawned `ok` subprocess resolves here too — this is the path that
 *      makes the format-preserving Codex write run for npm users off-macOS
 *      instead of silently degrading to the fallback.
 *  (b) the `@inkeep/open-knowledge-native-config` workspace package — dev, tests,
 *      and the desktop main process, whose declared dependency + asarUnpack place
 *      the addon on the module-resolution tree.
 *
 * Both consumers (the TOML engine and the symlink resolver) go through this one
 * loader so the dist-relative path is computed in a single place.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE_CONFIG_PACKAGE = '@inkeep/open-knowledge-native-config';

/** A `require` that failed because the module simply isn't there for this platform. */
function isModuleNotFound(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * Surface a present-but-broken native addon under `OK_DEBUG_NATIVE` (off by
 * default), so an ABI / glibc / musl mismatch on a shipped binary is debuggable
 * rather than silently identical to the no-binary case. stderr-only — the
 * classify path is sync and has no logger dependency, mirroring the file-lock
 * stale-recovery warning surface.
 */
export function debugNativeLoadFailure(context: string, err: unknown): void {
  if (!process.env.OK_DEBUG_NATIVE) return;
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[ok] native-config ${context}: ${message}\n`);
}

/**
 * The napi loader's path relative to the published CLI's `dist/` entry. tsdown
 * bundles every source module into `dist/{cli,index}.mjs`, so `import.meta.url`
 * at runtime is that bundled file and its dir is `dist/`; the CLI build copies
 * the addon's loader + `.node` files into `dist/native/`.
 */
const BUNDLED_LOADER_SUBPATH = ['native', 'index.js'];

/**
 * Injection seam for tests: a module requirer plus the URL the dist-relative
 * path is computed from. Defaults resolve against this module's real location.
 */
export interface NativeConfigResolver {
  requireModule: (id: string) => unknown;
  moduleUrl: string;
}

/**
 * Resolve the native-config addon module, or null when neither the bundled
 * binaries nor the workspace package can be loaded. Never throws — a missing
 * binary is the expected platform case, not an error.
 */
export function requireNativeConfigModule(
  resolver: Partial<NativeConfigResolver> = {},
): unknown | null {
  const moduleUrl = resolver.moduleUrl ?? import.meta.url;
  const requireModule = resolver.requireModule ?? createRequire(moduleUrl);

  try {
    const here = dirname(fileURLToPath(moduleUrl));
    return requireModule(join(here, ...BUNDLED_LOADER_SUBPATH));
  } catch (err) {
    // Not running from the published bundle (dev/test), or no binary for this
    // platform — fall through to the workspace package. A bundled loader that
    // exists but throws something other than "module not found" is a broken
    // binary, surfaced under OK_DEBUG_NATIVE.
    if (!isModuleNotFound(err)) debugNativeLoadFailure('bundled loader failed to load', err);
  }

  try {
    return requireModule(NATIVE_CONFIG_PACKAGE);
  } catch (err) {
    if (!isModuleNotFound(err)) debugNativeLoadFailure('workspace addon failed to load', err);
    return null;
  }
}
