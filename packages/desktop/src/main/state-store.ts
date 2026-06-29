
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
  missing?: boolean;
  gitRemoteUrl?: string;
}

interface ProjectSessionState {
  openTabs: string[];
  pinnedTabIds: string[];
  activeDocName: string | null;
  activeTabId: string | null;
  updatedAt: string | null;
}

export type UpdateChannel = 'latest' | 'beta';

export const CURRENT_SCHEMA_VERSION = 1;

export const MAX_SUPPORTED_SCHEMA_VERSION = 1;

export interface AppState {
  recentProjects: RecentProject[];
  lastOpenedProject: string | null;
  versionPendingInstall: string | null;
  attemptedInstall: string | null;
  lastSeenVersion: string | null;
  lastSuccessfulCheckAt: string | null;
  stuckHintShown: boolean;
  dismissedRepairForBundle: string | null;
  projectSessions: Record<string, ProjectSessionState>;
  schemaVersion: number;
  lastUsedProjectParent: string | null;
  pendingWindowRestore: string[] | null;
  spellCheckEnabled: boolean;
}

const RECENT_CAP = 20;

export function emptyState(): AppState {
  return {
    recentProjects: [],
    lastOpenedProject: null,
    versionPendingInstall: null,
    attemptedInstall: null,
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

export function setLastUsedProjectParent(state: AppState, parent: string): AppState {
  return { ...state, lastUsedProjectParent: parent };
}

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
        err: (err as Error).message,
        statePath,
      });
      try {
        fs.unlinkSync(tmpPath);
      } catch {
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
        entry.gitRemoteUrl = item.gitRemoteUrl;
      }
      recentProjects.push(entry);
    }
  }
  const lastOpenedProject =
    typeof obj.lastOpenedProject === 'string' ? obj.lastOpenedProject : null;
  const versionPendingInstall =
    typeof obj.versionPendingInstall === 'string' ? obj.versionPendingInstall : null;
  const attemptedInstall = typeof obj.attemptedInstall === 'string' ? obj.attemptedInstall : null;
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
  const lastUsedProjectParent =
    typeof obj.lastUsedProjectParent === 'string' && obj.lastUsedProjectParent.length > 0
      ? obj.lastUsedProjectParent
      : null;
  const pendingWindowRestore = Array.isArray(obj.pendingWindowRestore)
    ? sanitizeStringArray(obj.pendingWindowRestore)
    : null;
  const spellCheckEnabled =
    typeof obj.spellCheckEnabled === 'boolean' ? obj.spellCheckEnabled : true;
  return {
    recentProjects,
    lastOpenedProject,
    versionPendingInstall,
    attemptedInstall,
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
