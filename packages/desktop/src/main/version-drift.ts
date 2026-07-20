/**
 * Pure version-drift classifier for the desktop attach path.
 *
 * When the desktop attaches to a server it did not spawn this launch
 * (`ownsServer === false`), that server may be a different build than the app
 * — most often a prior version's detached server still alive after an
 * auto-update, or a terminal `ok start`. This module decides, from the two
 * version dimensions the lock carries, whether the server is older, newer, the
 * same, or indeterminate relative to the running app.
 *
 * Pure: no Electron, no fs, no own-version lookup. The caller supplies the
 * desktop's own `(protocolVersion, runtimeVersion)`, so direction logic is
 * exhaustively unit-testable and free of process state.
 *
 * Protocol (integer) is the coarse gate; runtime (semver) the fine one. The
 * first dimension that differs classifies the relation. `0.0.0-unknown` (a
 * side that couldn't resolve its version) and locks missing the fields are
 * `indeterminate` — the caller suppresses the notification rather than risk a
 * false alarm. The sentinel is itself valid semver, so it MUST be screened out
 * before `semver.compare`, which would otherwise rank it as the oldest version.
 */
import { CLIENT_RUNTIME_VERSION_FALLBACK } from '@inkeep/open-knowledge-core';
import semver from 'semver';

/**
 * The attached server's self-described version, read from `server.lock`. Both
 * fields are optional — locks written by binaries predating the version
 * contract omit them.
 */
export interface AttachedServerVersion {
  protocolVersion?: number;
  runtimeVersion?: string;
}

/** The running desktop's own version. Always resolved. */
export interface DesktopVersion {
  protocolVersion: number;
  runtimeVersion: string;
}

export interface VersionDrift {
  relation: 'older' | 'newer' | 'same' | 'indeterminate';
  /** Dimension that decided `older` / `newer`; null for `same` / `indeterminate`. */
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
  // A lock missing either version field predates the version contract — we
  // can't determine a relation, so suppress rather than guess.
  if (server.protocolVersion === undefined || server.runtimeVersion === undefined) {
    return INDETERMINATE;
  }

  // Protocol mismatch is the strongest drift signal and is meaningful
  // regardless of the runtime semver — classify on it directly.
  if (server.protocolVersion !== self.protocolVersion) {
    return {
      relation: server.protocolVersion < self.protocolVersion ? 'older' : 'newer',
      dimension: 'protocol',
    };
  }

  // Same protocol → compare runtime semver. Screen the "unknown" sentinel and
  // any non-semver string first: both are valid-looking to a naive compare but
  // carry no ordering meaning.
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

/**
 * Decide whether THIS launch is the first run after the app version changed —
 * the signal the packaged upgrade reconcile gates on. `lastSeenVersion` is the
 * version persisted on the previous launch (`null` on a fresh install). A fresh
 * install is NOT an upgrade — there is no prior version to have drifted from —
 * so it returns false; only a real version transition (either direction)
 * returns true.
 *
 * Pure — no Electron, no fs — so the three cases (null / same / changed) are
 * exhaustively unit-testable. `index.ts` captures the result once at bootstrap,
 * BEFORE the auto-updater advances `lastSeenVersion`, and holds it for the
 * session (a live re-read would flip false once the updater advances).
 */
export function computeFirstLaunchAfterUpgrade(
  lastSeenVersion: string | null,
  currentVersion: string,
): boolean {
  return lastSeenVersion !== null && lastSeenVersion !== currentVersion;
}
