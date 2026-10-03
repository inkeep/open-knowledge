import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isValidLockPid, lockBaseUrl } from '@inkeep/open-knowledge-server';
import { inspectLock, type LockState } from './lock-state.ts';

const PROBE_DEADLINE_MS = 2_000;

export interface AppliedSupervisionRuntime {
  source: 'server';
  revision: number;
  effectiveSince: string;
  port: number;
  bind: string[];
  idleShutdown: string;
  externalUrl: string | null;
}

export interface StatusReadiness {
  status: 'ready' | 'pending' | 'failed' | 'draining' | 'unreachable' | 'not-running' | 'unknown';
  checkedAt: string | null;
  degraded: string[];
}

export interface StatusObservation {
  state: LockState;
  serverInstanceId: string | null;
  readiness: StatusReadiness;
  runtime: AppliedSupervisionRuntime | null;
}

export interface ObserveStatusDeps {
  projectRoot: string | null;
  lockDir: string;
  inspect?: () => LockState;
  fetch?: typeof fetch;
  now?: () => number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function runtime(value: unknown): AppliedSupervisionRuntime | null {
  if (value === null) return null;
  const data = object(value);
  if (
    data?.source !== 'server' ||
    !Number.isSafeInteger(data.revision) ||
    Number(data.revision) < 1 ||
    typeof data.effectiveSince !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.effectiveSince) ||
    !Number.isFinite(Date.parse(data.effectiveSince)) ||
    new Date(data.effectiveSince).toISOString() !== data.effectiveSince ||
    typeof data.port !== 'number' ||
    !Number.isInteger(data.port) ||
    data.port < 1 ||
    data.port > 65535 ||
    !Array.isArray(data.bind) ||
    data.bind.length === 0 ||
    !data.bind.every((item) => typeof item === 'string' && item.length > 0) ||
    typeof data.idleShutdown !== 'string' ||
    data.idleShutdown.length === 0 ||
    !(data.externalUrl === null || typeof data.externalUrl === 'string')
  )
    return null;
  return data as unknown as AppliedSupervisionRuntime;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export async function observeStatus(deps: ObserveStatusDeps): Promise<StatusObservation> {
  const state = (deps.inspect ?? (() => inspectLock(deps.lockDir, 'server')))();
  const observation: StatusObservation = {
    state,
    serverInstanceId: null,
    readiness: {
      status: state.status === 'missing' || state.status === 'dead-pid' ? 'not-running' : 'unknown',
      checkedAt: null,
      degraded: [],
    },
    runtime: null,
  };
  if (state.status !== 'alive' || deps.projectRoot === null) return observation;
  const { pid, port } = state.lock;
  if (!isValidLockPid(pid) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return observation;
  }

  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_DEADLINE_MS);
  const origins = [
    lockBaseUrl(state.lock),
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ].filter((origin): origin is string => origin !== null);
  const request = async (origin: string, path: string) => {
    const response = await fetcher(`${origin}${path}`, { signal: controller.signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body: object(body) };
  };
  try {
    for (const origin of new Set(origins)) {
      if (controller.signal.aborted) break;
      let inspection: Awaited<ReturnType<typeof request>>;
      try {
        inspection = await request(origin, '/api/server-inspection');
      } catch {
        continue;
      }
      if (controller.signal.aborted) break;
      const data = inspection.body;
      if (
        inspection.status !== 200 ||
        !data ||
        data.pid !== pid ||
        typeof data.projectRoot !== 'string' ||
        !isAbsolute(data.projectRoot) ||
        canonical(data.projectRoot) !== canonical(deps.projectRoot) ||
        typeof data.serverInstanceId !== 'string' ||
        data.serverInstanceId.trim().length === 0 ||
        !('runtime' in data) ||
        (data.runtime !== null && runtime(data.runtime) === null)
      )
        continue;
      observation.serverInstanceId = data.serverInstanceId;
      observation.runtime = runtime(data.runtime);

      try {
        const readiness = await request(origin, '/readyz');
        if (controller.signal.aborted) {
          observation.readiness.status = 'unreachable';
          return observation;
        }
        const body = readiness.body;
        const status = body?.status;
        if (
          body &&
          typeof body.ready === 'boolean' &&
          ((readiness.status === 200 && status === 'ready' && body.ready === true) ||
            (readiness.status === 503 &&
              (status === 'pending' || status === 'failed' || status === 'draining') &&
              body.ready === false)) &&
          Array.isArray(body.degraded) &&
          body.degraded.every((item) => typeof item === 'string')
        ) {
          observation.readiness.status = status as StatusReadiness['status'];
          observation.readiness.degraded = status === 'ready' ? (body.degraded as string[]) : [];
        }
      } catch {
        observation.readiness.status = 'unreachable';
      }
      return observation;
    }
  } finally {
    clearTimeout(timer);
    observation.readiness.checkedAt = new Date(now()).toISOString();
  }
  return observation;
}
