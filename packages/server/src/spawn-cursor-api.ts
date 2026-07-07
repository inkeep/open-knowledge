/**
 * POST /api/spawn-cursor — server-side `cursor <path>` spawn for the web host.
 *
 * Cursor's deep-link API has no single-call "open this folder" semantic; you
 * have to invoke the `cursor` CLI to spawn the workspace window, then fire
 * `cursor://anysphere.cursor-deeplink/prompt?...` to seed the prompt. Browsers
 * can't spawn processes, so the OK web UI defers step 1 to the server (which
 * runs on the user's machine via `open-knowledge start` and has filesystem +
 * `child_process` access).
 *
 * Sibling of:
 *   - Electron IPC `ok:shell:spawn-cursor` in
 *     `packages/desktop/src/main/ipc-handlers.ts` (electron host)
 *   - GET `/api/installed-agents` in `./handoff-api.ts` (install detection)
 *
 * HTTP wire shape follows RFC 9457 (codebase precedent #39): 4xx/5xx errors
 * emit `application/problem+json` via `errorResponse(...)`; 200 success
 * emits empty `{}` via `successResponse(SpawnCursorSuccessSchema, ...)`.
 *
 * Note: after the `/api/handoff` unification, the OK renderer's Open-in-
 * Cursor dispatch goes through `packages/app/src/lib/handoff/dispatch.ts`
 * → `POST /api/handoff` (target: `cursor`), and the handoff dispatcher in
 * turn reuses the helpers in this file (`isPathWithinDir`,
 * `resolveCursorBinaryDefault`, `resolveCursorSpawnInvocation`). `/api/spawn-
 * cursor` remains for direct/legacy callers and as the install-state
 * sibling of `/api/installed-agents` — the wire shape contract above
 * still governs it. The Electron IPC layer (`ok:shell:spawn-cursor`)
 * keeps its typed `SpawnOutcome` contract via `createHandler` /
 * `createInvoker` — RFC 9457 is HTTP-only
 * by construction (it specifies media type `application/problem+json`).
 *
 * Security model — same shape as `/api/workspace`:
 *   - Loopback-only (TCP peer + Host header gates) — endpoint is unreachable
 *     over network.
 *   - Path containment: the requested path must canonically resolve at or
 *     under `contentDir`. A renderer compromise can't steer Cursor at
 *     arbitrary filesystem locations (`~/.ssh`, `/etc`, …).
 *   - Hardcoded `cursor` binary, argv-array (`shell: false`) — no shell
 *     interpolation, no user-supplied executable.
 *   - Detached + `stdio: 'ignore'` + `unref()` — OK does not parent Cursor's
 *     process tree, so killing OK doesn't kill Cursor.
 *
 * Loopback gating is applied at the route registration layer in
 * `api-extension.ts`, not here, to match the convention for `/api/workspace`
 * and `/api/installed-agents`.
 */

import { execFile } from 'node:child_process';
import { access, constants as fsConstants } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';
import { SpawnCursorSuccessSchema } from '@inkeep/open-knowledge-core';
import { errorResponse } from './http/error-response.ts';
import {
  PayloadTooLargeError,
  RequestBodyTimeoutError,
  readBoundedJsonBody,
} from './http/request-validation.ts';
import { successResponse } from './http/success-response.ts';
import { spawnDetached as spawnDetachedReal } from './spawn-detached.ts';

const SPAWN_CURSOR_WHICH_TIMEOUT_MS = 500;
const SPAWN_CURSOR_SPAWN_TIMEOUT_MS = 2000;
const SPAWN_CURSOR_MAX_BODY_BYTES = 4 * 1024;
// 5s body-read timeout — much tighter than `withValidation`'s 30s budget
// because (a) the endpoint is loopback-only (gated at the route layer), so
// network-induced slowness is implausible, and (b) the 4 KB payload cap
// completes in microseconds over loopback, sub-second over even a slow VPN.
// 5s is generous headroom for legitimate clients while bounding slowloris
// handler-slot occupancy 6× tighter than the general case.
const SPAWN_CURSOR_BODY_READ_TIMEOUT_MS = 5_000;
const HANDLER = 'spawn-cursor';

function assertNeverSpawnReason(_reason: never): never {
  throw new Error(`Unhandled spawn-cursor outcome.reason: ${String(_reason)}`);
}

/**
 * Internal outcome shape returned by the injected `spawnDetached` dependency.
 * The handler translates these reasons to RFC 9457 URN tokens at the wire
 * boundary; injection sites (default `spawnDetachedReal`, test doubles)
 * never construct problem+json bodies themselves.
 */
export type SpawnCursorOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid-path' | 'not-installed' | 'timeout' | 'spawn-error' };

export interface HandleSpawnCursorDeps {
  /** Absolute path to the workspace's content directory. Used for path containment. */
  contentDir: string;
  /** `process.platform` at call time — drives Windows vs POSIX path resolution. */
  platform: NodeJS.Platform;
  /**
   * Resolves the path to the `cursor` binary (or `null` if not installed).
   * Default: shells out to `which cursor` / `where cursor` with a 500 ms
   * timeout. Override in tests for hermeticity.
   */
  resolveCursorBinary?: (timeoutMs: number) => Promise<string | null>;
  /**
   * Spawns a detached process and resolves with the internal outcome shape.
   * Default: `child_process.spawn(exec, args, { detached: true, stdio: 'ignore', shell: false })`
   * + `unref()`. Override in tests.
   */
  spawnDetached?: (
    exec: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ) => Promise<SpawnCursorOutcome>;
}

/** POST /api/spawn-cursor handler. Loopback gating is applied by the caller. */
export async function handleSpawnCursor(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleSpawnCursorDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: HANDLER,
      extraHeaders: { Allow: 'POST' },
    });
    return;
  }

  let body: Buffer;
  try {
    body = await readBoundedJsonBody(req, {
      maxBytes: SPAWN_CURSOR_MAX_BODY_BYTES,
      timeoutMs: SPAWN_CURSOR_BODY_READ_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      errorResponse(res, 413, 'urn:ok:error:payload-too-large', 'Payload too large.', {
        handler: HANDLER,
        cause: err,
      });
      return;
    }
    if (err instanceof RequestBodyTimeoutError) {
      errorResponse(res, 408, 'urn:ok:error:request-timeout', 'Request body read timed out.', {
        handler: HANDLER,
        cause: err,
      });
      return;
    }
    // Catch-all for transport-class errors (ERR_STREAM_PREMATURE_CLOSE,
    // ERR_STREAM_DESTROYED, native AbortError variants). Surface as 500 so
    // SDK retry semantics match — a client receiving 400/413 for a
    // transport failure would retry unchanged believing it sent bad data.
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read request body.', {
      handler: HANDLER,
      cause: err,
    });
    return;
  }

  let parsed: { path?: unknown };
  try {
    parsed = JSON.parse(body.toString('utf-8')) as { path?: unknown };
  } catch (err) {
    errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Malformed JSON body.', {
      handler: HANDLER,
      cause: err,
    });
    return;
  }

  const userPath = typeof parsed.path === 'string' ? parsed.path : '';
  if (!userPath) {
    errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing or empty `path` field.', {
      handler: HANDLER,
    });
    return;
  }

  if (!isPathWithinDir(userPath, deps.contentDir, deps.platform)) {
    errorResponse(res, 403, 'urn:ok:error:path-escape', 'Path escapes the content directory.', {
      handler: HANDLER,
    });
    return;
  }

  const resolveCursorBinary = deps.resolveCursorBinary ?? resolveCursorBinaryDefault;
  const exec = await resolveCursorBinary(SPAWN_CURSOR_WHICH_TIMEOUT_MS);
  if (!exec) {
    errorResponse(
      res,
      422,
      'urn:ok:error:cursor-not-installed',
      'Cursor CLI not found on this machine.',
      { handler: HANDLER },
    );
    return;
  }

  const invocation = resolveCursorSpawnInvocation(exec, userPath, deps.platform);
  const spawn = deps.spawnDetached ?? spawnDetachedReal;
  const outcome = await spawn(invocation.exec, invocation.args, SPAWN_CURSOR_SPAWN_TIMEOUT_MS);
  if (outcome.ok) {
    successResponse(res, 200, SpawnCursorSuccessSchema, {}, { handler: HANDLER });
    return;
  }
  switch (outcome.reason) {
    case 'not-installed':
      errorResponse(
        res,
        422,
        'urn:ok:error:cursor-not-installed',
        'Cursor CLI not found on this machine.',
        { handler: HANDLER },
      );
      return;
    case 'timeout':
      errorResponse(
        res,
        504,
        'urn:ok:error:cursor-spawn-timeout',
        'Cursor spawn exceeded the deadline.',
        { handler: HANDLER },
      );
      return;
    case 'spawn-error':
      errorResponse(res, 502, 'urn:ok:error:cursor-spawn-failed', 'Cursor spawn failed.', {
        handler: HANDLER,
      });
      return;
    case 'invalid-path':
      // The handler ran path-containment ahead of spawn; an `invalid-path`
      // outcome from the spawn primitive itself means the dependency
      // produced an outcome the handler's gate already rejected. Surface
      // as `path-escape` for SDK-consumer parity with the pre-spawn gate
      // (same 403 + URN — they're indistinguishable to the client).
      errorResponse(res, 403, 'urn:ok:error:path-escape', 'Path escapes the content directory.', {
        handler: HANDLER,
      });
      return;
    default:
      // Exhaustiveness floor: a future addition to
      // SpawnCursorOutcome.reason would otherwise silently fall through
      // here, leaving the connection hanging until the server-level 60s
      // request timeout. This throws so the outer try/catch in
      // api-extension.ts emits 500 problem+json instead.
      return assertNeverSpawnReason(outcome.reason);
  }
}

/**
 * Well-known absolute paths to Cursor's bundled CLI shim, per platform.
 * Each app installer drops the shim at a fixed location relative to the
 * install root, so probing those paths directly with `fs.access(X_OK)` is
 * faster and more reliable than `which cursor` / `where cursor` — neither
 * requires the user to have set up the CLI shim on `$PATH`, which is the
 * most common reason `which cursor` returns nothing on a freshly-installed
 * Cursor.
 *
 * Linux entries are intentionally absent: Cursor's Linux distribution
 * (AppImage / `.deb` / Snap / Flatpak) varies by install method with no
 * canonical filesystem path, so PATH lookup is the only reliable strategy
 * there. macOS and Windows installers do place the shim deterministically.
 *
 * Each candidate is a function of the OS user's home directory so we don't
 * hardcode `~` literally — `homedir()` is canonical even when `$HOME` is
 * unset (test runners, CI, sandboxed Electron utility processes).
 *
 * Exported because the same discovery runs in both the loopback HTTP path
 * (this file's `handleSpawnCursor`) and the Electron IPC path
 * (`packages/desktop/src/main/ipc-handlers.ts`'s `spawnCursor`). Drift
 * between the two would mean Cursor handoff works on web but fails in
 * Desktop (or vice-versa) — sharing the constant prevents that class of bug.
 */
export const CURSOR_BUNDLE_PATHS_BY_PLATFORM: Partial<
  Record<NodeJS.Platform, ReadonlyArray<(home: string) => string>>
> = {
  // macOS: standard `/Applications` first, then user-scoped `~/Applications`.
  darwin: [
    () => '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
    (home) => `${home}/Applications/Cursor.app/Contents/Resources/app/bin/cursor`,
  ],
  // Windows: per-user installer drops to `%LOCALAPPDATA%\Programs\cursor\…`;
  // admin installer drops to `Program Files`. The `.cmd` shim is what
  // `where cursor` would surface when on PATH; spawn it directly here.
  win32: [
    (home) => `${home}\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd`,
    () => 'C:\\Program Files\\Cursor\\resources\\app\\bin\\cursor.cmd',
  ],
  // Linux: deliberate absence — too many install methods, no single path.
};

/**
 * Resolve the Cursor binary OS-agnostically. macOS + Windows: try the
 * platform's well-known bundle paths first; fall back to `which`/`where` for
 * Homebrew Cask / MacPorts / Snap / non-standard installs. Linux: PATH only.
 *
 * Returns `null` when no probe succeeds inside `timeoutMs`. The bundle-path
 * probe itself is `fs.access`-based and effectively instantaneous, so the
 * timeout primarily bounds the PATH-lookup `execFile`.
 *
 * Exported as the canonical default for both transports — the HTTP handler
 * here and the Electron IPC `spawnCursor`. Test seam: both call sites
 * accept a `resolveCursorBinary` injection point, so this default never
 * runs under unit tests (only in production / smoke tests).
 */
export async function resolveCursorBinaryDefault(timeoutMs: number): Promise<string | null> {
  const candidates = CURSOR_BUNDLE_PATHS_BY_PLATFORM[process.platform];
  if (candidates && candidates.length > 0) {
    const home = homedir();
    for (const buildPath of candidates) {
      const candidate = buildPath(home);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
          console.warn(
            '[spawn-cursor] unexpected fs.access error on bundle probe:',
            code,
            candidate,
          );
        }
      }
    }
  }
  // PATH lookup — covers all platforms including Linux (no bundle paths).
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, ['cursor'], { timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const first = stdout.split(/\r?\n/)[0]?.trim();
      resolve(first && first.length > 0 ? first : null);
    });
  });
}

/**
 * Resolve `exec` + `args` for the platform. Each OS's launcher that `spawn`
 * with `shell:false` cannot exec directly is mapped to its OS runner, so the
 * caller's spawn stays uniformly `shell:false`:
 *
 *   - **macOS `.app` bundle** (e.g. when `getApplicationInfoForProtocol` is the
 *     source) — `spawn` can't exec a directory, so route through
 *     `/usr/bin/open -a <bundle>`, which Launch Services resolves to the
 *     bundle's main binary.
 *   - **Windows `.cmd`/`.bat` shim** (the standard Cursor install drops a
 *     `cursor.cmd`) — Node's `child_process` refuses to exec a `.cmd`/`.bat`
 *     with `shell:false` (CVE-2024-27980 hardening) and throws `EINVAL`. Route
 *     through `cmd.exe /d /c <shim> <path>`: argv is passed verbatim (no
 *     shell-string interpolation), Node's CreateProcess argv quoting handles
 *     paths with spaces, and cmd's own parser runs the shim. `/d` skips any
 *     AutoRun registry hook. This keeps `spawnDetached` `shell:false` — the
 *     URL-opener step relies on that to keep `&` in protocol URLs inert.
 *
 * Exported because the same logic is needed by all three Cursor-spawn call
 * sites: the loopback HTTP path (`handleSpawnCursor`), the Open-in-Agent
 * dispatcher (`handoff-dispatch-api.ts`), and the Electron IPC handler
 * (`packages/desktop/src/main/ipc-handlers.ts`).
 */
export function resolveCursorSpawnInvocation(
  resolvedPath: string,
  userPath: string,
  platform: NodeJS.Platform,
): { exec: string; args: ReadonlyArray<string> } {
  if (platform === 'darwin' && /\.app\/?$/.test(resolvedPath)) {
    const bundle = resolvedPath.replace(/\/$/, '');
    return { exec: '/usr/bin/open', args: ['-a', bundle, userPath] };
  }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedPath)) {
    return {
      exec: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', resolvedPath, userPath],
    };
  }
  return { exec: resolvedPath, args: [userPath] };
}

/**
 * Path containment check — exported for tests + the route handler. Uses
 * `path/posix` or `path/win32` explicitly so Windows inputs resolve correctly
 * on a POSIX runner under test, and production behavior follows the caller's
 * platform. Lexical comparison only (no symlink resolution); a symlink inside
 * `contentDir` that targets outside (`<dir>/notes -> /etc`) passes here, and
 * the OS will follow it at use time. Same constraint as
 * `isPathWithinProject` in `packages/desktop/src/main/ipc-handlers.ts`.
 */
export function isPathWithinDir(
  userPath: string,
  contentDir: string,
  platform: NodeJS.Platform,
): boolean {
  if (!userPath || typeof userPath !== 'string') return false;
  if (userPath.includes('\0')) return false;
  if (!contentDir || typeof contentDir !== 'string') return false;
  if (platform === 'win32') {
    if (!/^([a-zA-Z]:[\\/]|\\\\)/.test(userPath)) return false;
    if (!/^([a-zA-Z]:[\\/]|\\\\)/.test(contentDir)) return false;
  } else {
    if (!userPath.startsWith('/')) return false;
    if (!contentDir.startsWith('/')) return false;
  }
  const p = platform === 'win32' ? pathWin32 : pathPosix;
  try {
    const canonicalUser = p.resolve(userPath);
    const canonicalDir = p.resolve(contentDir);
    if (platform === 'win32') {
      const userRoot = p.parse(canonicalUser).root.toLowerCase();
      const dirRoot = p.parse(canonicalDir).root.toLowerCase();
      if (!userRoot || !dirRoot || userRoot !== dirRoot) return false;
    }
    if (canonicalUser === canonicalDir) return true;
    const rel = p.relative(canonicalDir, canonicalUser);
    if (rel === '' || rel === '.') return true;
    if (rel === '..' || rel.startsWith(`..${p.sep}`)) return false;
    if (platform === 'win32' && (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('\\\\'))) {
      return false;
    }
    if (platform !== 'win32' && rel.startsWith('/')) return false;
    return true;
  } catch (err) {
    // path.resolve / path.parse on legitimate inputs are total — they don't
    // throw on Windows or POSIX path strings that pass our earlier shape
    // checks. Anything that throws here is unexpected (corrupted unicode,
    // a Node-internals regression, etc.). Surface via console.warn so an
    // engineer debugging an unexplained "cursor-not-installed" 422 sees
    // the root cause instead of investigating a phantom path-escape. Same
    // narrow-and-log pattern as `resolveCursorBinaryDefault` and
    // `spawnDetachedReal` in this file.
    console.warn('[spawn-cursor] unexpected path-resolution error:', err);
    return false;
  }
}
