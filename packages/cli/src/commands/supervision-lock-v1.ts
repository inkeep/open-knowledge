import { isAbsolute } from 'node:path';
import { isValidLockPid } from '@inkeep/open-knowledge-server';
import type { LockState } from './lock-state.ts';
import type { V1LockObservation, V1Process } from './supervision-json-v1.ts';

type V1MetadataProjection = Pick<
  V1LockObservation,
  'process' | 'runtimeVersion' | 'protocolVersion' | 'capabilities' | 'launchKind'
>;

function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return null;
  }
  const localTime = value.slice(0, 19);
  const parsedLocalTime = Date.parse(`${localTime}Z`);
  if (
    !Number.isFinite(parsedLocalTime) ||
    new Date(parsedLocalTime).toISOString().slice(0, 19) !== localTime
  ) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function port(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535
    ? value
    : null;
}

function protocolVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function projectV1LockMetadata(value: unknown): V1MetadataProjection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      process: null,
      runtimeVersion: null,
      protocolVersion: null,
      capabilities: null,
      launchKind: null,
    };
  }

  const metadata = value as Record<string, unknown>;
  if (!isValidLockPid(metadata.pid)) {
    return {
      process: null,
      runtimeVersion: null,
      protocolVersion: null,
      capabilities: null,
      launchKind: null,
    };
  }

  const process: V1Process = {
    pid: metadata.pid,
    startedAt: timestamp(metadata.startedAt),
    port: port(metadata.port),
    hostname: nonemptyString(metadata.hostname),
    draining: typeof metadata.draining === 'boolean' ? metadata.draining : null,
  };
  const capabilities = Array.isArray(metadata.capabilities)
    ? metadata.capabilities.every((capability) => typeof capability === 'string')
      ? [...metadata.capabilities]
      : null
    : null;

  return {
    process,
    runtimeVersion: nonemptyString(metadata.runtimeVersion),
    protocolVersion: protocolVersion(metadata.protocolVersion),
    capabilities,
    launchKind:
      metadata.kind === 'interactive' || metadata.kind === 'mcp-spawned' ? metadata.kind : null,
  };
}

export function projectV1LockState(state: LockState): V1LockObservation {
  const lock = {
    path: isAbsolute(state.lockPath) ? state.lockPath : null,
    state: state.status,
  };

  switch (state.status) {
    case 'alive':
    case 'dead-pid':
    case 'foreign-host':
      return {
        lock,
        ...projectV1LockMetadata(state.lock),
        alive: state.status === 'alive' ? true : state.status === 'dead-pid' ? false : null,
      };
    case 'unverified-owner':
      return {
        lock,
        process: isValidLockPid(state.pid)
          ? { pid: state.pid, startedAt: null, port: null, hostname: null, draining: null }
          : null,
        alive: null,
        runtimeVersion: null,
        protocolVersion: null,
        capabilities: null,
        launchKind: null,
      };
    case 'missing':
    case 'corrupt':
    case 'read-error':
      return {
        lock,
        process: null,
        alive: state.status === 'missing' ? false : null,
        runtimeVersion: null,
        protocolVersion: null,
        capabilities: null,
        launchKind: null,
      };
  }
}
