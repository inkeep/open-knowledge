/**
 * Main-process proxies for the share-receive branch-switch dialog.
 *
 * The dispatcher window (Navigator) has no `apiOrigin` of its own — it lives
 * outside any project's utility process. To render the branch-switch dialog
 * it needs `GET /api/git/branch-info` against the project's running server
 * and (later) `POST /api/git/checkout` against the same surface. Main owns
 * the bridge: read `<projectPath>/.ok/local/server.lock`, resolve the port,
 * and HTTP-fetch on the renderer's behalf.
 *
 * Lock-resolution semantics:
 *   - The dispatcher calls `bridge.project.open({...})` first, which spawns
 *     the project's utility process. Server boot is async — the lock file
 *     may not exist for the first ~tens of ms. `resolveProjectServerOrigin`
 *     polls briefly so the dispatcher's "loading" state doesn't spin
 *     forever on a normal cold-start.
 *   - Lock metadata is the same shape `WindowManager.tryAttachExistingServer`
 *     consumes; we apply the same liveness gates (pid alive, port > 0).
 *   - Any failure (no lock, dead pid, port 0) collapses to `null`. Callers
 *     map `null` to a generic dialog error.
 *
 * HTTP semantics:
 *   - Use the global `fetch` (Node 18+; Electron ships it).
 *   - 5-second hard timeout per request via `AbortSignal.timeout` so a
 *     hung server doesn't lock the dialog open.
 *   - Validate responses via Zod (Standard-Schema-compliant) so a server
 *     misbehaving on contract shows up as `null`, not as a JSON-shaped
 *     value the renderer tries to render.
 *
 * Never throws — every error path returns `null`. Telemetry is opt-in via
 * the injected `log` dependency so unit tests can run without a logger.
 */

import { resolve as joinPath } from 'node:path';

import type {
  BranchInfoResponse,
  CheckoutResponse,
  ShareTargetStatusResponse,
} from '@inkeep/open-knowledge-core';
import {
  BranchInfoResponseSchema,
  CheckoutResponseSchema,
  clientVersionHeaders,
  ServerInfoSuccessSchema,
  ShareTargetStatusResponseSchema,
} from '@inkeep/open-knowledge-core';
import { RUNTIME_VERSION } from '@inkeep/open-knowledge-server';

// Client version metadata on every main-process /api request (v1 wire contract).
const DESKTOP_MAIN_VERSION_HEADERS = clientVersionHeaders({
  kind: 'desktop-main',
  runtimeVersion: RUNTIME_VERSION,
});

/**
 * Bounded subset of the server-lock metadata we read here. Mirrors the
 * shape consumed by `WindowManager.tryAttachExistingServer` so behavior
 * stays consistent across surfaces.
 */
export interface ServerLockReadShape {
  readonly pid: number;
  readonly port: number;
}

/** Dependencies injected so unit tests can substitute deterministic fakes. */
export interface BranchInfoProxyDeps {
  readonly readServerLock: (lockDir: string) => ServerLockReadShape | null;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly fetch: typeof fetch;
  /** Delay between lock-presence polls. Default 50ms. */
  readonly pollIntervalMs?: number;
  /** Maximum total time spent polling for the lock. Default 5_000ms. */
  readonly pollTimeoutMs?: number;
  /** Per-request HTTP timeout. Default 5_000ms. */
  readonly requestTimeoutMs?: number;
  readonly log?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Locate the running server for `projectPath` and return its HTTP origin
 * (`http://localhost:<port>`). Polls briefly because the dispatcher may
 * call this right after `bridge.project.open`, before the utility's lock
 * file lands. Returns `null` when no live server resolves within the
 * poll window.
 *
 * `signal` is checked before each poll iteration so renderer-side cleanup
 * (dialog dismiss, payload-keyed reset) bails the busy-wait early instead
 * of spinning to the full 5s deadline on a zombie task.
 */
export async function resolveProjectServerOrigin(
  projectPath: string,
  deps: BranchInfoProxyDeps,
  signal?: AbortSignal,
): Promise<string | null> {
  const lockDir = joinPath(projectPath, '.ok', 'local');
  const pollIntervalMs = deps.pollIntervalMs ?? 50;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 5_000;
  const deadline = Date.now() + pollTimeoutMs;
  while (true) {
    if (signal?.aborted) return null;
    const lock = deps.readServerLock(lockDir);
    if (lock && lock.port > 0 && lock.pid > 0 && deps.isProcessAlive(lock.pid)) {
      return `http://localhost:${lock.port}`;
    }
    if (Date.now() >= deadline) {
      deps.log?.warn('[branch-info-proxy] gave up waiting for server lock', {
        projectPath,
      });
      return null;
    }
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
  }
}

/**
 * Combine an optional caller-provided `AbortSignal` with the per-request
 * timeout signal so either source can short-circuit the in-flight fetch.
 */
function composeFetchSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

/**
 * Proxy `GET /api/git/branch-info` for the share-receive dialog. Returns
 * the validated response shape or `null` on any failure.
 *
 * `signal` cancels both the lock-resolution busy-wait and the in-flight
 * fetch so renderer-side cleanup can bail the proxy early.
 */
export async function proxyFetchBranchInfo(
  request: { projectPath: string; branch: string; kind: 'doc' | 'folder'; path: string },
  deps: BranchInfoProxyDeps,
  signal?: AbortSignal,
): Promise<BranchInfoResponse | null> {
  const origin = await resolveProjectServerOrigin(request.projectPath, deps, signal);
  if (origin === null) return null;
  if (signal?.aborted) return null;
  const params = new URLSearchParams({
    branch: request.branch,
    kind: request.kind,
    path: request.path,
  });
  const url = `${origin}/api/git/branch-info?${params.toString()}`;
  const timeoutMs = deps.requestTimeoutMs ?? 5_000;
  let raw: unknown;
  try {
    const res = await deps.fetch(url, {
      method: 'GET',
      headers: { ...DESKTOP_MAIN_VERSION_HEADERS },
      signal: composeFetchSignal(timeoutMs, signal),
    });
    if (!res.ok) {
      deps.log?.warn('[branch-info-proxy] non-2xx from branch-info', {
        status: res.status,
      });
      return null;
    }
    raw = await res.json();
  } catch (err) {
    deps.log?.warn('[branch-info-proxy] branch-info fetch failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const parsed = BranchInfoResponseSchema['~standard'].validate(raw);
  if (parsed instanceof Promise) {
    // Standard Schema permits async validators; ours is sync. Defensive null
    // so a future schema swap doesn't silently invent a value.
    deps.log?.warn('[branch-info-proxy] branch-info unexpected async validator');
    return null;
  }
  if (parsed.issues) {
    deps.log?.warn('[branch-info-proxy] branch-info shape invalid', {
      issues: parsed.issues.length,
    });
    return null;
  }
  return parsed.value;
}

/**
 * Discriminated outcome of `proxyAwaitBranchSwitched`. Mirrors the
 * dialog's three terminal post-checkout states so the dispatcher can
 * dismiss with the right toast (or no toast on `ok: true`).
 *
 *   - `ok: true` — server-info reported `currentBranch === branch`;
 *     CC1 `branch-switched` has fired in the project window's `__system__`
 *     subscriber, the disk-rebuilt CRDT state is settled, and it is safe
 *     for the project window's deep-link hash to resolve to the share's doc.
 *   - `timeout` — the poll exceeded `timeoutMs` without a match. Likely
 *     causes: HEAD watcher missed the checkout, the project window
 *     crashed between checkout and recycle, or the server is hung. The
 *     dialog surfaces the timed-out toast and dismisses.
 *   - `project-not-open` — the server lock never resolved (project window
 *     didn't open, or didn't finish booting within the poll window).
 *     Surfaces the same "could not switch" toast since both classes are
 *     non-actionable from the dialog.
 */
export type AwaitBranchSwitchedOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'timeout' | 'project-not-open' };

/**
 * Poll `GET /api/server-info` against the project's running server until
 * `currentBranch === request.branch`. The dispatcher dialog calls this
 * after `runCheckout` returns `{ok: true}` to gate dismissal on the CC1
 * `branch-switched` broadcast landing in the project window — which the
 * server emits whenever the HEAD watcher's `onBatchEnd` completes the
 * cross-branch markdown rebuild. Server-info is the late-join backstop
 * for that broadcast, so polling it from the dispatcher yields the same
 * "post-recycle" signal without bridging cross-window CC1 traffic.
 *
 * Failure modes collapse to discriminated outcomes (never throws):
 *   - Lock never resolves → `{ok: false, reason: 'project-not-open'}`
 *   - Poll deadline reached without match → `{ok: false, reason: 'timeout'}`
 *   - Transient HTTP / schema failures during polling are treated as
 *     not-yet-matched; the poll continues. (A persistently broken server
 *     eventually falls through to the timeout branch.)
 */
export async function proxyAwaitBranchSwitched(
  request: { projectPath: string; branch: string; timeoutMs: number },
  deps: BranchInfoProxyDeps,
  signal?: AbortSignal,
): Promise<AwaitBranchSwitchedOutcome> {
  const origin = await resolveProjectServerOrigin(request.projectPath, deps, signal);
  if (origin === null) return { ok: false, reason: 'project-not-open' };
  const pollIntervalMs = deps.pollIntervalMs ?? 50;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 5_000;
  const deadline = Date.now() + request.timeoutMs;
  const url = `${origin}/api/server-info`;
  while (true) {
    if (signal?.aborted) return { ok: false, reason: 'timeout' };
    let raw: unknown;
    try {
      const res = await deps.fetch(url, {
        method: 'GET',
        headers: { ...DESKTOP_MAIN_VERSION_HEADERS },
        signal: composeFetchSignal(requestTimeoutMs, signal),
      });
      if (res.ok) {
        raw = await res.json();
      }
    } catch (err) {
      deps.log?.warn('[branch-info-proxy] server-info poll failed (will retry)', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (raw !== undefined) {
      const parsed = ServerInfoSuccessSchema['~standard'].validate(raw);
      if (!(parsed instanceof Promise) && !parsed.issues) {
        if (parsed.value.currentBranch === request.branch) {
          return { ok: true };
        }
      }
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: 'timeout' };
    }
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
  }
}

/**
 * Proxy `POST /api/git/checkout`. Mirrors `proxyFetchBranchInfo`.
 *
 * `fastForward` rides in the body only when the caller requests it (the
 * on-origin "Switch and update branch" cell): the server fast-forwards the
 * target branch to origin's tip before checking out. Omitted → today's plain
 * checkout, so existing callers are byte-for-byte unchanged on the wire.
 */
export async function proxyRunCheckout(
  request: { projectPath: string; branch: string; fastForward?: boolean },
  deps: BranchInfoProxyDeps,
  signal?: AbortSignal,
): Promise<CheckoutResponse | null> {
  const origin = await resolveProjectServerOrigin(request.projectPath, deps, signal);
  if (origin === null) return null;
  if (signal?.aborted) return null;
  const url = `${origin}/api/git/checkout`;
  const timeoutMs = deps.requestTimeoutMs ?? 30_000;
  let raw: unknown;
  try {
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...DESKTOP_MAIN_VERSION_HEADERS },
      body: JSON.stringify(
        request.fastForward
          ? { branch: request.branch, fastForward: true }
          : { branch: request.branch },
      ),
      signal: composeFetchSignal(timeoutMs, signal),
    });
    if (!res.ok) {
      deps.log?.warn('[branch-info-proxy] non-2xx from checkout', { status: res.status });
      return null;
    }
    raw = await res.json();
  } catch (err) {
    deps.log?.warn('[branch-info-proxy] checkout fetch failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const parsed = CheckoutResponseSchema['~standard'].validate(raw);
  if (parsed instanceof Promise) {
    deps.log?.warn('[branch-info-proxy] checkout unexpected async validator');
    return null;
  }
  if (parsed.issues) {
    deps.log?.warn('[branch-info-proxy] checkout shape invalid', {
      issues: parsed.issues.length,
    });
    return null;
  }
  return parsed.value;
}

/**
 * Proxy `POST /api/share/target-status` for the branch-switch dialog's verdict
 * pivot. The server runs a targeted fetch, then classifies why a share target
 * missed (on-origin / renamed / deleted / never-on-branch / unknown).
 *
 * Returns `null` only on a transport-level failure (no server lock, non-2xx,
 * network error) — the dialog treats that the same as an `unknown` verdict and
 * falls back to today's guidance. A 200 with an unexpected body is NOT null:
 * the response schema's `.catch` coerces it to `{ verdict: 'unknown' }`, so a
 * skewed server degrades to the fail-open verdict rather than a dropped call.
 *
 * The HTTP timeout is generous (30s) because the server's own fetch may take
 * network time before it returns its `unknown` verdict; a shorter proxy timeout
 * would abort the request before the server's fail-open answer arrives.
 */
export async function proxyShareTargetStatus(
  request: { projectPath: string; branch: string; path: string; kind: 'doc' | 'folder' },
  deps: BranchInfoProxyDeps,
  signal?: AbortSignal,
): Promise<ShareTargetStatusResponse | null> {
  const origin = await resolveProjectServerOrigin(request.projectPath, deps, signal);
  if (origin === null) return null;
  if (signal?.aborted) return null;
  const url = `${origin}/api/share/target-status`;
  const timeoutMs = deps.requestTimeoutMs ?? 30_000;
  let raw: unknown;
  try {
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...DESKTOP_MAIN_VERSION_HEADERS },
      body: JSON.stringify({
        branch: request.branch,
        path: request.path,
        kind: request.kind,
      }),
      signal: composeFetchSignal(timeoutMs, signal),
    });
    if (!res.ok) {
      deps.log?.warn('[branch-info-proxy] non-2xx from target-status', { status: res.status });
      return null;
    }
    raw = await res.json();
  } catch (err) {
    deps.log?.warn('[branch-info-proxy] target-status fetch failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const parsed = ShareTargetStatusResponseSchema['~standard'].validate(raw);
  if (parsed instanceof Promise) {
    deps.log?.warn('[branch-info-proxy] target-status unexpected async validator');
    return null;
  }
  // The schema `.catch`es any parse failure to `{verdict: 'unknown'}`, so
  // `issues` is never populated here; the guard mirrors the sibling proxies so
  // a future schema swap that drops the catch surfaces as null, not a throw.
  if (parsed.issues) {
    deps.log?.warn('[branch-info-proxy] target-status shape invalid', {
      issues: parsed.issues.length,
    });
    return null;
  }
  return parsed.value;
}
