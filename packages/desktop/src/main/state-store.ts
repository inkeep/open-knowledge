/**
 * Pure state-store helpers for app-level persistence (recent projects, last-
 * opened, window bounds). The main entry persists this to
 * `app.getPath('userData')/state.json`; tests exercise the pure helpers
 * directly without an Electron process.
 *
 * Recent-projects shape: LRU array, cap 20, realpath-canonicalized
 * `contentDir` as key. Improvements over surveyed apps (Obsidian, VS Code):
 * we use `realpath` so symlinked projects collapse to the same entry, matching
 * OK's existing realpath-based file-watcher identity.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
  /** Computed at read time — `existsSync(path)` was false when this snapshot was built. */
  missing?: boolean;
  /**
   * Canonical GitHub remote URL (`https://github.com/<owner>/<repo>.git`)
   * when this project has a github.com origin. Undefined when the project
   * has no `.git/config`, no `[remote "origin"]`, or a non-GitHub remote.
   * Powers the RecentProject-lookup in the share-receive decision tree:
   * an incoming share-URL's `{owner, repo}` resolves to a canonical URL
   * and the desktop scans recents for a matching entry. Backfilled on
   * every project open, so legacy entries persisted before the field
   * existed self-heal without a schema bump.
   */
  gitRemoteUrl?: string;
}

interface ProjectSessionState {
  /** User-open tabs for this project, in visible tab order. */
  openTabs: string[];
  /** Visible tab IDs protected from tab-strip close affordances. */
  pinnedTabIds: string[];
  /** Most recently active document tab, or null when the project had no active doc. */
  activeDocName: string | null;
  /** Most recently active tab, including folder overview tabs. */
  activeTabId: string | null;
  /** ISO-8601 timestamp of the last tab-session write. */
  updatedAt: string | null;
}

/**
 * Auto-update channel. The build's version string is the sole source of
 * truth (`channelFromVersion` in `auto-updater.ts`) — `'beta'` for a
 * prerelease build, `'latest'` for a stable one. Channels are install-time
 * sticky: a beta DMG only auto-updates to a newer beta DMG, a stable DMG
 * only to a newer stable DMG. To switch channels the user uninstalls and
 * reinstalls; there is no persisted preference and no in-app toggle.
 */
export type UpdateChannel = 'latest' | 'beta';

/**
 * Schema version the running build knows how to read. Bump when introducing
 * an `AppState` change that the previous reader cannot safely parse — and
 * raise `MAX_SUPPORTED_SCHEMA_VERSION` to match. Additive field changes do
 * NOT require a bump (they pass the `?? default` reader path unchanged).
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Highest `schemaVersion` this build can read without losing data. Diverges
 * from `CURRENT_SCHEMA_VERSION` only during a migration window where this
 * build can still read older formats but writes the newer one. A boot that
 * sees `persisted.schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION` refuses to
 * silently parse the future state and surfaces to the user.
 */
export const MAX_SUPPORTED_SCHEMA_VERSION = 1;

export interface AppState {
  /** LRU-capped recent-projects, newest first. */
  recentProjects: RecentProject[];
  /** Most recently opened project, or null if Navigator was last visible. */
  lastOpenedProject: string | null;
  /**
   * Version string (e.g. "0.3.0") of an update that `autoUpdater` has
   * downloaded and is awaiting install-on-quit. Gates Toast A to fire at
   * most once per pending-update state; cleared after install completes.
   */
  versionPendingInstall: string | null;
  /**
   * Version the app committed to install and is expected to be running after
   * the next boot. Set when an update finishes downloading (the install is
   * then committed to run on the next quit, via either "Relaunch now" or
   * `autoInstallOnAppQuit`). Unlike `versionPendingInstall` — which the
   * "Relaunch now" handler clears BEFORE `quitAndInstall()` as a double-invoke
   * guard — this record survives the quit, so the boot reconciliation can tell
   * "install succeeded" (running caught up) from "install failed" (booted back
   * on the old version, e.g. Squirrel.Mac's post-quit ShipIt never ran).
   * Cleared on boot once reconciled. Compared with a prerelease-aware compare,
   * not the MMP-only `versionAtLeast`, so a same-major.minor.patch beta bump
   * (the OK beta cadence) is distinguishable.
   */
  attemptedInstall: string | null;
  /**
   * How many times the boot-time failed-install notice has been surfaced for
   * the current `attemptedInstall`. Bounds the per-boot nag: `attemptedInstall`
   * only clears once the running version finally reaches it, so without a cap a
   * genuinely stuck or unreachable attempt (a persistently-failing ShipIt, a
   * yanked release, a channel move) would re-fire the "didn't install" card on
   * every boot forever. Reset to 0 when a new version is armed and on a
   * successful reconcile; at `INSTALL_FAILURE_MAX_SURFACES` the record is
   * dropped and the notice goes quiet (the 7-day stuck-hint stays the backstop).
   * Non-negative integer.
   */
  attemptedInstallSurfacedCount: number;
  /**
   * Last version the app successfully booted under — compared to
   * `app.getVersion()` at auto-updater start to decide whether to fire
   * Toast B ("Updated to Version ..."). Null before the first recorded boot,
   * which also shows the notice before seeding the baseline. Advances on
   * every successful boot.
   */
  lastSeenVersion: string | null;
  /**
   * ISO-8601 timestamp of the last successful update-check outcome
   * (`checking-for-update` settling into `update-available` or
   * `update-not-available`). Null before the first successful check. Used
   * by the stuck-hint 7-day counter — failed checks leave this unchanged,
   * so `now - lastSuccessfulCheckAt` grows monotonically during
   * silent-failure windows.
   */
  lastSuccessfulCheckAt: string | null;
  /**
   * Whether Toast C (the once-per-installation stuck-update hint) has
   * already fired. Flips true on first dispatch; resets to false on any
   * successful update check so the hint can re-arm if the update pipeline
   * breaks again after a repaired window.
   */
  stuckHintShown: boolean;
  /**
   * Per-bundle dismissal token for the "Command-Line Tools are broken —
   * repair?" launch-time modal. Keyed by `<appVersion>:<exePath>` so an
   * auto-update OR app-move invalidates the token (the user re-consents on
   * the new bundle). Null before any dismissal.
   *
   * Without this, the modal fires on every launch while status is 'broken'
   * — a consent-fatigue hazard given the Repair button leads into the
   * osascript admin-password prompt. Users who don't
   * care about CLI tools would be reflexively dismissing a root-adjacent
   * modal every boot until they either run Repair or move the .app back.
   *
   * Per-bundle semantics (not permanent skip): an auto-update that shifts
   * `app.getVersion()` OR a user-initiated drag-to-/Applications/ that
   * shifts `app.getPath('exe')` forms a new token value; the modal fires
   * exactly once against the new bundle, then respects Skip for the rest
   * of that bundle's lifetime.
   */
  dismissedRepairForBundle: string | null;
  /** Per-project editor session state, keyed by realpath-canonical contentDir. */
  projectSessions: Record<string, ProjectSessionState>;
  /**
   * Schema version of the persisted state, written by whichever build last
   * touched it. Reads default to `1` when the field is missing. The boot
   * path in main/index.ts compares this against `MAX_SUPPORTED_SCHEMA_VERSION`
   * — a value greater than the max means the state was written by a future
   * build (typically a beta) the current build can't safely parse, and the
   * boot path surfaces a refuse-downgrade UX rather than silently overwriting.
   */
  schemaVersion: number;
  /**
   * Last parent directory the user picked in the Create-new-project dialog.
   * Persists across launches so the Location field defaults to the user's
   * working pattern (e.g., `~/Notes/`) instead of resetting to
   * `~/Documents/OpenKnowledge/` every session. The IPC handler
   * `ok:project:create-new` writes this on successful create; the read-only
   * `ok:fs:default-projects-root` reads it. Stores the user-picked PARENT
   * (not the resolved project dir — `ensureProjectGit` may promote to an
   * ancestor git root inside the scaffold spine, but the user's intent is
   * the parent they chose). `null` (or a path that no longer exists) falls
   * back to `~/Documents/OpenKnowledge/`.
   */
  lastUsedProjectParent: string | null;
  /**
   * Snapshot of every project window open at the moment the auto-updater's
   * `quitAndInstall()` was about to fire (the `prepareForRelaunch` hook).
   * The next boot restores ALL of these windows, not just `lastOpenedProject`
   * — an update relaunch should land the user back where they were.
   *
   * `null` means no relaunch-restore is pending: the normal boot path opens
   * `lastOpenedProject` (or the Navigator). An empty array means a relaunch
   * happened with no project windows open (only the Navigator) — the boot
   * path consumes it and opens the Navigator rather than `lastOpenedProject`.
   * Cleared back to `null` on the boot that consumes it, before any window
   * opens, so a crash mid-restore can't loop the restore forever.
   */
  pendingWindowRestore: string[] | null;
  /**
   * Whether spell check is enabled. `session.setSpellCheckerEnabled` is
   * session-wide and all OK windows share the default session, so this is a
   * single app-level flag re-applied at window creation. Defaults to `true`
   * (Chromium's default); persisted so a user's disable survives relaunch.
   */
  spellCheckEnabled: boolean;
}

const RECENT_CAP = 20;

export function emptyState(): AppState {
  return {
    recentProjects: [],
    lastOpenedProject: null,
    versionPendingInstall: null,
    attemptedInstall: null,
    attemptedInstallSurfacedCount: 0,
    lastSeenVersion: null,
    lastSuccessfulCheckAt: null,
    stuckHintShown: false,
    dismissedRepairForBundle: null,
    projectSessions: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
    lastUsedProjectParent: null,
    pendingWindowRestore: null,
    spellCheckEnabled: true,
  };
}

/**
 * Update the persisted last-used parent directory the user picked in the
 * Create-new-project dialog. Returns a new state — caller persists.
 */
export function setLastUsedProjectParent(state: AppState, parent: string): AppState {
  return { ...state, lastUsedProjectParent: parent };
}

/**
 * Update the persisted app-wide spell-check toggle. Returns a new state —
 * caller persists.
 */
export function setSpellCheckEnabled(state: AppState, enabled: boolean): AppState {
  return { ...state, spellCheckEnabled: enabled };
}

function emptyProjectSessionState(): ProjectSessionState {
  return {
    openTabs: [],
    pinnedTabIds: [],
    activeDocName: null,
    activeTabId: null,
    updatedAt: null,
  };
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (item.length === 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function parseProjectSessionState(raw: unknown): ProjectSessionState {
  if (typeof raw !== 'object' || raw === null) return emptyProjectSessionState();
  const obj = raw as Record<string, unknown>;
  const openTabs = sanitizeStringArray(obj.openTabs);
  const openTabSet = new Set(openTabs);
  const pinnedTabIds = sanitizeStringArray(obj.pinnedTabIds).filter((tabId) =>
    openTabSet.has(tabId),
  );
  const activeDocName =
    typeof obj.activeDocName === 'string' && openTabs.includes(obj.activeDocName)
      ? obj.activeDocName
      : null;
  const activeTabId =
    typeof obj.activeTabId === 'string' && openTabs.includes(obj.activeTabId)
      ? obj.activeTabId
      : activeDocName;
  return {
    openTabs,
    pinnedTabIds,
    activeDocName,
    activeTabId,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : null,
  };
}

function parseProjectSessions(raw: unknown): Record<string, ProjectSessionState> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const sessions: Record<string, ProjectSessionState> = {};
  for (const [projectPath, session] of Object.entries(raw)) {
    if (projectPath.length === 0) continue;
    sessions[projectPath] = parseProjectSessionState(session);
  }
  return sessions;
}

/**
 * Add a project to the recent list (or move to front if already present).
 * Returns a NEW state (immutable update — caller persists).
 *
 * `gitRemoteUrl` is the optional canonical GitHub remote URL for the
 * project (e.g. `https://github.com/<owner>/<repo>.git`). Callers omit
 * this argument when the project has no GitHub origin; on re-open of an
 * already-recent project, omitting the argument PRESERVES any previously
 * persisted value rather than clearing it — a project whose origin
 * disappeared transiently (network share unmounted, tooling glitch) does
 * not lose its `gitRemoteUrl` until the caller passes an explicit value
 * indicating fresh truth.
 */
export function addRecentProject(
  state: AppState,
  projectPath: string,
  name: string,
  gitRemoteUrl?: string,
): AppState {
  const now = new Date().toISOString();
  const prior = state.recentProjects.find((p) => p.path === projectPath);
  const filtered = state.recentProjects.filter((p) => p.path !== projectPath);
  // Caller-supplied value is authoritative; if absent, preserve any prior
  // truth so a transient `.git/config` blip doesn't strip the field.
  const resolvedRemoteUrl = gitRemoteUrl ?? prior?.gitRemoteUrl;
  const entry: RecentProject = {
    path: projectPath,
    name,
    lastOpenedAt: now,
  };
  if (resolvedRemoteUrl !== undefined) {
    entry.gitRemoteUrl = resolvedRemoteUrl;
  }
  const updated: RecentProject[] = [entry, ...filtered].slice(0, RECENT_CAP);
  return { ...state, recentProjects: updated, lastOpenedProject: projectPath };
}

/** Remove a project from the recent list. */
export function removeRecentProject(state: AppState, projectPath: string): AppState {
  const projectSessions = { ...state.projectSessions };
  delete projectSessions[projectPath];
  return {
    ...state,
    recentProjects: state.recentProjects.filter((p) => p.path !== projectPath),
    lastOpenedProject: state.lastOpenedProject === projectPath ? null : state.lastOpenedProject,
    projectSessions,
  };
}

export function getProjectSessionState(state: AppState, projectPath: string): ProjectSessionState {
  return state.projectSessions[projectPath] ?? emptyProjectSessionState();
}

export function setProjectSessionState(
  state: AppState,
  projectPath: string,
  session: ProjectSessionState,
): AppState {
  return {
    ...state,
    projectSessions: {
      ...state.projectSessions,
      [projectPath]: parseProjectSessionState(session),
    },
  };
}

/**
 * Annotate the recent list with `missing: true` for projects whose folder
 * no longer exists. Pure read; doesn't mutate state.
 */
export function annotateMissing(
  state: AppState,
  exists: (path: string) => boolean = existsSync,
): RecentProject[] {
  return state.recentProjects.map((p) => ({
    ...p,
    missing: !exists(p.path),
  }));
}

/**
 * Persist `state` to `<userDataDir>/state.json` atomically. Writes to a
 * `.tmp-<pid>-<ms>` sibling first, then renames to the canonical path. A
 * crash mid-write leaves either the prior file intact OR the fully-formed
 * new file — never a half-written blob. Logs on failure (bracket-prefixed
 * per CLAUDE.md logging conventions); does not throw.
 *
 * Returns `true` on successful persist, `false` on any failure (EACCES,
 * disk full, rename race, userData mkdir failure). The boolean lets
 * callers that need disk-persistence-succeeded semantics (e.g. the
 * auto-updater's persist-before-emit gate) distinguish "in-memory + disk
 * agree" from "in-memory mutated but disk stale." Existing callers that
 * ignore the return value get the same void-like behavior as before.
 *
 * Injected `fs` hook for tests. Production callers pass `undefined` to use
 * the module-scope `node:fs` imports.
 */
export interface SaveAppStateFs {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}

const DEFAULT_FS: SaveAppStateFs = {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
};

export function saveAppStateToDir(
  userDataDir: string,
  state: AppState,
  fs: SaveAppStateFs = DEFAULT_FS,
  logger: { error(msg: string, ctx?: object): void } = console,
): boolean {
  try {
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
    const statePath = join(userDataDir, 'state.json');
    const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
      fs.renameSync(tmpPath, statePath);
      return true;
    } catch (err) {
      logger.error('[main] saveAppState failed', {
        err: (err as Error).message,
        statePath,
      });
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // tmp file may not exist — best-effort cleanup.
      }
      return false;
    }
  } catch (err) {
    logger.error('[main] saveAppState userData setup failed', {
      err: (err as Error).message,
      userDataDir,
    });
    return false;
  }
}

/**
 * Diagnostic surfaced to the renderer when the persisted state was written
 * by a future build (typically a beta) that bumped `schemaVersion` past
 * what the current build can read. The renderer-side UX (refuse-downgrade
 * Toast / dialog with "Stay on Beta" / "Reset and Continue to Stable"
 * options) consumes this payload to explain to the user what happened.
 */
export interface SchemaIncompatibilityDiagnostic {
  currentBuild: string;
  persistedSchemaVersion: number;
  maxSupported: number;
}

type SchemaCompatibilityResult =
  | { status: 'ok' }
  | { status: 'incompatible'; diagnostic: SchemaIncompatibilityDiagnostic };

/**
 * Compare the persisted `schemaVersion` to what this build can read. Returns
 * `'ok'` when the state is safe to load (today's universal case — current
 * and max are both `1`). Returns `'incompatible'` when a future build has
 * written a higher `schemaVersion`; callers MUST NOT silently overwrite the
 * state file in that case — surface the diagnostic to the user.
 *
 * Pure: no I/O, no Electron, testable directly. The boot-site call lives in
 * main/index.ts; the renderer surface lives in the renderer-mount IPC seam.
 */
export function evaluateSchemaCompatibility(
  state: Pick<AppState, 'schemaVersion'>,
  maxSupported: number,
  currentBuild: string,
): SchemaCompatibilityResult {
  if (state.schemaVersion > maxSupported) {
    return {
      status: 'incompatible',
      diagnostic: {
        currentBuild,
        persistedSchemaVersion: state.schemaVersion,
        maxSupported,
      },
    };
  }
  return { status: 'ok' };
}

/**
 * Coerce an unknown JSON blob into AppState shape. Returns emptyState() for
 * invalid input (the caller should rename the corrupt file to
 * `state.json.corrupt-<ts>` and start fresh).
 */
export function parseAppState(raw: unknown): AppState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const recentRaw = obj.recentProjects;
  if (!Array.isArray(recentRaw)) return null;
  const recentProjects: RecentProject[] = [];
  for (const r of recentRaw) {
    if (typeof r !== 'object' || r === null) continue;
    const item = r as Record<string, unknown>;
    if (
      typeof item.path === 'string' &&
      typeof item.name === 'string' &&
      typeof item.lastOpenedAt === 'string'
    ) {
      const entry: RecentProject = {
        path: item.path,
        name: item.name,
        lastOpenedAt: item.lastOpenedAt,
      };
      if (typeof item.gitRemoteUrl === 'string' && item.gitRemoteUrl.length > 0) {
        entry.gitRemoteUrl = item.gitRemoteUrl;
      }
      recentProjects.push(entry);
    }
  }
  const lastOpenedProject =
    typeof obj.lastOpenedProject === 'string' ? obj.lastOpenedProject : null;
  // Update-channel fields: defensive coercion with forward-compat defaults.
  // A state.json lacking these keys returns a valid AppState whose four new
  // fields match emptyState() defaults (no quarantine, no data loss).
  const versionPendingInstall =
    typeof obj.versionPendingInstall === 'string' ? obj.versionPendingInstall : null;
  const attemptedInstall = typeof obj.attemptedInstall === 'string' ? obj.attemptedInstall : null;
  // Additive field: a missing or invalid value coerces to 0 (a fresh failure
  // budget), matching emptyState(); guards against negatives and non-integers
  // from a corrupted state.json.
  const attemptedInstallSurfacedCount =
    typeof obj.attemptedInstallSurfacedCount === 'number' &&
    Number.isInteger(obj.attemptedInstallSurfacedCount) &&
    obj.attemptedInstallSurfacedCount >= 0
      ? obj.attemptedInstallSurfacedCount
      : 0;
  const lastSeenVersion = typeof obj.lastSeenVersion === 'string' ? obj.lastSeenVersion : null;
  const lastSuccessfulCheckAt =
    typeof obj.lastSuccessfulCheckAt === 'string' ? obj.lastSuccessfulCheckAt : null;
  const stuckHintShown = obj.stuckHintShown === true;
  // Defensive coercion — a state.json lacking
  // this key returns null (no prior dismissal), matching emptyState()
  // default; no quarantine.
  const dismissedRepairForBundle =
    typeof obj.dismissedRepairForBundle === 'string' ? obj.dismissedRepairForBundle : null;
  const schemaVersion =
    typeof obj.schemaVersion === 'number' && Number.isInteger(obj.schemaVersion)
      ? obj.schemaVersion
      : 1;
  const projectSessions = parseProjectSessions(obj.projectSessions);
  // Defensive: only string values survive; everything else (null, undefined,
  // wrong type from a corrupted state.json) coerces to null and the read
  // handler falls back to the platform default.
  const lastUsedProjectParent =
    typeof obj.lastUsedProjectParent === 'string' && obj.lastUsedProjectParent.length > 0
      ? obj.lastUsedProjectParent
      : null;
  // Defensive: only an array coerces to a (deduped, string-only) restore
  // snapshot; everything else (absent key on a legacy state.json, null, wrong
  // type) returns null — the normal `lastOpenedProject` boot path.
  const pendingWindowRestore = Array.isArray(obj.pendingWindowRestore)
    ? sanitizeStringArray(obj.pendingWindowRestore)
    : null;
  // Additive field: a missing or non-boolean value coerces to the `true`
  // default, so only an explicit persisted `false` keeps checking off.
  const spellCheckEnabled =
    typeof obj.spellCheckEnabled === 'boolean' ? obj.spellCheckEnabled : true;
  return {
    recentProjects,
    lastOpenedProject,
    versionPendingInstall,
    attemptedInstall,
    attemptedInstallSurfacedCount,
    lastSeenVersion,
    lastSuccessfulCheckAt,
    stuckHintShown,
    dismissedRepairForBundle,
    projectSessions,
    schemaVersion,
    lastUsedProjectParent,
    pendingWindowRestore,
    spellCheckEnabled,
  };
}
