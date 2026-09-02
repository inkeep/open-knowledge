import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OkTerminalRestartSnapshot } from '@inkeep/open-knowledge-core/desktop-bridge';
import { canonicalizeGitHubRemoteUrl } from './git-remote.ts';

interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
  missing?: boolean;
  gitRemoteUrl?: string;
}

export interface PersistedWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFullScreen: boolean;
}

interface PersistedEditorPane {
  id: string;
  openTabs: string[];
  pinnedTabIds: string[];
  activeTabId: string | null;
  size: number;
}

export type RestoredWindow =
  | { kind: 'project'; projectPath: string }
  | { kind: 'file'; filePath: string }
  | {
      kind: 'doc';
      projectPath: string;
      docName: string;
      bounds?: PersistedWindowBounds;
    };

export function windowRestoreKey(w: RestoredWindow): string {
  if (w.kind === 'project') return w.projectPath;
  if (w.kind === 'file') return w.filePath;
  return `\u0000doc:${w.projectPath}\u0000${w.docName}`;
}

export function restoreSurvivorPath(w: RestoredWindow): string {
  if (w.kind === 'file') return w.filePath;
  return w.projectPath;
}

interface RecentFile {
  path: string;
  name: string;
  lastOpenedAt: string;
}

export interface ProjectSessionState {
  updatedAt: string | null;
  panes: PersistedEditorPane[];
  focusedPaneId: string;
}

export interface PersistedTerminalDockState {
  terminalVisible: boolean;
  terminalSnapshot: OkTerminalRestartSnapshot;
}

export type UpdateChannel = 'latest' | 'beta';

export const CURRENT_SCHEMA_VERSION = 1;

export const MAX_SUPPORTED_SCHEMA_VERSION = 1;

export interface AppState {
  recentProjects: RecentProject[];
  recentFiles: RecentFile[];
  lastOpenedProject: string | null;
  versionPendingInstall: string | null;
  stagedInstallerPath: string | null;
  attemptedInstall: string | null;
  attemptedInstallSurfacedCount: number;
  versionPendingInstallStagedAt: number | null;
  attemptedInstallStagingAgeMs: number | null;
  attemptedInstallHandoffAt: number | null;
  attemptedInstallDeferredBoots: number;
  lastSeenVersion: string | null;
  lastSuccessfulCheckAt: string | null;
  stuckHintShown: boolean;
  dismissedRepairForBundle: string | null;
  projectSessions: Record<string, ProjectSessionState>;
  projectWindowBounds: Record<string, PersistedWindowBounds>;
  noteWindowBounds: Record<string, PersistedWindowBounds>;
  terminalDockStates: Record<string, PersistedTerminalDockState>;
  schemaVersion: number;
  lastUsedProjectParent: string | null;
  pendingWindowRestore: RestoredWindow[] | null;
  spellCheckEnabled: boolean;
}

const RECENT_CAP = 20;
const RECENT_FILES_CAP = 20;

function nonNegativeIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function nonNegativeIntOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function emptyState(): AppState {
  return {
    recentProjects: [],
    recentFiles: [],
    lastOpenedProject: null,
    versionPendingInstall: null,
    stagedInstallerPath: null,
    attemptedInstall: null,
    attemptedInstallSurfacedCount: 0,
    versionPendingInstallStagedAt: null,
    attemptedInstallStagingAgeMs: null,
    attemptedInstallHandoffAt: null,
    attemptedInstallDeferredBoots: 0,
    lastSeenVersion: null,
    lastSuccessfulCheckAt: null,
    stuckHintShown: false,
    dismissedRepairForBundle: null,
    projectSessions: {},
    projectWindowBounds: {},
    noteWindowBounds: {},
    terminalDockStates: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
    lastUsedProjectParent: null,
    pendingWindowRestore: null,
    spellCheckEnabled: true,
  };
}

export function setLastUsedProjectParent(state: AppState, parent: string): AppState {
  return { ...state, lastUsedProjectParent: parent };
}

export function setSpellCheckEnabled(state: AppState, enabled: boolean): AppState {
  return { ...state, spellCheckEnabled: enabled };
}

export function emptyProjectSessionState(): ProjectSessionState {
  return {
    updatedAt: null,
    panes: [
      {
        id: 'pane-main',
        openTabs: [],
        pinnedTabIds: [],
        activeTabId: null,
        size: 100,
      },
    ],
    focusedPaneId: 'pane-main',
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

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sanitizeOpenTabIds(value: unknown, claimedTargets = new Set<string>()): string[] {
  return sanitizeStringArray(value).filter((tabId) => {
    if (tabId.includes('\u0000doc-tab:')) return false;
    if (tabId.startsWith('\u0000')) return true;
    if (claimedTargets.has(tabId)) return false;
    claimedTargets.add(tabId);
    return true;
  });
}

function normalizePaneSizes(panes: PersistedEditorPane[]): PersistedEditorPane[] {
  if (panes.length === 0) return [];
  const total = panes.reduce((sum, pane) => sum + pane.size, 0);
  const fallbackSize = 100 / panes.length;
  return panes.map((pane) => ({
    ...pane,
    size: total > 0 ? (pane.size / total) * 100 : fallbackSize,
  }));
}

function parsePersistedEditorPanes(raw: unknown): PersistedEditorPane[] | null {
  if (!Array.isArray(raw)) return null;
  const paneIds = new Set<string>();
  const tabTargets = new Set<string>();
  const panes: PersistedEditorPane[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const pane = candidate as Record<string, unknown>;
    if (typeof pane.id !== 'string' || pane.id.length === 0 || paneIds.has(pane.id)) continue;
    paneIds.add(pane.id);
    const openTabs = sanitizeOpenTabIds(pane.openTabs, tabTargets);
    const openTabIds = new Set(openTabs);
    panes.push({
      id: pane.id,
      openTabs,
      pinnedTabIds: sanitizeStringArray(pane.pinnedTabIds).filter((tabId) => openTabIds.has(tabId)),
      activeTabId:
        typeof pane.activeTabId === 'string' && openTabIds.has(pane.activeTabId)
          ? pane.activeTabId
          : (openTabs[0] ?? null),
      size: isPositiveFiniteNumber(pane.size) ? pane.size : 1,
    });
  }
  return panes.length === 0 ? null : normalizePaneSizes(panes);
}

function parseProjectSessionState(raw: unknown): ProjectSessionState {
  if (typeof raw !== 'object' || raw === null) return emptyProjectSessionState();
  const obj = raw as Record<string, unknown>;
  const panes = parsePersistedEditorPanes(obj.panes);
  if (panes === null) return emptyProjectSessionState();
  const focusedPane = panes.find((pane) => pane.id === obj.focusedPaneId) ?? panes[0];
  return {
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : null,
    panes,
    focusedPaneId: focusedPane.id,
  };
}

function parsePersistedWindowBounds(raw: unknown): PersistedWindowBounds | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (
    !isFiniteNumber(obj.x) ||
    !isFiniteNumber(obj.y) ||
    !isFiniteNumber(obj.width) ||
    !isFiniteNumber(obj.height)
  ) {
    return null;
  }
  if (obj.width <= 0 || obj.height <= 0) return null;
  return {
    x: Math.round(obj.x),
    y: Math.round(obj.y),
    width: Math.round(obj.width),
    height: Math.round(obj.height),
    isMaximized: obj.isMaximized === true,
    isFullScreen: obj.isFullScreen === true,
  };
}

function parseProjectWindowBounds(raw: unknown): Record<string, PersistedWindowBounds> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const boundsByProject: Record<string, PersistedWindowBounds> = {};
  for (const [projectKey, value] of Object.entries(raw)) {
    if (projectKey.length === 0) continue;
    const bounds = parsePersistedWindowBounds(value);
    if (bounds !== null) boundsByProject[projectKey] = bounds;
  }
  return boundsByProject;
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

function parsePendingWindowRestore(raw: unknown): RestoredWindow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RestoredWindow[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let win: RestoredWindow | null = null;
    if (typeof item === 'string') {
      if (item.length > 0) win = { kind: 'project', projectPath: item };
    } else if (typeof item === 'object' && item !== null) {
      const o = item as Record<string, unknown>;
      if (o.kind === 'project' && typeof o.projectPath === 'string' && o.projectPath.length > 0) {
        win = { kind: 'project', projectPath: o.projectPath };
      } else if (o.kind === 'file' && typeof o.filePath === 'string' && o.filePath.length > 0) {
        win = { kind: 'file', filePath: o.filePath };
      } else if (
        o.kind === 'doc' &&
        typeof o.projectPath === 'string' &&
        o.projectPath.length > 0 &&
        typeof o.docName === 'string' &&
        o.docName.length > 0
      ) {
        const bounds = parsePersistedWindowBounds(o.bounds);
        win = {
          kind: 'doc',
          projectPath: o.projectPath,
          docName: o.docName,
          ...(bounds === null ? {} : { bounds }),
        };
      }
    }
    if (win === null) continue;
    const key = `${win.kind}:${windowRestoreKey(win)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(win);
  }
  return out;
}

function parseRecentFiles(raw: unknown): RecentFile[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentFile[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const item = r as Record<string, unknown>;
    if (
      typeof item.path === 'string' &&
      item.path.length > 0 &&
      typeof item.name === 'string' &&
      typeof item.lastOpenedAt === 'string' &&
      !seen.has(item.path)
    ) {
      seen.add(item.path);
      out.push({ path: item.path, name: item.name, lastOpenedAt: item.lastOpenedAt });
    }
  }
  return out;
}

export function addRecentProject(
  state: AppState,
  projectPath: string,
  name: string,
  gitRemoteUrl?: string,
): AppState {
  const now = new Date().toISOString();
  const prior = state.recentProjects.find((p) => p.path === projectPath);
  const filtered = state.recentProjects.filter((p) => p.path !== projectPath);
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

export function addRecentFile(state: AppState, filePath: string, name: string): AppState {
  const now = new Date().toISOString();
  const filtered = state.recentFiles.filter((f) => f.path !== filePath);
  const updated: RecentFile[] = [{ path: filePath, name, lastOpenedAt: now }, ...filtered].slice(
    0,
    RECENT_FILES_CAP,
  );
  return { ...state, recentFiles: updated };
}

export function removeRecentProject(state: AppState, projectPath: string): AppState {
  const projectSessions = { ...state.projectSessions };
  delete projectSessions[projectPath];
  const projectWindowBounds = { ...state.projectWindowBounds };
  delete projectWindowBounds[projectPath];
  const noteWindowBounds = { ...state.noteWindowBounds };
  delete noteWindowBounds[projectPath];
  const terminalDockStates = { ...state.terminalDockStates };
  delete terminalDockStates[projectPath];
  return {
    ...state,
    recentProjects: state.recentProjects.filter((p) => p.path !== projectPath),
    lastOpenedProject: state.lastOpenedProject === projectPath ? null : state.lastOpenedProject,
    projectSessions,
    projectWindowBounds,
    noteWindowBounds,
    terminalDockStates,
  };
}

export function setProjectWindowBounds(
  state: AppState,
  projectPath: string,
  bounds: PersistedWindowBounds,
): AppState {
  return {
    ...state,
    projectWindowBounds: { ...state.projectWindowBounds, [projectPath]: bounds },
  };
}

export function setNoteWindowBounds(
  state: AppState,
  projectPath: string,
  bounds: PersistedWindowBounds,
): AppState {
  return {
    ...state,
    noteWindowBounds: { ...state.noteWindowBounds, [projectPath]: bounds },
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

function emptyTerminalDockState(): PersistedTerminalDockState {
  return {
    terminalVisible: false,
    terminalSnapshot: { tabs: [], activeOrdinal: null },
  };
}

export function normalizeTerminalRestartSnapshot(raw: unknown): OkTerminalRestartSnapshot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { tabs: [], activeOrdinal: null };
  }
  const obj = raw as Record<string, unknown>;
  const seenOrdinals = new Set<number>();
  const tabs = Array.isArray(obj.tabs)
    ? obj.tabs.flatMap((rawTab) => {
        if (typeof rawTab !== 'object' || rawTab === null || Array.isArray(rawTab)) return [];
        const tab = rawTab as Record<string, unknown>;
        if (
          typeof tab.ordinal !== 'number' ||
          !Number.isInteger(tab.ordinal) ||
          tab.ordinal < 1 ||
          seenOrdinals.has(tab.ordinal)
        ) {
          return [];
        }
        seenOrdinals.add(tab.ordinal);
        return [
          {
            ordinal: tab.ordinal,
            customLabel: typeof tab.customLabel === 'string' ? tab.customLabel : null,
          },
        ];
      })
    : [];
  const activeOrdinal =
    typeof obj.activeOrdinal === 'number' &&
    Number.isInteger(obj.activeOrdinal) &&
    seenOrdinals.has(obj.activeOrdinal)
      ? obj.activeOrdinal
      : null;
  return { tabs, activeOrdinal };
}

function parsePersistedTerminalDockState(raw: unknown): PersistedTerminalDockState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return emptyTerminalDockState();
  }
  const obj = raw as Record<string, unknown>;
  return {
    terminalVisible: obj.terminalVisible === true,
    terminalSnapshot: normalizeTerminalRestartSnapshot(obj.terminalSnapshot),
  };
}

function parseTerminalDockStates(raw: unknown): Record<string, PersistedTerminalDockState> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const states: Record<string, PersistedTerminalDockState> = {};
  for (const [projectPath, value] of Object.entries(raw)) {
    if (projectPath.length > 0) states[projectPath] = parsePersistedTerminalDockState(value);
  }
  return states;
}

export function getTerminalDockState(
  state: AppState,
  projectPath: string,
): PersistedTerminalDockState {
  return state.terminalDockStates[projectPath] ?? emptyTerminalDockState();
}

export function setTerminalDockState(
  state: AppState,
  projectPath: string,
  dockState: PersistedTerminalDockState,
): AppState {
  return {
    ...state,
    terminalDockStates: {
      ...state.terminalDockStates,
      [projectPath]: parsePersistedTerminalDockState(dockState),
    },
  };
}

export function annotateMissing(
  state: AppState,
  exists: (path: string) => boolean = existsSync,
): RecentProject[] {
  return state.recentProjects.map((p) => ({
    ...p,
    missing: !exists(p.path),
  }));
}

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
        err,
        statePath,
      });
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      return false;
    }
  } catch (err) {
    logger.error('[main] saveAppState userData setup failed', {
      err,
      userDataDir,
    });
    return false;
  }
}

export interface SchemaIncompatibilityDiagnostic {
  currentBuild: string;
  persistedSchemaVersion: number;
  maxSupported: number;
}

type SchemaCompatibilityResult =
  | { status: 'ok' }
  | { status: 'incompatible'; diagnostic: SchemaIncompatibilityDiagnostic };

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
        const healed = canonicalizeGitHubRemoteUrl(item.gitRemoteUrl);
        if (healed !== null) {
          entry.gitRemoteUrl = healed;
        }
      }
      recentProjects.push(entry);
    }
  }
  const lastOpenedProject =
    typeof obj.lastOpenedProject === 'string' ? obj.lastOpenedProject : null;
  const versionPendingInstall =
    typeof obj.versionPendingInstall === 'string' ? obj.versionPendingInstall : null;
  const stagedInstallerPath =
    typeof obj.stagedInstallerPath === 'string' && obj.stagedInstallerPath.length > 0
      ? obj.stagedInstallerPath
      : null;
  const attemptedInstall = typeof obj.attemptedInstall === 'string' ? obj.attemptedInstall : null;
  const attemptedInstallSurfacedCount = nonNegativeIntOrZero(obj.attemptedInstallSurfacedCount);
  const attemptedInstallDeferredBoots = nonNegativeIntOrZero(obj.attemptedInstallDeferredBoots);
  const versionPendingInstallStagedAt = nonNegativeIntOrNull(obj.versionPendingInstallStagedAt);
  const attemptedInstallStagingAgeMs = nonNegativeIntOrNull(obj.attemptedInstallStagingAgeMs);
  const attemptedInstallHandoffAt = nonNegativeIntOrNull(obj.attemptedInstallHandoffAt);
  const lastSeenVersion = typeof obj.lastSeenVersion === 'string' ? obj.lastSeenVersion : null;
  const lastSuccessfulCheckAt =
    typeof obj.lastSuccessfulCheckAt === 'string' ? obj.lastSuccessfulCheckAt : null;
  const stuckHintShown = obj.stuckHintShown === true;
  const dismissedRepairForBundle =
    typeof obj.dismissedRepairForBundle === 'string' ? obj.dismissedRepairForBundle : null;
  const schemaVersion =
    typeof obj.schemaVersion === 'number' && Number.isInteger(obj.schemaVersion)
      ? obj.schemaVersion
      : 1;
  const projectSessions = parseProjectSessions(obj.projectSessions);
  const projectWindowBounds = parseProjectWindowBounds(obj.projectWindowBounds);
  const noteWindowBounds = parseProjectWindowBounds(obj.noteWindowBounds);
  const terminalDockStates = parseTerminalDockStates(obj.terminalDockStates);
  const lastUsedProjectParent =
    typeof obj.lastUsedProjectParent === 'string' && obj.lastUsedProjectParent.length > 0
      ? obj.lastUsedProjectParent
      : null;
  const pendingWindowRestore = parsePendingWindowRestore(obj.pendingWindowRestore);
  const recentFiles = parseRecentFiles(obj.recentFiles);
  const spellCheckEnabled =
    typeof obj.spellCheckEnabled === 'boolean' ? obj.spellCheckEnabled : true;
  return {
    recentProjects,
    recentFiles,
    lastOpenedProject,
    versionPendingInstall,
    stagedInstallerPath,
    attemptedInstall,
    attemptedInstallSurfacedCount,
    versionPendingInstallStagedAt,
    attemptedInstallStagingAgeMs,
    attemptedInstallHandoffAt,
    attemptedInstallDeferredBoots,
    lastSeenVersion,
    lastSuccessfulCheckAt,
    stuckHintShown,
    dismissedRepairForBundle,
    projectSessions,
    projectWindowBounds,
    noteWindowBounds,
    terminalDockStates,
    schemaVersion,
    lastUsedProjectParent,
    pendingWindowRestore,
    spellCheckEnabled,
  };
}
