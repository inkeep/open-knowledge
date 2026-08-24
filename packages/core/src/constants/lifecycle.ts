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
 * sites redirect the child's stdio to. Two sites currently write here:
 *
 *   1. MCP shim's `resolveMcpHttpUrl` (`packages/cli/src/mcp/shim.ts`) —
 *      stderr only, so the parent can read it back and include in the
 *      timeout error when the spawned `ok start` doesn't write `server.lock`
 *      within `DEFAULT_SPAWN_TIMEOUT_MS`.
 *   2. Desktop `spawnDetachedServer` (`packages/desktop/src/main/index.ts`) —
 *      stderr only (mirroring the peer site), used both for diagnostic
 *      capture and for `spawn-lock-timeout` error enrichment.
 *
 * The shared filename means one tail target for operators and one constant
 * to change if the convention ever moves.
 */
export const SPAWN_ERROR_LOG = 'last-spawn-error.log';

/**
 * Filename under `<projectRoot>/.ok/local/` where the desktop host records why
 * the server process last exited. Written by the desktop main process (which
 * observes the child's death even when the child could not report it) and
 * collected into a bug-report bundle's `state/` dir beside `server.lock`.
 *
 * JSON object, one record, last write wins — read `at` before anything else,
 * since a record from a healthy session is simply the last exit, not a current
 * one. Fields: `at` (ISO timestamp), `pid`, `code` (null when a signal killed
 * it), `signal` (POSIX signal name; null or absent otherwise), `observer`
 * (which host saw the death) and `reason` (Electron's process-gone
 * classification, or null). Electron's reason values are forwarded verbatim
 * and its set grows across releases — `clean-exit` / `abnormal-exit` /
 * `killed` / `crashed` / `oom` / `launch-failed` / `integrity-failure` /
 * `memory-eviction` as of Electron 43 — so treat an unrecognised string as a
 * newer classification rather than a corrupt record. No format-version field:
 * like `SentinelState`, the shape is read across app versions and stays
 * compatible by being add-only, so a reader treats any field it does not find
 * as unknown rather than as a value.
 *
 * `observer` says how the nullable fields read, because availability differs by
 * which host saw the death. `utility-process` is the development Electron
 * `utilityProcess` fork: it reports a `code` but never a `signal`, and Electron
 * can classify it, so a null `reason` there means the correlation window
 * produced nothing. `detached-spawn` is the packaged plain OS process: on POSIX
 * it reports both `code` and `signal`, and Electron cannot classify it at all,
 * so `reason` is always null there, meaning "not observable on this path"
 * rather than "unclassified".
 *
 * On Windows `signal` is null for *every* death including the app's own: libuv
 * records a signal only for a kill routed through the child's own handle, and
 * the desktop kills by pid. `code` is no substitute — libuv terminates with
 * `TerminateProcess(handle, 1)` for every supported signal and reports that
 * literal status, so a managed stop and a voluntary `exit(1)` are both
 * `{code: 1, signal: null}`. There the record narrows to `code: 0` = orderly
 * stop, anything else = unresolved.
 *
 * Only a server the desktop session itself spawned is observed. When a window
 * attaches to a server an earlier session left running there is no child handle
 * and no exit listener, so an absent record means "this session never owned the
 * child" as often as it means "nothing died".
 *
 * This closes a diagnostic gap: without it, a bundle can't tell a server that
 * crashed or was OS-killed from one that shut down cleanly — the liveness
 * probe only reports "unreachable" either way.
 */
export const SERVER_EXIT_LOG = 'last-server-exit.json';

/**
 * Filename under `<projectRoot>/.ok/local/` where the server process itself
 * records a fatal crash (uncaught exception / unhandled rejection) on its way
 * down — timestamp, error name/message/stack, pid, uptime. Written by the
 * server's crash-capture monitor (`packages/server/src/crash-capture.ts`)
 * with synchronous fs so the record survives the hard exit that loses the
 * async log sink's unwritten tail. Collected into bug-report bundles beside
 * `SERVER_EXIT_LOG`.
 *
 * Complements `SERVER_EXIT_LOG`: the desktop host records *that* the child
 * died (exit code, killing signal, and a classification where its host can
 * observe one) from the outside; this file records *why* from the inside — the
 * stack no other artifact reliably captures. Written by the server itself, so
 * unlike its sibling it also covers a server started by `ok start`.
 */
export const SERVER_CRASH_LOG = 'last-server-crash.json';
