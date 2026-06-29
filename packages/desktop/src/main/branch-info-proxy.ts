import { resolve as joinPath } from 'node:path';

import type { BranchInfoResponse, CheckoutResponse } from '@inkeep/open-knowledge-core';
import {
  BranchInfoResponseSchema,
  CheckoutResponseSchema,
  clientVersionHeaders,
  ServerInfoSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { RUNTIME_VERSION } from '@inkeep/open-knowledge-server';

const DESKTOP_MAIN_VERSION_HEADERS = clientVersionHeaders({
  kind: 'desktop-main',
  runtimeVersion: RUNTIME_VERSION,
});

export interface ServerLockReadShape {
  readonly pid: number;
  readonly port: number;
}

export interface BranchInfoProxyDeps {
  readonly readServerLock: (lockDir: string) => ServerLockReadShape | null;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly fetch: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly log?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

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

function composeFetchSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

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
    deps.log?.warn('[branch-info-proxy] unexpected async validator');
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

export type AwaitBranchSwitchedOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'timeout' | 'project-not-open' };

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

export async function proxyRunCheckout(
  request: { projectPath: string; branch: string },
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
      body: JSON.stringify({ branch: request.branch }),
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
    deps.log?.warn('[branch-info-proxy] unexpected async validator');
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
