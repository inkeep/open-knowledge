/**
 * Process-lifecycle constants shared across the CLI's idle-shutdown
 * UI-sibling termination, the desktop's `stopAllOwnedServers` auto-update
 * teardown, and the spawn-error log convention used by every detached-
 * subprocess spawn site.
 *
 * Both timing constants (`DEFAULT_SIGTERM_GRACE_MS` + `DEFAULT_SIGTERM_POLL_MS`)
 * are calibrated against Hocuspocus's `destroyTimeoutMs` default (10 s) — the
 * upper bound for shadow-repo flush + L2 persistence + lock release. Picking a
 * grace shorter than that would escalate to SIGKILL on every clean shutdown.
 *
 * Consumers (CLI `start.ts` + desktop `window-manager.ts` + desktop
 * `index.ts` + MCP shim) import from this module so the constants stay in
 * lockstep — changing one place changes every behavior.
 */

/** Max wall-clock to wait for a SIGTERM to take before escalating to SIGKILL. */
export const DEFAULT_SIGTERM_GRACE_MS = 10_000;

/** Poll cadence while waiting for the server.lock to be released after SIGTERM. */
export const DEFAULT_SIGTERM_POLL_MS = 200;

/**
 * Filename under `<contentDir>/.ok/local/` that detached-subprocess spawn
 * sites redirect the child's stdio to. Three sites currently write here:
 *
 *   1. MCP shim's `resolveMcpHttpUrl` (`packages/cli/src/mcp/shim.ts`) —
 *      stderr only, so the parent can read it back and include in the
 *      timeout error when the spawned `ok start` doesn't write `server.lock`
 *      within `DEFAULT_SPAWN_TIMEOUT_MS`.
 *   2. CLI `spawnOkUi` (`packages/cli/src/commands/start.ts`) — stderr only;
 *      the `ok ui` sibling's failure mode surfaces here for the parent's
 *      `awaitUiSiblingPort` poll-timeout error.
 *   3. Desktop `spawnDetachedServer` (`packages/desktop/src/main/index.ts`) —
 *      stderr only (mirroring the peer sites), used both for diagnostic
 *      capture and for `spawn-lock-timeout` error enrichment.
 *
 * The shared filename means one tail target for operators and one constant
 * to change if the convention ever moves.
 */
export const SPAWN_ERROR_LOG = 'last-spawn-error.log';
