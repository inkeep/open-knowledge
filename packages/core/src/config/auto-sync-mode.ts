/**
 * Sync-mode vocabulary and the rules that turn stored config into an effective
 * mode.
 *
 * `autoSync.mode` is the canonical per-project sync knob: `off` (no sync),
 * `follow` (one-directional — fetch and fast-forward, never push), `full`
 * (bidirectional). It is the single source of truth for "should this project
 * push?" — only `full` pushes — so no reader can misread a follow-only
 * project's consent as push permission.
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

/** The autoSync shape the pause/resume helpers read (per-machine layer). */
type LocalAutoSync = {
  mode?: StoredSyncMode | null;
  enabled?: boolean | null;
  resumeMode?: StoredSyncActiveMode | null;
};

/**
 * The mode a paused project resumes into. `resumeMode` is per-machine UI memory
 * written only when sync is paused (mode `off`) after having been enabled, so an
 * older app that predates the key still reads `mode: 'off'` and never syncs or
 * pushes. It is meaningful only while `mode` is `off`; ignored otherwise.
 */
export function resumeModeOf(autoSync: LocalAutoSync | undefined): SyncActiveMode | null {
  const resume = autoSync?.resumeMode;
  if (resume === LEGACY_FOLLOW_MODE) return 'follow';
  return isSyncActiveMode(resume) ? resume : null;
}

/**
 * True when this machine turned sync off after having enabled it — the "paused"
 * state (distinct from a never-answered or explicitly-off project). Signalled by
 * `mode: 'off'` together with a remembered `resumeMode`.
 */
export function isSyncPaused(autoSync: LocalAutoSync | undefined): boolean {
  return resolveLocalAutoSyncMode(autoSync) === 'off' && resumeModeOf(autoSync) !== null;
}

/**
 * True when this machine has ever enabled sync for this project — either sync is
 * currently active, or it is paused (was enabled, now off). Drives whether the
 * manual "Sync" action is offered.
 */
export function hasEverEnabledSync(autoSync: LocalAutoSync | undefined): boolean {
  const mode = resolveLocalAutoSyncMode(autoSync);
  return mode === 'follow' || mode === 'full' || isSyncPaused(autoSync);
}

/**
 * The active-mode value a Full/Follow control should display: the live mode when
 * sync is active, otherwise the remembered resume mode (defaulting to `full`).
 */
export function displayActiveMode(autoSync: LocalAutoSync | undefined): SyncActiveMode {
  const mode = resolveLocalAutoSyncMode(autoSync);
  if (isSyncActiveMode(mode)) return mode;
  return resumeModeOf(autoSync) ?? 'full';
}

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
