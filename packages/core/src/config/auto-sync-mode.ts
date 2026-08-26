/**
 * Sync-mode vocabulary and the rules that turn stored config into an effective
 * mode.
 *
 * `autoSync.mode` is the canonical per-project sync knob for what runs ON A
 * SCHEDULE: `off` (Manual — nothing scheduled), `follow` (Auto, pull only —
 * scheduled fetch and fast-forward, never a scheduled push), `full` (Auto,
 * pull and push — bidirectional). It is the single source of truth for
 * "should this project push ON ITS OWN INITIATIVE?" — only `full` schedules
 * pushes. The manual verbs are mode-independent: an explicit user-pressed
 * Push runs in every mode, including `follow` and `off`.
 *
 * The follow mode was briefly stored as `'pull'` (after the git operation it
 * runs). That value is accepted as a permanent alias for `'follow'` — see
 * `LEGACY_FOLLOW_MODE` and `normalizeStoredMode` — so any config already on disk
 * keeps resolving correctly with no migration step. `mode` also supersedes the
 * even-older `autoSync.enabled` boolean (read via `modeFromLegacyEnabled`).
 * `null` means "never asked" (the onboarding prompt still fires).
 */

export const SYNC_MODES = ['off', 'follow', 'full'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

/** The two modes that actually sync — `off` is the paused/never state. */
export const SYNC_ACTIVE_MODES = ['follow', 'full'] as const;
export type SyncActiveMode = (typeof SYNC_ACTIVE_MODES)[number];

/** Legacy stored value for `follow` (the git op it runs), accepted permanently. */
const LEGACY_FOLLOW_MODE = 'pull';

/**
 * Mode values a stored config may legally carry — the canonical vocabulary plus
 * the legacy `'pull'` alias. Config schemas validate against this (so an
 * on-disk `'pull'` parses); readers normalize via {@link normalizeStoredMode}.
 */
export const STORED_SYNC_MODES = ['off', 'follow', 'full', LEGACY_FOLLOW_MODE] as const;
/** Active-mode stored values, including the legacy `'pull'` alias for `follow`. */
export const STORED_SYNC_ACTIVE_MODES = ['follow', 'full', LEGACY_FOLLOW_MODE] as const;

/** Normalize a stored `mode` value, mapping the legacy `'pull'` alias to `'follow'`. */
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

/** A stored `mode` value: canonical, or the legacy `'pull'` alias for `follow`. */
export type StoredSyncMode = (typeof STORED_SYNC_MODES)[number];
/** A stored active-mode value, including the legacy `'pull'` alias. */
export type StoredSyncActiveMode = (typeof STORED_SYNC_ACTIVE_MODES)[number];

/**
 * Translate the legacy `autoSync.enabled` boolean into a mode: `true` was
 * bidirectional sync, `false` was off. `null`/absent stays the "never asked"
 * sentinel.
 */
export function modeFromLegacyEnabled(enabled: boolean | null | undefined): SyncMode | null {
  if (enabled === true) return 'full';
  if (enabled === false) return 'off';
  return null;
}

/**
 * Resolve the committed `autoSync.default` seed. It accepts both the widened
 * mode strings and the legacy boolean seed (`true`→full, `false`→off);
 * `null`/absent means no committed default.
 */
export function modeFromCommittedDefault(
  value: boolean | StoredSyncMode | null | undefined,
): SyncMode | null {
  if (value === true) return 'full';
  if (value === false) return 'off';
  return normalizeStoredMode(value);
}

/**
 * The per-machine mode for one project: an explicit `mode` wins; with no `mode`
 * key the legacy `enabled` boolean is derived. `null` means this machine has not
 * answered.
 */
export function resolveLocalAutoSyncMode(
  autoSync: { mode?: StoredSyncMode | null; enabled?: boolean | null } | undefined,
): SyncMode | null {
  const mode = normalizeStoredMode(autoSync?.mode);
  if (mode !== null) return mode;
  return modeFromLegacyEnabled(autoSync?.enabled);
}

/**
 * Effective mode across the two config layers, mirroring the existing
 * `enabled`/`default` precedence: a non-null per-machine choice wins, else the
 * committed project default, else `null` (never asked → prompt).
 */
export function resolveEffectiveAutoSyncMode(input: {
  local: { mode?: StoredSyncMode | null; enabled?: boolean | null } | undefined;
  committedDefault: boolean | StoredSyncMode | null | undefined;
}): SyncMode | null {
  const localMode = resolveLocalAutoSyncMode(input.local);
  if (localMode !== null) return localMode;
  return modeFromCommittedDefault(input.committedDefault);
}

/**
 * Bounded vocabulary for the origin of a sync-mode change, used as a telemetry
 * label. Kept small on purpose — it feeds structured logs, so the value set
 * must never grow unbounded.
 *
 * The user-facing surfaces that enable a mode (a first-open prompt, the
 * Settings control, the paused-notice switch action) all write the same
 * per-machine `autoSync.mode`, so the server cannot tell them apart from the
 * config alone — they collapse to `config`. The two origins the server (or
 * desktop) can attribute distinctly get their own value:
 *   - `committed-default` — resolved from a maintainer's committed
 *     `autoSync.default` seed rather than a per-machine choice.
 *   - `worktree-inherit`  — seeded into a new worktree from its parent's mode
 *     (attributed at the desktop seed site, which knows the origin).
 */
export const SYNC_MODE_CHANGE_SOURCES = [
  'config',
  'committed-default',
  'worktree-inherit',
] as const;
export type SyncModeChangeSource = (typeof SYNC_MODE_CHANGE_SOURCES)[number];

/**
 * Scheduled-cycle cadence, in seconds.
 *
 * Pull and push are deliberately decoupled and default to different values: a
 * pull is a read, so polling faster only buys freshness, while a push AUTHORS A
 * COMMIT in shared history, so polling faster buys noise. Keeping one knob for
 * both would force a user who wants prompt updates to also accept a cluttered
 * history.
 *
 * The defaults below are the shipped cadence; the config leaves only let a user
 * move off them.
 */
export const DEFAULT_PULL_INTERVAL_SECONDS = 30;
export const DEFAULT_PUSH_INTERVAL_SECONDS = 60;

/**
 * Bounds on a stored interval. The floor keeps a hand-edited config from
 * turning a follower into a hot loop against the remote; the ceiling keeps a
 * typo'd value from silently parking sync for a day.
 *
 * These bound what a user may CHOOSE. They do not override
 * `ANONYMOUS_PULL_MIN_SECONDS`, which floors an unauthenticated follower's pull
 * cadence independently — an anonymous follower who picks 30 s still polls at
 * the anonymous floor.
 */
export const MIN_SYNC_INTERVAL_SECONDS = 30;
export const MAX_SYNC_INTERVAL_SECONDS = 3600;

/**
 * Cadences offered as presets in Settings. A bounded list rather than a free
 * number input: the useful range spans two orders of magnitude, and every
 * interesting value is a round one.
 */
export const SYNC_INTERVAL_PRESET_SECONDS = [30, 60, 300, 900, 3600] as const;

/** Clamp one stored interval into range, falling back when absent or unusable. */
function resolveInterval(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(
    MAX_SYNC_INTERVAL_SECONDS,
    Math.max(MIN_SYNC_INTERVAL_SECONDS, Math.round(value)),
  );
}

/**
 * Per-machine cadence for one project. Absent leaves resolve to the shipped
 * defaults, so a config written before these keys existed keeps today's timing.
 *
 * The clamp is the live default path, not a redundant second gate: the schema
 * leaves carry `.catch(undefined)`, so an out-of-range or non-numeric value
 * drops to absent rather than failing the whole layer, and lands here.
 */
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
