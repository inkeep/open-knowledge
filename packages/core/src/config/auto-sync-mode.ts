export const SYNC_MODES = ['off', 'follow', 'full'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const SYNC_ACTIVE_MODES = ['follow', 'full'] as const;
export type SyncActiveMode = (typeof SYNC_ACTIVE_MODES)[number];

const LEGACY_FOLLOW_MODE = 'pull';

export const STORED_SYNC_MODES = ['off', 'follow', 'full', LEGACY_FOLLOW_MODE] as const;
export const STORED_SYNC_ACTIVE_MODES = ['follow', 'full', LEGACY_FOLLOW_MODE] as const;

export function normalizeStoredMode(value: unknown): SyncMode | null {
  if (value === LEGACY_FOLLOW_MODE) return 'follow';
  return isSyncMode(value) ? value : null;
}

export function isSyncMode(value: unknown): value is SyncMode {
  return typeof value === 'string' && (SYNC_MODES as readonly string[]).includes(value);
}

export function isSyncActiveMode(value: unknown): value is SyncActiveMode {
  return typeof value === 'string' && (SYNC_ACTIVE_MODES as readonly string[]).includes(value);
}

export type StoredSyncMode = (typeof STORED_SYNC_MODES)[number];
export type StoredSyncActiveMode = (typeof STORED_SYNC_ACTIVE_MODES)[number];

export function modeFromLegacyEnabled(enabled: boolean | null | undefined): SyncMode | null {
  if (enabled === true) return 'full';
  if (enabled === false) return 'off';
  return null;
}

export function modeFromCommittedDefault(
  value: boolean | StoredSyncMode | null | undefined,
): SyncMode | null {
  if (value === true) return 'full';
  if (value === false) return 'off';
  return normalizeStoredMode(value);
}

export function resolveLocalAutoSyncMode(
  autoSync: { mode?: StoredSyncMode | null; enabled?: boolean | null } | undefined,
): SyncMode | null {
  const mode = normalizeStoredMode(autoSync?.mode);
  if (mode !== null) return mode;
  return modeFromLegacyEnabled(autoSync?.enabled);
}

export function resolveEffectiveAutoSyncMode(input: {
  local: { mode?: StoredSyncMode | null; enabled?: boolean | null } | undefined;
  committedDefault: boolean | StoredSyncMode | null | undefined;
}): SyncMode | null {
  const localMode = resolveLocalAutoSyncMode(input.local);
  if (localMode !== null) return localMode;
  return modeFromCommittedDefault(input.committedDefault);
}

export const SYNC_MODE_CHANGE_SOURCES = [
  'config',
  'committed-default',
  'worktree-inherit',
] as const;
export type SyncModeChangeSource = (typeof SYNC_MODE_CHANGE_SOURCES)[number];

export const DEFAULT_PULL_INTERVAL_SECONDS = 30;
export const DEFAULT_PUSH_INTERVAL_SECONDS = 60;

export const MIN_SYNC_INTERVAL_SECONDS = 30;
export const MAX_SYNC_INTERVAL_SECONDS = 3600;

export const SYNC_INTERVAL_PRESET_SECONDS = [30, 60, 300, 900, 3600] as const;

function resolveInterval(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(
    MAX_SYNC_INTERVAL_SECONDS,
    Math.max(MIN_SYNC_INTERVAL_SECONDS, Math.round(value)),
  );
}

export function resolveAutoSyncIntervals(
  autoSync:
    | { pullIntervalSeconds?: number | null; pushIntervalSeconds?: number | null }
    | undefined,
): { pullIntervalSeconds: number; pushIntervalSeconds: number } {
  return {
    pullIntervalSeconds: resolveInterval(
      autoSync?.pullIntervalSeconds,
      DEFAULT_PULL_INTERVAL_SECONDS,
    ),
    pushIntervalSeconds: resolveInterval(
      autoSync?.pushIntervalSeconds,
      DEFAULT_PUSH_INTERVAL_SECONDS,
    ),
  };
}
