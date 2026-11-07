import type { LockState } from './lock-state.ts';
import { observeStatus } from './status-observation.ts';
import { type V1Project, type V1StatusDocument, v1Result } from './supervision-json-v1.ts';
import { projectV1LockState } from './supervision-lock-v1.ts';

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
  fetch?: typeof fetch;
  now?: () => number;
}

export async function buildStatusV1(deps: StatusV1Deps): Promise<V1StatusDocument> {
  const observation = await observeStatus({
    projectRoot: deps.project.root,
    lockDir: deps.lockDir,
    inspect: deps.inspect,
    fetch: deps.fetch,
    now: deps.now,
  });
  return {
    schemaVersion: 1,
    command: 'status',
    result: v1Result('status', 'observed'),
    project: deps.project,
    server: {
      ...projectV1LockState(observation.state),
      identity:
        observation.serverInstanceId === null
          ? null
          : { serverInstanceId: observation.serverInstanceId },
      readiness: observation.readiness,
      runtime: observation.runtime,
    },
  };
}
