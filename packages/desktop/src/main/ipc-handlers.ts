/**
 * Pure, injectable IPC handler implementations for Open-in-Agent scheme
 * detection and Cursor two-step folder-spawn.
 *
 * Each exported function takes an explicit `deps` object + channel args and
 * returns the channel result. Registration (binding to `ipcMain.handle` via
 * `createHandler`) happens in `main/index.ts` — the ONLY main-process file
 * allowed to touch raw electron IPC primitives (enforced by the
 * `no-loosely-typed-webcontents-ipc` biome rule).
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
  createOsProbe,
  type ExecFileLike,
  INSTALLED_AGENTS_SCHEMES,
  type InstalledAgentScheme,
  resolveCursorBinaryDefault,
  resolveCursorSpawnInvocation,
} from '@inkeep/open-knowledge-server';
import type { HandoffStatsLine, SpawnOutcome } from '../shared/ipc-channels.ts';
import { isPathWithinProject, validateSpawnPath } from './path-containment.ts';

// Re-exported so the sole remaining consumer (asset-allowlist.ts) keeps its
// import site; the implementations live in the leaf module.
export { isPathWithinProject, validateSpawnPath };

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const WHICH_TIMEOUT_MS = 500;
const SPAWN_TIMEOUT_MS = 2000;

/** Shape of the Electron `app.getApplicationInfoForProtocol` return. */
interface AppInfo {
  /** Display name of the handler (e.g. "Claude"). */
  name: string;
  /** Filesystem path of the handler binary (used by spawnCursor). */
  path: string;
}

/** Injected by main/index.ts; replaceable in tests with stubbed Promise returns. */
interface DetectProtocolDeps {
  /** `process.platform` at call time. Drives the macOS+Windows vs Linux branch. */
  platform: NodeJS.Platform;
  /**
   * Wraps `app.getApplicationInfoForProtocol(url)`. Rejects when the scheme
   * has no registered handler — caught and translated to `{installed:false}`.
   * Kept as an injected dep so unit tests don't need a live Electron app.
   */
  getApplicationInfoForProtocol: (url: string) => Promise<AppInfo>;
  /**
   * macOS fallback: invoked when `getApplicationInfoForProtocol` returns
   * empty. Same `osascript -e 'id of app "<name>"'` probe the web-host
   * `/api/installed-agents` endpoint uses; covers the case where the app
   * claims the URL scheme via `Info.plist` but the user has never
   * confirmed a default handler in `~/Library/Preferences/com.apple.LaunchServices`.
   * Default implementation routes through `createOsProbe` from the server
   * package so detection logic stays in one place.
   */
  runMacOsProbe?: (scheme: InstalledAgentScheme) => Promise<boolean>;
  /**
   * Linux fallback: `xdg-mime query default x-scheme-handler/<scheme>`.
   * Non-empty stdout → installed. Default implementation uses `execFile`
   * with a hard timeout; overridable for tests.
   */
  runXdgMime?: (scheme: string, timeoutMs: number) => Promise<{ stdout: string; code: number }>;
  /** Probe-wide timeout. Defaults to `DEFAULT_PROBE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Default macOS osascript probe — shared with the server-side install detector. */
const macOsProbeReal: (scheme: InstalledAgentScheme) => Promise<boolean> = createOsProbe(
  'darwin',
  execFile as ExecFileLike,
);

/** Type guard: `scheme` is one of the schemes the macOS probe knows how to check. */
function isInstalledAgentScheme(scheme: string): scheme is InstalledAgentScheme {
  return (INSTALLED_AGENTS_SCHEMES as readonly string[]).includes(scheme);
}

function xdgMimeReal(scheme: string, timeoutMs: number): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'xdg-mime',
      ['query', 'default', `x-scheme-handler/${scheme}`],
      { timeout: timeoutMs, encoding: 'utf-8' },
      (err, stdout) => {
        if (err) {
          // Treat timeout / missing xdg-mime / non-zero exit as "not registered"
          // — the return shape collapses everything to the conservative default
          // that renders the row disabled. Logging happens at the caller layer
          // if diagnostic signal is ever needed.
          resolve({ stdout: '', code: typeof err.code === 'number' ? err.code : 1 });
          return;
        }
        resolve({ stdout, code: 0 });
      },
    );
  });
}

/**
 * Probe whether `<scheme>:` has a default handler registered on this OS.
 * Returns the conservative `{installed:false}` on any failure so the
 * dropdown row renders disabled-with-tooltip instead of crashing.
 */
export async function detectProtocol(
  deps: DetectProtocolDeps,
  scheme: string,
): Promise<{ installed: boolean; displayName?: string }> {
  // Reject obviously malformed inputs up front — empty or non-RFC-3986-ish
  // scheme strings would interpolate into shell commands on the Linux path.
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) {
    return { installed: false };
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  if (deps.platform === 'darwin' || deps.platform === 'win32') {
    try {
      const info = await Promise.race([
        deps.getApplicationInfoForProtocol(`${scheme}://`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);
      if (info.name && info.path) {
        return { installed: true, displayName: info.name };
      }
      // Empty `name` / `path` (Windows behavior) OR no LaunchServices default
      // handler set (macOS behavior — happens for apps that claim a scheme via
      // `Info.plist` but the user has never confirmed a default). Fall through
      // to the macOS osascript probe before declaring not-installed.
    } catch {
      // Promise rejected — same fall-through as the empty-info case below.
    }
    if (deps.platform === 'darwin' && isInstalledAgentScheme(scheme)) {
      const probe = deps.runMacOsProbe ?? macOsProbeReal;
      try {
        if (await probe(scheme)) return { installed: true };
      } catch {
        // Fallback failure is the same outcome as primary failure.
      }
    }
    return { installed: false };
  }

  // Linux path — Electron's `getApplicationInfoForProtocol` is mac+Windows
  // only. Fall back to `xdg-mime`, the same probe the web-host endpoint uses.
  const runner = deps.runXdgMime ?? xdgMimeReal;
  try {
    const { stdout } = await runner(scheme, timeoutMs);
    const trimmed = stdout.trim();
    if (!trimmed) return { installed: false };
    // xdg-mime returns something like `anthropic-claude.desktop`. We don't
    // have a display name surface on Linux; the dropdown's label still comes
    // from `KNOWN_TARGETS.displayName`.
    return { installed: true };
  } catch {
    return { installed: false };
  }
}

interface SpawnCursorDeps {
  /**
   * Primary resolver: probes known bundle shim paths under `/Applications`,
   * `~/Applications` (macOS), or `%LOCALAPPDATA%\Programs\cursor` (Windows)
   * via `fs.access`, then falls back to a bounded `which`/`where`. Never
   * trusts arbitrary `$PATH` first. Defaults to `resolveCursorBinaryDefault`.
   */
  resolveCursorBinary?: (timeoutMs: number) => Promise<string | null>;
  /**
   * Fallback resolver: Electron's OS-registered protocol handler. Consulted
   * only when `resolveCursorBinary` returns `null` or throws.
   */
  getApplicationInfoForProtocol: (url: string) => Promise<AppInfo>;
  /**
   * Spawns the resolved `exec` with `args` argv. Must pass `shell:false` and
   * an argv array (not a command string). Resolves `{ok:true}` on successful
   * spawn (not on process exit) or `{ok:false, reason}` otherwise.
   */
  spawn: (exec: string, args: ReadonlyArray<string>, timeoutMs: number) => Promise<SpawnOutcome>;
  platform: NodeJS.Platform;
  /**
   * Project root of the caller window. When present, `spawnCursor` refuses
   * any user-supplied path that doesn't resolve at or under this root — a
   * renderer compromise can't steer Cursor at arbitrary filesystem locations
   * (`~/.ssh`, `/etc`, ...). When absent (Navigator window has no project
   * context), the check is skipped.
   */
  projectPath?: string;
  /** Resolve-phase timeout. Defaults to `WHICH_TIMEOUT_MS`. */
  resolveTimeoutMs?: number;
  /** Spawn-phase timeout. Defaults to `SPAWN_TIMEOUT_MS`. */
  spawnTimeoutMs?: number;
}

// `resolveSpawnInvocation` (the macOS `.app` → `/usr/bin/open -a` redirect) is
// now imported from `@inkeep/open-knowledge-server` as
// `resolveCursorSpawnInvocation`. Single source of truth across both
// transports — same redirect logic runs in `POST /api/spawn-cursor` and in
// this Electron IPC `spawnCursor`, so a future fix only needs one edit.

// Cursor binary discovery (`whichCursorReal`) is now imported from
// `@inkeep/open-knowledge-server` as `resolveCursorBinaryDefault`. Both
// transports — this file's Electron IPC and the server's
// `POST /api/spawn-cursor` endpoint — share one canonical implementation
// so adding a new bundle path or fixing the discovery logic only needs
// to change in one place.

/**
 * Step 1 of the Cursor two-step handoff — spawn `cursor <projectDir>` so the
 * workspace is already open before the cursor:// prompt URL fires (step 2).
 *
 * If `deps.projectPath` is supplied, `path` must resolve at or under it;
 * otherwise the spawn is refused with `invalid-path`. Bounds a renderer
 * compromise from steering Cursor at arbitrary filesystem locations.
 */
export async function spawnCursor(deps: SpawnCursorDeps, path: string): Promise<SpawnOutcome> {
  if (!validateSpawnPath(path, deps.platform)) {
    return { ok: false, reason: 'invalid-path' };
  }
  // Skip-on-undefined `projectPath`. Sibling `showItemInFolder` refuses on
  // undefined (its safer default) — the divergence is intentional.
  if (
    deps.projectPath !== undefined &&
    !isPathWithinProject(path, deps.projectPath, deps.platform)
  ) {
    return { ok: false, reason: 'invalid-path' };
  }

  // Prefer the Cursor CLI shim for folder opens. Empirically, `cursor <dir>`
  // registers/focuses the workspace more reliably than macOS Launch Services
  // `open -a Cursor.app <dir>` for folders outside normal project locations
  // (e.g. paths containing spaces under Documents). The default resolver does
  // not trust arbitrary cwd/PATH first: on macOS/Windows it probes known bundle
  // shim paths before bounded `which`/`where`. Fall back to Electron's protocol
  // handler only when the CLI shim cannot be resolved.
  const resolver = deps.resolveCursorBinary ?? resolveCursorBinaryDefault;
  let binaryPath: string | null = null;
  try {
    binaryPath = await resolver(deps.resolveTimeoutMs ?? WHICH_TIMEOUT_MS);
  } catch {
    binaryPath = null;
  }

  if (!binaryPath) {
    try {
      const info = await deps.getApplicationInfoForProtocol('cursor://');
      if (info.path) binaryPath = info.path;
    } catch {
      binaryPath = null;
    }
  }

  if (!binaryPath) {
    return { ok: false, reason: 'not-installed' };
  }

  const { exec, args } = resolveCursorSpawnInvocation(binaryPath, path, deps.platform);
  return deps.spawn(exec, args, deps.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS);
}

/**
 * Outcome of a `showItemInFolder` invocation — observable in main logs / tests.
 * The wire shape collapses every refusal to `undefined` (silent-by-design — see
 * the handler in `main/index.ts`). This internal type widens the refusal so the
 * main-side breadcrumb log distinguishes the three branches: format failure,
 * no project bound, escape from project. `SpawnOutcome`'s collapsed shape is
 * forced because its reason IS exposed on the wire; this one is not.
 */
type ShowItemInFolderOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid-format' | 'no-project-bound' | 'out-of-project' };

/** Injected deps for `showItemInFolder` — the electron `shell.showItemInFolder` and platform/projectPath. */
interface ShowItemInFolderDeps {
  readonly platform: NodeJS.Platform;
  /** Caller window's project directory; if omitted, only `allowedRoots` paths are permitted. */
  readonly projectPath: string | undefined;
  /**
   * Extra trusted roots the path may lie under besides the project — for
   * main-produced artifacts that legitimately live outside any project (the
   * bug-report zip in `~/.ok/bug-reports/`). These are constant, main-derived
   * directories, never renderer-influenced, so admitting them keeps the
   * containment guarantee that bounds a compromised renderer.
   */
  readonly allowedRoots?: readonly string[];
  /** Wraps `electron.shell.showItemInFolder`. Replaceable in tests. */
  readonly showItemInFolder: (path: string) => void;
}

/**
 * Reveal the given path in the OS file manager. The path must be absolute,
 * free of null bytes, and lie at or under `deps.projectPath` OR one of
 * `deps.allowedRoots` — otherwise the call is refused. Bounds a renderer
 * compromise from steering the OS file manager at arbitrary filesystem
 * locations. Same defense pattern as `spawnCursor`.
 *
 * A window with no bound project (Navigator) can still reveal an
 * `allowedRoots` path; only when neither the project nor any allowed root
 * contains the path is the reveal refused.
 */
export function showItemInFolder(
  deps: ShowItemInFolderDeps,
  path: string,
): ShowItemInFolderOutcome {
  if (!validateSpawnPath(path, deps.platform)) {
    return { ok: false, reason: 'invalid-format' };
  }
  const withinAllowedRoot = (deps.allowedRoots ?? []).some((root) =>
    isPathWithinProject(path, root, deps.platform),
  );
  if (!withinAllowedRoot) {
    if (deps.projectPath === undefined) {
      return { ok: false, reason: 'no-project-bound' };
    }
    if (!isPathWithinProject(path, deps.projectPath, deps.platform)) {
      return { ok: false, reason: 'out-of-project' };
    }
  }
  deps.showItemInFolder(path);
  return { ok: true };
}

/**
 * Wire-exposed outcome for `ok:shell:trash-item`. Mirrors the channel
 * declaration in `shared/ipc-channels.ts` and the bridge contract — keep all
 * three in sync. Unlike `ShowItemInFolderOutcome` (which collapses to wire
 * `undefined` for renderer-trust reasons), the trash outcome IS surfaced on
 * the wire because the renderer needs to render the trash-failure fallback
 * modal with the exact reason + OS-provided detail string. The detail field
 * carries the macOS `NSError.localizedDescription` when present so the modal
 * can be verbatim with the OS message.
 */
type TrashItemReason = 'not-found' | 'permission-denied' | 'system-error' | 'path-escape';

type TrashItemOutcome = { ok: true } | { ok: false; reason: TrashItemReason; detail?: string };

/** Injected deps for `trashItem`. */
interface TrashItemDeps {
  readonly platform: NodeJS.Platform;
  /**
   * Caller window's project directory; if omitted, refuses every path —
   * Navigator windows have no bound project and must never be allowed to
   * trash arbitrary filesystem locations. Returns `path-escape` with a
   * `detail` distinguishing this from a containment-violation refusal.
   */
  readonly projectPath: string | undefined;
  /**
   * Canonicalize the path on disk before the containment check. Failure
   * here means the file is genuinely absent (typical: file was already
   * trashed in another window). Default wiring uses `node:fs.realpathSync`;
   * replaceable in tests so we can stub ENOENT / EACCES / other classes
   * without touching real disk.
   */
  readonly realpath: (path: string) => string;
  /**
   * Wraps `electron.shell.trashItem`. Resolves on success; rejects with an
   * `Error` (sometimes carrying `code: 'EPERM'` / `'EACCES'` / `'ENOENT'`
   * for filesystem-class failures, sometimes carrying NSError-bridged
   * `localizedDescription` for backend failures incl. OneDrive
   * (electron#38541) and tmpfs (electron#28045)).
   */
  readonly trashItem: (path: string) => Promise<void>;
}

/**
 * Extract a human-readable detail string from a thrown trash error. Prefers
 * `localizedDescription` (macOS NSError → JS Error bridge) over `message`
 * because Electron's `shell.trashItem` carries the OS-provided string there
 * for backend failures. Falls back to `message` then `String(err)`.
 */
export function extractTrashDetail(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined;
  if (err instanceof Error) {
    const localized = (err as Error & { localizedDescription?: unknown }).localizedDescription;
    if (typeof localized === 'string' && localized.length > 0) return localized;
    if (err.message.length > 0) return err.message;
    return undefined;
  }
  const stringified = String(err);
  return stringified.length > 0 ? stringified : undefined;
}

/**
 * Classify a trash-stage error against the wire-exposed reason union. EPERM
 * and EACCES are the locked-file / read-only-filesystem class. ENOENT during
 * the trash call (after a successful realpath probe) indicates the file
 * disappeared in the race window — surface as `not-found` for UX coherence
 * with the realpath-stage outcome. Everything else (NSFeatureUnsupported,
 * cross-volume failures, network-drive backend errors) is `system-error`.
 */
function classifyTrashError(err: unknown): TrashItemReason {
  if (!(err instanceof Error)) return 'system-error';
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EPERM' || code === 'EACCES') return 'permission-denied';
  if (code === 'ENOENT') return 'not-found';
  return 'system-error';
}

/**
 * Move the given absolute path to the OS Trash. Mirrors `showItemInFolder`'s
 * defense pattern: validate format, refuse on no-bound-project, canonicalize
 * via realpath, enforce `isPathWithinProject` containment, then dispatch to
 * `shell.trashItem`. Renderer is sandboxed — without these gates, a
 * compromised renderer could trash arbitrary user-home content.
 *
 * NOT a `shell.openPath` site — the `openAssetSafely` STOP rule does NOT
 * apply.
 *
 * Outcome shape matches the wire contract one-for-one (see
 * `TrashItemOutcome`); main-side OTel emission lives in `index.ts` so the
 * span + histogram + counter context can read the outcome AFTER the handler
 * resolves.
 */
export async function trashItem(deps: TrashItemDeps, absPath: string): Promise<TrashItemOutcome> {
  if (!validateSpawnPath(absPath, deps.platform)) {
    return { ok: false, reason: 'path-escape', detail: 'invalid path format' };
  }
  if (deps.projectPath === undefined) {
    return { ok: false, reason: 'path-escape', detail: 'no project bound' };
  }
  let resolved: string;
  try {
    resolved = deps.realpath(absPath);
  } catch (err) {
    return { ok: false, reason: 'not-found', detail: extractTrashDetail(err) };
  }
  if (!isPathWithinProject(resolved, deps.projectPath, deps.platform)) {
    return { ok: false, reason: 'path-escape' };
  }
  try {
    await deps.trashItem(resolved);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: classifyTrashError(err),
      detail: extractTrashDetail(err),
    };
  }
}

/**
 * Local-only telemetry sink. Append-only writer to
 * `~/.ok/stats.jsonl` — one JSONL line per Open-in-Agent dispatch.
 * Zero phone-home.
 */
interface RecordHandoffDeps {
  /** `os.homedir()` — overridable in tests so a tmpdir stands in for `~`. */
  readonly homedir: () => string;
  /**
   * Append the JSONL line to the stats file. Default wiring uses
   * `fs.promises.appendFile` with utf-8 encoding. Errors thrown by this dep
   * (EACCES / ENOSPC / read-only filesystem) are caught and logged — the
   * caller's promise still resolves so dispatch is never affected.
   */
  readonly appendFile: (path: string, content: string) => Promise<void>;
  /**
   * Ensure the parent directory exists. Default wiring uses
   * `fs.promises.mkdir(path, { recursive: true })`. Errors here are also
   * caught (alongside append errors) and routed through `warn`.
   */
  readonly mkdir?: (path: string) => Promise<void>;
  /** Diagnostic sink for failed appends. Defaults to `console.warn`. */
  readonly warn?: (message: string) => void;
}

/** Path to the stats file relative to HOME. Centralized so tests can assert on it. */
export const STATS_FILE_RELATIVE_PATH = ['.ok', 'stats.jsonl'] as const;

/**
 * Append one JSONL line to the local stats sink. Failure NEVER throws — a
 * write error is logged via `warn` and the function resolves. Dispatch path
 * is the only consumer; it must not depend on telemetry success.
 */
export async function recordHandoff(
  deps: RecordHandoffDeps,
  line: HandoffStatsLine,
): Promise<void> {
  const home = deps.homedir();
  const dir = join(home, STATS_FILE_RELATIVE_PATH[0]);
  const file = join(dir, STATS_FILE_RELATIVE_PATH[1]);
  const json = `${JSON.stringify(line)}\n`;

  const warn = deps.warn ?? ((m: string) => console.warn(m));
  try {
    if (deps.mkdir) {
      await deps.mkdir(dir);
    }
    await deps.appendFile(file, json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[handoff] recordHandoff failed (telemetry skipped): ${reason}`);
  }
}
