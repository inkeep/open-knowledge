import { CLIENT_RUNTIME_VERSION_FALLBACK } from '@inkeep/open-knowledge-core';
import semver from 'semver';

export interface AttachedServerVersion {
  protocolVersion?: number;
  runtimeVersion?: string;
}

export interface DesktopVersion {
  protocolVersion: number;
  runtimeVersion: string;
}

export interface VersionDrift {
  relation: 'older' | 'newer' | 'same' | 'indeterminate';
  dimension: 'protocol' | 'runtime' | null;
}

const INDETERMINATE: VersionDrift = { relation: 'indeterminate', dimension: null };

function isUnresolved(version: string): boolean {
  return version === CLIENT_RUNTIME_VERSION_FALLBACK;
}

export function classifyServerVersion(
  server: AttachedServerVersion,
  self: DesktopVersion,
): VersionDrift {
  if (server.protocolVersion === undefined || server.runtimeVersion === undefined) {
    return INDETERMINATE;
  }

  if (server.protocolVersion !== self.protocolVersion) {
    return {
      relation: server.protocolVersion < self.protocolVersion ? 'older' : 'newer',
      dimension: 'protocol',
    };
  }

  if (isUnresolved(server.runtimeVersion) || isUnresolved(self.runtimeVersion)) {
    return INDETERMINATE;
  }
  if (semver.valid(server.runtimeVersion) === null || semver.valid(self.runtimeVersion) === null) {
    return INDETERMINATE;
  }

  const cmp = semver.compare(server.runtimeVersion, self.runtimeVersion);
  if (cmp < 0) return { relation: 'older', dimension: 'runtime' };
  if (cmp > 0) return { relation: 'newer', dimension: 'runtime' };
  return { relation: 'same', dimension: null };
}

export function computeFirstLaunchAfterUpgrade(
  lastSeenVersion: string | null,
  currentVersion: string,
): boolean {
  return lastSeenVersion !== null && lastSeenVersion !== currentVersion;
}
