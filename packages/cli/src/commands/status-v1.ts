import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { lockBaseUrl } from '@inkeep/open-knowledge-server';
import { inspectLock, type LockState } from './lock-state.ts';
import {
  type V1Project,
  type V1Readiness,
  type V1Runtime,
  type V1StatusDocument,
  v1Result,
} from './supervision-json-v1.ts';
import { projectV1LockState } from './supervision-lock-v1.ts';

const PROBE_DEADLINE_MS = 2_000;

type Fetch = typeof fetch;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function runtime(value: unknown): V1Runtime | null {
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
  return data as unknown as V1Runtime;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function statusV1Failure(
  code: 'project-unavailable' | 'operation-failed',
  detail: string,
): V1StatusDocument {
  return {
    schemaVersion: 1,
    command: 'status',
    result: v1Result('status', code, detail),
    project: { root: null, resolution: 'unavailable' },
    server: {
      lock: { path: null, state: 'unknown' },
      process: null,
      alive: null,
      runtimeVersion: null,
      protocolVersion: null,
      capabilities: null,
      launchKind: null,
      identity: null,
      readiness: { status: 'unknown', checkedAt: null, degraded: [] },
      runtime: null,
    },
  };
}

export interface StatusV1Deps {
  project: V1Project;
  lockDir: string;
  inspect?: () => LockState;
  fetch?: Fetch;
  now?: () => number;
}

export async function buildStatusV1(deps: StatusV1Deps): Promise<V1StatusDocument> {
  const state = (deps.inspect ?? (() => inspectLock(deps.lockDir, 'server')))();
  const observation = projectV1LockState(state);
  const server: V1StatusDocument['server'] = {
    ...observation,
    identity: null,
    readiness: {
      status: observation.alive === false ? 'not-running' : 'unknown',
      checkedAt: null,
      degraded: [],
    },
    runtime: null,
  };
  const document: V1StatusDocument = {
    schemaVersion: 1,
    command: 'status',
    result: v1Result('status', 'observed'),
    project: deps.project,
    server,
  };
  if (state.status !== 'alive' || !observation.process || !deps.project.root) return document;
  const port = observation.process.port;
  if (port === null || port < 1) return document;

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
        data.pid !== observation.process.pid ||
        typeof data.projectRoot !== 'string' ||
        !isAbsolute(data.projectRoot) ||
        canonical(data.projectRoot) !== canonical(deps.project.root) ||
        typeof data.serverInstanceId !== 'string' ||
        data.serverInstanceId.trim().length === 0 ||
        !('runtime' in data) ||
        (data.runtime !== null && runtime(data.runtime) === null)
      )
        continue;
      server.identity = { serverInstanceId: data.serverInstanceId };
      server.runtime = runtime(data.runtime);

      try {
        const readiness = await request(origin, '/readyz');
        if (controller.signal.aborted) {
          server.readiness.status = 'unreachable';
          return document;
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
          server.readiness.status = status as V1Readiness['status'];
          server.readiness.degraded = status === 'ready' ? (body.degraded as string[]) : [];
        }
      } catch {
        server.readiness.status = 'unreachable';
      }
      return document;
    }
  } finally {
    clearTimeout(timer);
    server.readiness.checkedAt = new Date(now()).toISOString();
  }
  return document;
}
