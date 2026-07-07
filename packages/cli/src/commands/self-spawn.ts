/**
 * Re-exec the currently-running CLI binary, rather than shelling out through
 * `npx @inkeep/open-knowledge <subcommand>`.
 *
 * Rationale: an MCP client running `@inkeep/open-knowledge@0.X` must NOT
 * auto-spawn `@inkeep/open-knowledge@0.Y` as its sibling — that would mix
 * lockfile ABIs across the new dual-process contract. `npx` with an unpinned
 * spec also carries a live-registry-fetch on first-invocation path and a
 * supply-chain surface (the sibling gets resolved via a mechanism the user
 * never opted into — `ok mcp` did it on their behalf).
 *
 * We instead re-invoke the exact binary currently executing — whichever the
 * user's install shape (global npm bin, `npx` cache, monorepo dev) resolved.
 *
 * Call sites:
 * - `ok mcp` spawning `ok start` (MCP-mediated auto-start)
 * - `ok start` spawning `ok ui` (sibling UI at startup)
 *
 * Packaged-Electron Dock-tile redirect: when the current process is the
 * packaged macOS app's Electron main binary, a detached spawn of
 * `process.execPath` makes LaunchServices register a duplicate `.app`
 * launch and `coreservicesd` parks a generic "exec" Dock tile for the
 * child's lifetime — one tile per auto-spawned server (and the
 * per-worktree-server topology means one tile per worktree). We redirect
 * the spawn to the `LSUIElement=true` helper bundle alongside the parent
 * app via `maybeRedirectToHelperBundle` below. Dev mode, non-darwin, and
 * npm-global-install shapes all fall through to `process.execPath`
 * unchanged — the predicate matches only the packaged-`.app` shape.
 */

import { existsSync } from 'node:fs';
import { resolveHelperBundleBinary } from '@inkeep/open-knowledge-core/helper-bundle';

const APP_CONTENTS_MACOS_RE = /\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/;

export interface MaybeRedirectToHelperBundleInput {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly exists: (path: string) => boolean;
}

/**
 * Decide whether a detached spawn should be redirected from the parent
 * `.app`'s main binary to the sibling helper bundle.
 *
 * Returns the helper-bundle binary path when ALL of the following hold:
 *   - `platform === 'darwin'`
 *   - `execPath` is inside a `…/<App>.app/Contents/MacOS/<exe>` slot
 *     (packaged-Electron shape; dev/`bun`/`node` execPaths fall through)
 *   - `exists(<helperPath>)` returns true (the packaged DMG actually
 *     shipped the helper — graceful no-op when an older packaged build
 *     pre-dating the helper bundle is running)
 *
 * Otherwise returns `null` — caller keeps the original `execPath`. The
 * `exists` callback is injected (not bound to `node:fs`) so the matrix
 * is unit-testable without writing to a real bundle on disk.
 *
 * Why this is a heuristic, not a clean signal. The CLI runs under
 * `ELECTRON_RUN_AS_NODE=1` when invoked from inside the packaged Electron
 * app, which means Electron's `app.isPackaged` is unavailable (the
 * `electron` module isn't loaded in Node mode). We infer the packaged
 * shape from the path structure (`.app/Contents/MacOS/<exe>`) plus a
 * filesystem probe for the helper sibling. The desktop's own spawn site
 * (`packages/desktop/src/main/resolve-detached-spawn-args.ts`) doesn't
 * need this heuristic — it runs in Electron main and gates on the real
 * `app.isPackaged` over the same `resolveHelperBundleBinary` mechanism.
 * The two predicates are intentionally NOT unified: collapsing them
 * would either (a) force the desktop to lose its authoritative signal,
 * or (b) push an unnecessary `exists` syscall into the desktop path.
 */
export function maybeRedirectToHelperBundle(
  input: MaybeRedirectToHelperBundleInput,
): string | null {
  if (input.platform !== 'darwin') return null;
  if (!APP_CONTENTS_MACOS_RE.test(input.execPath)) return null;
  const helperPath = resolveHelperBundleBinary(input.execPath);
  if (!input.exists(helperPath)) return null;
  return helperPath;
}

/** Override surface for `resolveSelfSpawn` — production calls the no-arg form. */
export interface ResolveSelfSpawnDeps {
  readonly execPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly argv?: readonly string[];
  readonly exists?: (path: string) => boolean;
}

/**
 * Returns the `(command, prefixArgs)` pair that re-invokes the current CLI.
 * The caller appends subcommand-specific args (e.g. `['start']`, `['ui']`).
 */
export function resolveSelfSpawn(deps: ResolveSelfSpawnDeps = {}): {
  command: string;
  prefixArgs: readonly string[];
} {
  const execPath = deps.execPath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const argv = deps.argv ?? process.argv;
  const exists = deps.exists ?? existsSync;

  // process.execPath is the absolute path of the Node/Bun runtime.
  // process.argv[1] is the entry script (the bin shim or the .ts source in dev).
  // Running `<runtime> <entry> <subcommand>` reproduces the invocation that
  // brought the current process up — same version, same runtime, no registry
  // round-trip, no cross-version ABI drift.
  const entry = argv[1];
  if (!entry) {
    // Should never happen for a normal CLI process — `process.argv[1]` is
    // populated whenever a script is executed via node/bun/npx/bin-shim. If
    // we hit this path, some unusual install shape (embedded runtime?
    // ExecSnapshot bundle?) has stripped argv[1]. Fall back to `npx` — the
    // pre-fix behavior — but WARN so operators notice the regression to
    // registry-fetch semantics rather than getting a silent downgrade.
    //
    // The fallback pins `@latest` (canonical shape, in sync with
    // `repair-mcp-configs.ts` / `repair-launch-json.ts`) so the engine-aware
    // sort in npm's `npm-pick-manifest` can't silently route the sibling
    // process to a years-stale release. `-y` suppresses the install-confirm
    // prompt under the non-TTY spawn paths (MCP shim, `spawnOkUi`). The
    // cross-version-pairing surface that re-exec was fixing still applies —
    // pinning only closes the silent-downgrade half, the registry round-trip
    // remains.
    console.warn(
      '[self-spawn] process.argv[1] is empty — falling back to `npx -y @inkeep/open-knowledge@latest`. ' +
        'This re-introduces the registry-fetch surface that re-exec was fixing. ' +
        `Observed argv: ${JSON.stringify(argv)}`,
    );
    return { command: 'npx', prefixArgs: ['-y', '@inkeep/open-knowledge@latest'] };
  }

  const redirected = maybeRedirectToHelperBundle({ execPath, platform, exists });
  const command = redirected ?? execPath;
  return { command, prefixArgs: [entry] };
}
