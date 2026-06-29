
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  promises as fsPromises,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { homedir as osHomedir, hostname as osHostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  ALL_EDITOR_IDS,
  addOkPathsToGitExclude,
  classifyExistingMcpEntry,
  detectInstalledEditors,
  EDITOR_TARGETS,
  getOkArtifactPaths,
  isOwnManagedEntry,
  type McpInstallOptions,
  type ProjectAiIntegrationsResult,
  previewContent,
  readExistingMcpEntry,
  runStop,
  type TrackedRefusal,
  validateLocalFolderForShare,
  writeEditorMcpConfig,
  writeProjectAiIntegrations,
  writeUserMcpConfigs,
} from '@inkeep/open-knowledge';
import {
  CLIENT_VERSION_HEADER,
  PROTOCOL_VERSION,
  SPAWN_ERROR_LOG,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import {
  assertGitAvailable,
  BUNDLE_SKILL_NAME,
  classifyFsPath,
  createEphemeralProjectDir,
  ensureProjectGit,
  findEnclosingGitRoot,
  findEnclosingProjectRoot,
  getLocalDir,
  getMeter,
  initContent,
  isProcessAlive,
  normalizeFsPath,
  prepareSingleFileOpen,
  RUNTIME_VERSION,
  readServerLock,
  readServerPackageVersion,
  recordSkillInstallEvent,
  resolveBundledSkillDir,
  resolveLockDir,
  USER_GLOBAL_BUNDLE_IDS,
  withSpan,
  writeTargetVersion,
} from '@inkeep/open-knowledge-server';
import type { BrowserWindowConstructorOptions } from 'electron';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  autoUpdater as electronAutoUpdater,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  utilityProcess,
} from 'electron';
import type { ClaudeReadiness, CliReadiness, OkMenuAction } from '../shared/bridge-contract.ts';
import { type EntryPoint, isEntryPoint } from '../shared/entry-point.ts';
import type {
  EditorActiveTargetSnapshot,
  EditorViewMenuStateSnapshot,
  McpWiringEditorId,
  OnboardingShowPayload,
  RecentProject,
} from '../shared/ipc-channels.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { registerPendingDelivery, sendToRenderer } from '../shared/ipc-send.ts';
import { resolveShell } from '../utility/pty-host.ts';
import { buildAboutPanelOptions } from './about-panel.ts';
import { appendOkIgnoreSync } from './append-okignore.ts';
import { openAssetSafely, revealAssetSafely } from './asset-allowlist.ts';
import { popAssetMenu } from './asset-menu.ts';
import { attachAssetSafetyNet } from './asset-safety-net.ts';
import {
  bootAutoUpdater,
  channelFromVersion,
  type StartAutoUpdaterHandle,
} from './auto-updater.ts';
import { bootRestoreDecision } from './boot-restore-decision.ts';
import { runBootstrap } from './bootstrap.ts';
import {
  type BranchInfoProxyDeps,
  proxyAwaitBranchSwitched,
  proxyFetchBranchInfo,
  proxyRunCheckout,
} from './branch-info-proxy.ts';
import { wrapperPathInBundle } from './bundle-paths.ts';
import {
  type BundleReplaceWatcherHandle,
  startBundleReplaceWatcher,
} from './bundle-replace-detector.ts';
import { cascadePosition } from './cascade-position.ts';
import { checkTargetExists as checkTargetExistsImpl } from './check-target-exists.ts';
import {
  cliProbeArgs,
  resolveClaudeReadiness,
  resolveCliOnPath,
  runLoginShellProbe,
} from './claude-readiness.ts';
import { requestUserConsent, walkExceedsCap } from './consent-dialog.ts';
import {
  CreateNewProjectError,
  folderState,
  resolveDefaultProjectsRoot,
  runCreateNew,
} from './create-new-project.ts';
import { createDebugIpc, type DebugIpcHandle } from './debug-ipc.ts';
import { flushDesktopLogger, getLogger, getRootDesktopLogger } from './desktop-logger.ts';
import { promptForExistingFolder } from './dialog-helpers.ts';
import {
  type DriverUtilityLike,
  isDriverBootSmokeMode,
  runDriverBootSmoke,
} from './driver-boot-smoke.ts';
import { EMBED_HOST_PATTERNS, rewriteEmbedRequestHeaders } from './embed-referer.ts';
import { discoverProject, validateFolderPick } from './folder-admission.ts';
import { ensureGitAvailable } from './git-preflight-handler.ts';
import { readCanonicalGitHubRemoteUrl } from './git-remote.ts';
import { formatInstanceAppName, resolveInstanceLabel } from './instance-identity.ts';
import { deriveInstanceUserDataDir } from './instance-isolation.ts';
import { handleBuildAndOpen, handleDetectClaudeDesktop } from './ipc/install-skill.ts';
import {
  createLocalOpState,
  handleAuthCancel,
  handleAuthRepos,
  handleAuthStart,
  handleAuthStatus,
  handleCloneCancel,
  handleCloneStart,
  type LocalOpDeps,
} from './ipc/local-op.ts';
import { handleSeedApply, handleSeedListPacks, handleSeedPlan } from './ipc/seed.ts';
import { handleSharingSetMode, handleSharingStatus } from './ipc/sharing.ts';
import {
  detectProtocol as detectProtocolImpl,
  recordHandoff as recordHandoffImpl,
  showItemInFolder as showItemInFolderImpl,
  spawnCursor as spawnCursorImpl,
  trashItem as trashItemImpl,
} from './ipc-handlers.ts';
import { logIpcError } from './ipc-log.ts';
import { createDesktopKeepaliveFactory } from './keepalive.ts';
import { checkAndRepairLaunchJsonOnProjectOpen } from './launch-json-wiring.ts';
import {
  checkAndRepairMcpWiringOnStartup,
  type McpStartupRepairResult,
  type McpWiringCliSurface,
  type McpWiringDispatchTarget,
  type RunMcpWiringHandle,
  runMcpWiringOnFirstLaunch,
} from './mcp-wiring.ts';
import { installApplicationMenu } from './menu.ts';
import { createNavigatorWindow, tryCloseNavigator } from './navigator-window.ts';
import { runOkInit } from './ok-init.ts';
import {
  type OnboardingFlowKind,
  recordCreateNewBannerShown,
  recordFirstRunShareHandoff,
  recordOnboardingFlow,
} from './onboarding-telemetry.ts';
import { computePathLeg, type EnsureCliOnPathResult, ensureCliOnPath } from './path-install.ts';
import { installStdioBrokenPipeGuard } from './process-safety-net.ts';
import {
  checkAndRepairProjectMcpOnProjectOpen,
  type ProjectMcpReclaimCliSurface,
} from './project-mcp-reclaim.ts';
import { readHeadBranch as readHeadBranchImpl } from './read-head-branch.ts';
import {
  applyReducedTransparency,
  type BrowserWindowVibrancyTarget,
  type ReducedTransparencyDeps,
  type VibrancyMaterial,
} from './reduced-transparency-handler.ts';
import { removeGitFolder } from './remove-git-folder.ts';
import { attachRendererConsoleCapture } from './renderer-console-capture.ts';
import { resolveDetachedSpawnArgs } from './resolve-detached-spawn-args.ts';
import { resolveShareTarget as resolveShareTargetMain } from './resolve-share-target.ts';
import { startFirstRunHandshake } from './share-handoff.ts';
import { handleShellOpenExternal } from './shell-allowlist.ts';
import { createShowGateRegistry, type ShowGateRegistry } from './show-gate.ts';
import { reclaimProjectSkillsOnProjectOpen, reclaimUserSkillsOnLaunch } from './skill-reclaim.ts';
import { attachSpellcheckContextMenu } from './spellcheck-context-menu.ts';
import { popSpellcheckMenu } from './spellcheck-menu.ts';
import {
  type AppState,
  addRecentProject,
  annotateMissing,
  emptyState,
  evaluateSchemaCompatibility,
  getProjectSessionState,
  MAX_SUPPORTED_SCHEMA_VERSION,
  parseAppState,
  removeRecentProject,
  type SchemaIncompatibilityDiagnostic,
  saveAppStateToDir,
  setLastUsedProjectParent,
  setProjectSessionState,
  setSpellCheckEnabled as setSpellCheckEnabledState,
  type UpdateChannel,
} from './state-store.ts';
import { isTerminalConsented, isTerminalConsentedWithGrace } from './terminal-consent.ts';
import { type TerminalReaper, wireWindowTerminalReap } from './terminal-lifecycle.ts';
import {
  clampPtyDimension,
  createTerminalManager,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  type PtyUtilityLike,
} from './terminal-manager.ts';
import {
  recordConcurrentSessions,
  recordShellExit,
  recordTerminalSession,
} from './terminal-telemetry.ts';
import { applyThemeApplied } from './theme-applied-handler.ts';
import { applyThemeSource, isOkThemeSource } from './theme-handler.ts';
import {
  applyResetIncompatible,
  applyStateQuery,
  type UpdateStateHandlerDeps,
} from './update-state-handlers.ts';
import {
  registerProtocolHandler,
  type ScreenTarget,
  type ShareDeepLinkBranchSwitchPayload,
  type ShareNavigatorPayload,
} from './url-scheme.ts';
import { migrateLegacyUserDataDir } from './userdata-migration.ts';
import { buildUtilityForkEnv } from './utility-fork-env.ts';
import { mergeViewMenuState } from './view-menu-state.ts';
import {
  type BrowserWindowLike,
  setWindowInstanceLabel,
  type UtilityProcessLike,
  WindowManager,
} from './window-manager.ts';
import { WINDOW_MIN_SIZE } from './window-min-size.ts';

const VIBRANCY_DEFAULT: VibrancyMaterial = 'sidebar';

const DEFAULT_WIN_OPTS: BrowserWindowConstructorOptions = {
  width: 1280,
  height: 800,
  minWidth: WINDOW_MIN_SIZE.NAVIGATOR.width,
  minHeight: WINDOW_MIN_SIZE.NAVIGATOR.height,
  show: false,
  ...(process.platform === 'darwin'
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 22, y: 24 },
        vibrancy: VIBRANCY_DEFAULT,
        visualEffectState: 'followWindow',
        transparent: true,
      }
    : {}),
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
};

const cascadeOrder: BrowserWindow[] = [];

function pickCascadeAnchor(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (
    focused &&
    cascadeOrder.includes(focused) &&
    !focused.isDestroyed() &&
    !focused.isFullScreen()
  ) {
    return focused;
  }
  for (let i = cascadeOrder.length - 1; i >= 0; i--) {
    const win = cascadeOrder[i];
    if (win && !win.isDestroyed() && !win.isFullScreen()) return win;
  }
  return null;
}

function applyCascadePosition(win: BrowserWindow): void {
  const anchor = pickCascadeAnchor();
  if (anchor) {
    const anchorBounds = anchor.getBounds();
    const { width, height } = win.getBounds();
    const pos = cascadePosition({
      anchor: { x: anchorBounds.x, y: anchorBounds.y },
      size: { width, height },
      workArea: screen.getDisplayMatching(anchorBounds).workArea,
    });
    if (pos) win.setPosition(pos.x, pos.y);
  }
  cascadeOrder.push(win);
  win.on('closed', () => {
    const idx = cascadeOrder.indexOf(win);
    if (idx !== -1) cascadeOrder.splice(idx, 1);
  });
}

function probeWsUpgrade(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
      }
      resolveProbe(ok);
    };
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => settle(true));
    ws.addEventListener('close', () => settle(false));
    ws.addEventListener('error', () => settle(false));
    setTimeout(() => settle(false), timeoutMs);
  });
}

function quarantineCorruptState(statePath: string, reason: string, err?: unknown): void {
  console.warn('[main] state.json corrupt — quarantining and starting fresh', {
    reason,
    ...(err ? { err: (err as Error).message } : {}),
    statePath,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    const corruptPath = `${statePath}.corrupt-${stamp}`;
    const buf = readFileSync(statePath);
    writeFileSync(corruptPath, buf);
    console.warn('[main] corrupt state.json backed up', { corruptPath });
  } catch (backupErr) {
    console.warn('[main] corrupt state.json backup failed', {
      err: (backupErr as Error).message,
    });
  }
}

function loadAppState(): AppState {
  const statePath = join(app.getPath('userData'), 'state.json');
  if (!existsSync(statePath)) return emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch (err) {
    quarantineCorruptState(statePath, 'unparseable-json', err);
    return emptyState();
  }
  const parsed = parseAppState(raw);
  if (!parsed) {
    quarantineCorruptState(statePath, 'schema-invalid');
    return emptyState();
  }
  return parsed;
}

function saveAppState(state: AppState): boolean {
  return saveAppStateToDir(app.getPath('userData'), state);
}

let appState: AppState = emptyState();
let pendingSchemaIncompatibility: SchemaIncompatibilityDiagnostic | null = null;
export function getPendingSchemaIncompatibility(): SchemaIncompatibilityDiagnostic | null {
  return pendingSchemaIncompatibility;
}
export function clearPendingSchemaIncompatibility(): void {
  pendingSchemaIncompatibility = null;
}

function setSpellCheckEnabledAppWide(enabled: boolean): void {
  session.defaultSession.setSpellCheckerEnabled(enabled);
  appState = setSpellCheckEnabledState(appState, enabled);
  saveAppState(appState);
  refreshApplicationMenu();
}

function attachSpellcheckMenuToWindow(win: BrowserWindow): void {
  session.defaultSession.setSpellCheckerEnabled(appState.spellCheckEnabled);
  const openExternalSafely = handleShellOpenExternal({
    openExternal: (url) => shell.openExternal(url),
  });
  attachSpellcheckContextMenu(win.webContents, {
    isSpellCheckEnabled: () => appState.spellCheckEnabled,
    setSpellCheckEnabled: setSpellCheckEnabledAppWide,
    addToDictionary: (word) => {
      session.defaultSession.addWordToSpellCheckerDictionary(word);
    },
    openExternal: (url) => {
      void openExternalSafely(url).catch((err: unknown) => {
        getLogger('spellcheck-menu').warn(
          { err: err instanceof Error ? err.message : String(err), url },
          'context-menu search openExternal failed',
        );
      });
    },
    popMenu: (input) => {
      popSpellcheckMenu({ Menu, window: win }, input);
    },
  });
}
let navigatorWindow: BrowserWindowLike | null = null;
let wm: WindowManager;
let terminalReaper: TerminalReaper | null = null;
const showGate: ShowGateRegistry = createShowGateRegistry({
  log: {
    warn: (obj, msg) => {
      console.warn(JSON.stringify({ ...obj, msg }));
    },
  },
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

const reducedTransparencyDeps: ReducedTransparencyDeps = {
  getAllWindows: () =>
    BrowserWindow.getAllWindows() as unknown as readonly BrowserWindowVibrancyTarget[],
  defaultVibrancy: VIBRANCY_DEFAULT,
  warn: (line) => {
    console.warn(line);
  },
};
let autoUpdaterHandle: StartAutoUpdaterHandle | null = null;
let bundleReplaceWatcherHandle: BundleReplaceWatcherHandle | null = null;
let debugIpc: DebugIpcHandle | null = null;
let mcpWiringHandle: RunMcpWiringHandle | null = null;

let editorActiveTarget: EditorActiveTargetSnapshot = { kind: null };

let editorViewMenuState: EditorViewMenuStateSnapshot = {
  showHiddenFiles: false,
  canExpandAll: true,
  canCollapseAll: true,
  sidebarVisible: true,
  docPanelVisible: true,
  terminalVisible: false,
  terminalLive: false,
};

const rendererDevUrl = process.env.ELECTRON_RENDERER_URL ?? null;

function isDebugKeyringSmokeAllowed(): boolean {
  return !app.isPackaged || process.env.OK_DEBUG_KEYRING_SMOKE === '1';
}

function resolveLocalOpCliArgs(): string[] {
  if (app.isPackaged) {
    return [wrapperPathInBundle(app.getPath('exe'))];
  }
  return ['open-knowledge'];
}

function runDriverBootSmokeInProduction(): void {
  runDriverBootSmoke({
    fork: (entry) => utilityProcess.fork(entry, [], {}) as unknown as DriverUtilityLike,
    quit: () => {
      try {
        app.quit();
      } catch {
      }
    },
    setTimeout: (fn, ms) => {
      setTimeout(fn, ms);
    },
    utilityEntryPath: join(__dirname, 'utility/server-entry.js'),
  });
}

function withDebugFlagIfAllowed(args: readonly string[]): string[] {
  const withDebug = isDebugKeyringSmokeAllowed()
    ? [...args, '--ok-debug-keyring-smoke=1']
    : [...args];
  return process.env.OK_DESKTOP_E2E_SMOKE === '1' ? [...withDebug, '--ok-e2e-smoke=1'] : withDebug;
}

function ensureDebugIpc(): DebugIpcHandle {
  if (debugIpc) return debugIpc;
  debugIpc = createDebugIpc({
    resolveUtility: (sender) => {
      const win = BrowserWindow.fromWebContents(sender as Electron.WebContents);
      if (!win || !wm) return null;
      const ctx = wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike);
      return ctx?.utility ?? null;
    },
    isDebugAllowed: isDebugKeyringSmokeAllowed,
  });
  return debugIpc;
}

function ensureWindowManager() {
  if (wm) return;
  const rendererEntryPath = app.isPackaged
    ? join(process.resourcesPath, 'app', 'index.html')
    : join(__dirname, '../renderer/index.html');
  const utilityEntryPath = join(__dirname, 'utility/server-entry.js');

  const bundleCliMjsPath = app.isPackaged
    ? join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@inkeep',
        'open-knowledge',
        'dist',
        'cli.mjs',
      )
    : null;

  wm = new WindowManager({
    createWindow: (opts) => {
      const win = new BrowserWindow({
        ...DEFAULT_WIN_OPTS,
        minWidth: WINDOW_MIN_SIZE.EDITOR.width,
        minHeight: WINDOW_MIN_SIZE.EDITOR.height,
        title: opts.title,
        webPreferences: {
          ...DEFAULT_WIN_OPTS.webPreferences,
          additionalArguments: withDebugFlagIfAllowed(opts.additionalArguments),
          preload: join(__dirname, '../preload/index.js'),
        },
      });
      win.on('page-title-updated', (e) => {
        e.preventDefault();
      });
      applyCascadePosition(win);
      attachSpellcheckMenuToWindow(win);
      if (terminalReaper) wireWindowTerminalReap(win, terminalReaper);
      return win as unknown as BrowserWindowLike;
    },
    forkUtility: (entry, args, opts) => {
      const child = utilityProcess.fork(entry, args, {
        ...opts,
        env: buildUtilityForkEnv(process.env),
      } as unknown as Parameters<typeof utilityProcess.fork>[2]);
      return child as unknown as UtilityProcessLike;
    },
    utilityEntryPath,
    ...(bundleCliMjsPath !== null
      ? {
          spawnDetachedServer: async ({
            contentDir,
            reactShellDistDir,
            singleFile,
            projectDir,
          }) => {
            const projectRoot = projectDir ?? contentDir;
            const lockDir = getLocalDir(projectRoot);
            if (!existsSync(lockDir)) {
              try {
                mkdirSync(lockDir, { recursive: true });
              } catch (err) {
                throw Object.assign(
                  new Error(
                    `spawnDetachedServer: failed to create lock dir at ${lockDir}: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  ),
                  {
                    kind: 'spawn-error' as const,
                    code: (err as NodeJS.ErrnoException).code,
                    cause: err,
                  },
                );
              }
            }
            const spawnErrorLogPath = join(lockDir, SPAWN_ERROR_LOG);
            let spawnErrorLogFd: number;
            try {
              spawnErrorLogFd = openSync(spawnErrorLogPath, 'w');
            } catch (err) {
              throw Object.assign(
                new Error(
                  `spawnDetachedServer: failed to open spawn-error log fd at ${spawnErrorLogPath}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
                {
                  kind: 'spawn-error' as const,
                  code: (err as NodeJS.ErrnoException).code,
                  cause: err,
                },
              );
            }
            const spawnArgs = resolveDetachedSpawnArgs({
              platform: process.platform,
              isPackaged: app.isPackaged,
              parentExecPath: process.execPath,
              bundleCliMjsPath,
              reactShellDistDir,
              contentDir,
              spawnErrorLogFd,
              env: buildUtilityForkEnv(process.env),
              ...(singleFile !== undefined ? { singleFile, projectDir } : {}),
            });
            let childRef: ReturnType<typeof spawn>;
            try {
              childRef = spawn(spawnArgs.file, spawnArgs.args, spawnArgs.opts);
            } catch (spawnErr) {
              try {
                closeSync(spawnErrorLogFd);
              } catch {
              }
              throw Object.assign(
                new Error(
                  `spawnDetachedServer: child_process.spawn threw synchronously: ${
                    spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
                  }`,
                ),
                {
                  kind: 'spawn-error' as const,
                  code: (spawnErr as NodeJS.ErrnoException).code,
                  cause: spawnErr,
                },
              );
            }
            try {
              await new Promise<void>((resolveSpawn, rejectSpawn) => {
                const onSpawn = (): void => {
                  childRef.removeListener('error', onError);
                  resolveSpawn();
                };
                const onError = (err: Error): void => {
                  childRef.removeListener('spawn', onSpawn);
                  rejectSpawn(
                    Object.assign(
                      new Error(
                        `spawnDetachedServer: child_process.spawn emitted 'error': ${err.message}`,
                      ),
                      {
                        kind: 'spawn-error' as const,
                        code: (err as NodeJS.ErrnoException).code,
                        cause: err,
                      },
                    ),
                  );
                };
                childRef.once('spawn', onSpawn);
                childRef.once('error', onError);
              });
            } finally {
              try {
                closeSync(spawnErrorLogFd);
              } catch {
              }
            }
            childRef.unref();
            const pid = childRef.pid;
            if (pid === undefined) {
              throw new Error(
                'spawnDetachedServer: child_process.spawn did not return a pid after spawn-event resolution.',
              );
            }
            return { pid };
          },
        }
      : {}),
    createEphemeralProjectDir,
    removeDir: (dir: string) => fsPromises.rm(dir, { recursive: true, force: true }),
    rendererEntryPath,
    rendererDevUrl,
    appVersion: app.getVersion(),
    selfProtocolVersion: PROTOCOL_VERSION,
    selfRuntimeVersion: RUNTIME_VERSION,
    reclaimForeignServerInDev: !app.isPackaged,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    killProbe: (pid, signal) => {
      process.kill(pid, signal as NodeJS.Signals | 0);
    },
    readServerLock: (lockDir) => readServerLock(lockDir),
    isProcessAlive: (pid) => isProcessAlive(pid),
    hostname: () => osHostname(),
    probeWsUpgrade: (url, timeoutMs) => probeWsUpgrade(url, timeoutMs),
    realpathSync: (p) => realpathSync(p),
    onUtilityMessage: (msg) => {
      ensureDebugIpc().handleUtilityMessage(msg);
    },
    onUtilityExit: (utility) => {
      ensureDebugIpc().cancelPendingForUtility(utility);
    },
    createKeepalive: createDesktopKeepaliveFactory({
      readServerLock: (lockDir) => readServerLock(lockDir),
    }),
    showGate,
  });
}

function openNavigator(pendingPayload?: ShareNavigatorPayload) {
  if (navigatorWindow) {
    getLogger('navigator').debug({}, 'already open, focusing');
    (navigatorWindow as unknown as { focus: () => void }).focus();
    if (pendingPayload) {
      const wc = (navigatorWindow as unknown as { webContents: Electron.WebContents }).webContents;
      if (wc.isLoading()) {
        registerPendingDelivery(wc, 'ok:share:received', pendingPayload, {
          event: 'did-finish-load',
        });
      } else {
        sendToRenderer(wc, 'ok:share:received', pendingPayload);
      }
    }
    return;
  }
  getLogger('navigator').info({}, 'opening window');
  navigatorWindow = createNavigatorWindow({
    createWindow: (opts) => {
      const win = new BrowserWindow({
        ...DEFAULT_WIN_OPTS,
        width: 840,
        height: 600,
        webPreferences: {
          ...DEFAULT_WIN_OPTS.webPreferences,
          additionalArguments: withDebugFlagIfAllowed(opts.additionalArguments),
          preload: join(__dirname, '../preload/index.js'),
        },
      });
      win.on('closed', () => {
        navigatorWindow = null;
      });
      attachSpellcheckMenuToWindow(win);
      return win as unknown as BrowserWindowLike;
    },
    rendererEntryPath: app.isPackaged
      ? join(process.resourcesPath, 'app', 'index.html')
      : join(__dirname, '../renderer/index.html'),
    rendererDevUrl,
    appVersion: app.getVersion(),
    showGate,
    pendingPayload,
  });
}

function logAiIntegrationOutcomes(result: ProjectAiIntegrationsResult): number {
  const interesting = result.integrations.filter(
    (o) =>
      o.action !== 'written' && o.action !== 'overwritten' && o.action !== 'skipped-unsupported',
  );
  if (interesting.length === 0) return 0;
  console.warn(
    JSON.stringify({
      event: 'ai-integration-outcomes',
      outcomes: interesting.map((o) => ({
        editorId: o.editorId,
        integration: o.integration,
        action: o.action,
        ...(o.error !== undefined ? { error: o.error } : {}),
      })),
    }),
  );
  return interesting.filter((o) => o.action === 'failed').length;
}

const BOOT_BUDGET_FILE_CAP = 10_000;

async function openProject(
  projectPath: string,
  entryPoint: EntryPoint,
  pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string },
  pendingBranch?: string | null,
  pendingMultiCandidate?: boolean,
  pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload,
  pendingTargetMissing?: boolean,
) {
  getLogger('project').info(
    {
      projectName: basename(projectPath),
      entryPoint,
      hasDeepLinkTarget: !!pendingDeepLinkTarget,
      hasPendingBranch: !!pendingBranch,
    },
    'opening project',
  );
  ensureWindowManager();

  const validation = validateFolderPick(projectPath);
  const discovery = await discoverProject(projectPath, {
    dirSizeProbe: async (dir) => {
      try {
        const exceedsCap = await walkExceedsCap(dir, BOOT_BUDGET_FILE_CAP);
        return { exceedsCap };
      } catch (err) {
        console.warn('[openProject] dirSizeProbe failed, failsafe to exceedsCap:true', err);
        return { exceedsCap: true };
      }
    },
  });

  if (discovery.kind === 'rejected') {
    dialog.showErrorBox(
      'Cannot open this folder',
      `${projectPath}\n\nReason: ${discovery.reason === 'symlink-escape' ? 'Symlink resolves outside its parent directory.' : 'Folder is unreadable or does not exist.'}`,
    );
    openNavigator();
    return;
  }

  const warningsCount = validation.warnings.length;
  const resolvedProjectDir = discovery.projectDir;
  void checkAndRepairLaunchJsonOnProjectOpen({
    projectDir: resolvedProjectDir,
    executablePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
    platform: process.platform,
    forceEnv: process.env.OK_M6B_FORCE ?? null,
    reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
  }).catch((err) => {
    console.warn('[main] launch.json reclaim failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  });
  void checkAndRepairProjectMcpOnProjectOpen({
    projectDir: resolvedProjectDir,
    executablePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
    platform: process.platform,
    cli: createProjectMcpReclaimCliSurface(),
    forceEnv: process.env.OK_M6B_FORCE ?? null,
    reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
  }).catch((err) => {
    console.warn('[main] project-mcp reclaim failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  });
  let didEnsureGit = false;
  let flowKind: OnboardingFlowKind;
  let contentDirChanged = false;
  let aiIntegrationsFailedCount = 0;
  let toastPayload:
    | { kind: 'ancestor-promote'; ancestorPath: string }
    | { kind: 'git-root-promote'; gitRoot: string; pickedPath: string }
    | { kind: 'sharing-refused-tracked'; tracked: string[]; remediation: string }
    | { kind: 'sharing-no-git'; requestedMode: 'local-only' }
    | null = null;

  if (discovery.kind === 'managed-requires-confirmation') {
    const ancestorName = basename(discovery.projectDir);
    const pickedName = basename(discovery.pickedPath);
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Cancel', `Open ${ancestorName}`],
      cancelId: 0,
      defaultId: 0,
      title: 'Open existing project?',
      message: `OpenKnowledge wants to open the existing project at ${discovery.projectDir} (because it contains an .ok/ config). The folder you picked, ${pickedName}, is inside that project. Open ${ancestorName}?`,
    });
    if (response === 0) {
      recordOnboardingFlow({
        flowKind: 'managed-promote-cancelled',
        entryPoint,
        gitInitRequested: false,
        contentDirChanged: false,
        warningsCount,
      });
      openNavigator();
      return;
    }
    flowKind = 'managed-promote';
    if (entryPoint !== 'recents' && entryPoint !== 'create-new-nested-redirect') {
      toastPayload = { kind: 'ancestor-promote', ancestorPath: discovery.projectDir };
    }
  } else if (discovery.kind === 'managed') {
    flowKind = discovery.ancestorPromoted ? 'managed-promote' : 'managed-direct';
    if (
      discovery.ancestorPromoted &&
      entryPoint !== 'recents' &&
      entryPoint !== 'create-new-nested-redirect'
    ) {
      toastPayload = { kind: 'ancestor-promote', ancestorPath: discovery.projectDir };
    }
  } else {
    let navigator = navigatorWindow;
    if (!navigator) {
      openNavigator();
      navigator = navigatorWindow;
      if (!navigator) {
        dialog.showErrorBox(
          'Cannot open this folder',
          `${projectPath}\n\nFailed to open the Project Navigator.`,
        );
        return;
      }
      const navigatorWebContents = (navigator as unknown as { webContents: Electron.WebContents })
        .webContents;
      if (navigatorWebContents.isLoading()) {
        await new Promise<void>((resolve, reject) => {
          const onLoad = () => {
            navigatorWebContents.removeListener('destroyed', onDestroyed);
            resolve();
          };
          const onDestroyed = () => {
            navigatorWebContents.removeListener('did-finish-load', onLoad);
            reject(new Error('Navigator destroyed during load'));
          };
          navigatorWebContents.once('did-finish-load', onLoad);
          navigatorWebContents.once('destroyed', onDestroyed);
        });
      }
    }
    const showPayload: OnboardingShowPayload = {
      pickedPath: discovery.pickedPath,
      projectDir: discovery.projectDir,
      defaultContentDir: discovery.defaultContentDir,
      gitState: discovery.gitState,
      gitRootPromoted: discovery.gitRootPromoted,
      warnings: validation.warnings.map((w) => ({ kind: w.kind })),
      editorOptions: ALL_EDITOR_IDS.map((id) => ({
        id: id as McpWiringEditorId,
        label: EDITOR_TARGETS[id].label,
        hasProjectConfig: EDITOR_TARGETS[id].projectConfigPath !== undefined,
      })),
    };
    const decision = await requestUserConsent(
      {
        ipcMain,
        navigator: (navigator as unknown as { webContents: Electron.WebContents }).webContents,
        previewContent,
      },
      showPayload,
    );
    if (decision.outcome === 'cancel') {
      recordOnboardingFlow({
        flowKind: 'cancel',
        entryPoint,
        gitInitRequested: false,
        contentDirChanged: false,
        warningsCount,
      });
      return;
    }
    const { request } = decision;
    contentDirChanged = request.contentDir !== discovery.defaultContentDir;
    flowKind =
      contentDirChanged ||
      request.additionalIgnores.trim().length > 0 ||
      request.editorIds.length !== ALL_EDITOR_IDS.length
        ? 'fresh-customized'
        : 'fresh-default';
    if (
      request.initGit &&
      (discovery.gitState === 'absent' || discovery.gitState === 'shell-only')
    ) {
      await ensureProjectGit(discovery.projectDir);
      didEnsureGit = true;
    }
    await initContent(discovery.projectDir, {
      contentDir: request.contentDir !== '.' ? request.contentDir : undefined,
    });
    if (request.additionalIgnores.trim().length > 0) {
      appendOkIgnoreSync(discovery.projectDir, request.additionalIgnores);
    }
    aiIntegrationsFailedCount = logAiIntegrationOutcomes(
      writeProjectAiIntegrations(discovery.projectDir, [...request.editorIds]),
    );
    if (request.sharing === 'local-only') {
      const paths = getOkArtifactPaths(discovery.projectDir);
      const result = addOkPathsToGitExclude(discovery.projectDir, paths);
      if (result.kind === 'refused-tracked') {
        const refusal: TrackedRefusal = result;
        toastPayload = {
          kind: 'sharing-refused-tracked',
          tracked: [...refusal.tracked],
          remediation: refusal.remediation,
        };
      } else if (result.kind === 'no-exclude' && result.reason === 'no-git') {
        toastPayload = {
          kind: 'sharing-no-git',
          requestedMode: 'local-only',
        };
      }
    }
    if (discovery.gitRootPromoted && toastPayload === null) {
      toastPayload = {
        kind: 'git-root-promote',
        gitRoot: discovery.projectDir,
        pickedPath: discovery.pickedPath,
      };
    }
  }

  if (discovery.kind === 'managed' || discovery.kind === 'managed-requires-confirmation') {
    void reclaimProjectSkillsOnProjectOpen({
      projectDir: resolvedProjectDir,
      executablePath: app.getPath('exe'),
      isPackaged: app.isPackaged,
      platform: process.platform,
      forceEnv: process.env.OK_M6B_FORCE ?? null,
      reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
      createIfWired: true,
      deps: {
        resolveBundledSkillDir: () => resolveBundledSkillDir('project', { checkDesktop: false }),
      },
    }).catch((err) => {
      console.warn('[main] project-skill reclaim failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  recordOnboardingFlow({
    flowKind,
    entryPoint,
    gitInitRequested: didEnsureGit,
    contentDirChanged,
    warningsCount,
    failedCount: aiIntegrationsFailedCount,
  });

  const ctx = await wm.createProjectWindow({
    projectPath: resolvedProjectDir,
    pendingDeepLinkTarget,
    pendingBranch,
    pendingMultiCandidate,
    pendingTargetMissing,
    pendingShareBranchSwitch,
    didEnsureGit,
    consentVersion: 1,
    localOpCliArgs: resolveLocalOpCliArgs(),
  });
  getLogger('project').info(
    {
      projectName: basename(resolvedProjectDir),
      apiOrigin: ctx.apiOrigin,
      flowKind,
      didEnsureGit,
      warningsCount,
    },
    'project window created',
  );
  attachAssetSafetyNet(ctx.window.webContents, {
    editorOrigin: ctx.apiOrigin,
    openAsset: (relPath) =>
      openAssetSafely(
        {
          projectPath: ctx.projectPath,
          platform: process.platform,
          openPath: (canonical) => shell.openPath(canonical),
        },
        relPath,
      ),
    openExternal: handleShellOpenExternal({
      openExternal: (url) => shell.openExternal(url),
    }),
  });
  if (toastPayload !== null) {
    const payload = toastPayload;
    ctx.window.webContents.once('did-finish-load', () => {
      sendToRenderer(ctx.window.webContents, 'ok:onboarding:toast', payload);
    });
  }

  tryCloseNavigator(navigatorWindow, { projectPath });
  const gitRemoteUrl = readCanonicalGitHubRemoteUrl(resolvedProjectDir) ?? undefined;
  appState = addRecentProject(appState, resolvedProjectDir, ctx.projectName, gitRemoteUrl);
  saveAppState(appState);
  refreshApplicationMenu();
}

async function openProjectOrFallbackToNavigator(
  projectPath: string,
  entryPoint: EntryPoint,
  pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string },
  pendingBranch?: string | null,
  pendingMultiCandidate?: boolean,
  pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload,
  pendingTargetMissing?: boolean,
) {
  try {
    await openProject(
      projectPath,
      entryPoint,
      pendingDeepLinkTarget,
      pendingBranch,
      pendingMultiCandidate,
      pendingShareBranchSwitch,
      pendingTargetMissing,
    );
  } catch (err) {
    const errorMessage = (err as Error).message;
    const kind = (err as Error & { kind?: string }).kind;
    const holderPid = (err as Error & { holderPid?: number }).holderPid;
    console.error('[main] openProject failed, falling back to Navigator', {
      projectPath,
      kind,
      err: errorMessage,
    });
    let dialogTitle = 'Unable to open project';
    let dialogBody = `${projectPath}\n\n${errorMessage}`;
    if (kind === 'mcp-server-stuck') {
      dialogTitle = "Couldn't reclaim project lock";
      dialogBody =
        `${projectPath}\n\n` +
        `Another process${typeof holderPid === 'number' ? ` (pid ${holderPid})` : ''} ` +
        `is holding the server lock and didn't release it after a SIGTERM. ` +
        `Quit it manually and try again, or restart OpenKnowledge.`;
    } else if (kind === 'lock-collision') {
      dialogTitle = 'OpenKnowledge is already running for this project';
      dialogBody = `${projectPath}\n\n${errorMessage}`;
    }
    dialog.showErrorBox(dialogTitle, dialogBody);
    openNavigator();
  }
}

async function openEphemeralFile(filePath: string): Promise<void> {
  ensureWindowManager();

  let plan: ReturnType<typeof prepareSingleFileOpen>;
  try {
    plan = prepareSingleFileOpen(filePath);
  } catch (err) {
    dialog.showErrorBox(
      'Cannot open this file',
      `${filePath}\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (plan.mode === 'project') {
    await openProjectOrFallbackToNavigator(plan.projectRoot, 'deep-link', {
      kind: 'doc',
      path: plan.docName,
    });
    return;
  }

  try {
    const ctx = await wm.createEphemeralWindow({
      canonicalFilePath: plan.canonicalFilePath,
      contentDir: plan.contentDir,
      docName: plan.docName,
    });
    getLogger('project').info(
      { file: plan.canonicalFilePath, apiOrigin: ctx.apiOrigin },
      'ephemeral single-file window created',
    );
    attachAssetSafetyNet(ctx.window.webContents, {
      editorOrigin: ctx.apiOrigin,
      openAsset: (relPath) =>
        openAssetSafely(
          {
            projectPath: ctx.projectPath,
            platform: process.platform,
            openPath: (canonical) => shell.openPath(canonical),
          },
          relPath,
        ),
      openExternal: handleShellOpenExternal({
        openExternal: (url) => shell.openExternal(url),
      }),
    });
    tryCloseNavigator(navigatorWindow, { projectPath: plan.contentDir });
    refreshApplicationMenu();
  } catch (err) {
    getLogger('project').error(
      { file: plan.canonicalFilePath, err: err instanceof Error ? err.message : String(err) },
      'ephemeral single-file open failed',
    );
    dialog.showErrorBox(
      'Could not open file',
      `${filePath}\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    if (BrowserWindow.getAllWindows().length === 0) {
      openNavigator();
    }
  }
}

let refreshInFlight: Promise<void> | null = null;
let pendingRefresh = false;

function refreshApplicationMenu(): void {
  if (refreshInFlight !== null) {
    pendingRefresh = true;
    return;
  }
  refreshInFlight = runApplicationMenuRefresh()
    .catch((err) => {
      console.error('[main] refreshApplicationMenu failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      refreshInFlight = null;
      if (pendingRefresh) {
        pendingRefresh = false;
        refreshApplicationMenu();
      }
    });
}

async function runApplicationMenuRefresh(): Promise<void> {
  await installApplicationMenu({
    appName: app.name,
    showDevToolsMenu: !app.isPackaged || channelFromVersion(app.getVersion()) === 'beta',
    dialog,
    openNavigator,
    openProject: (path, entryPoint) => openProjectOrFallbackToNavigator(path, entryPoint),
    getRecentProjects: () => appState.recentProjects,
    clearRecentProjects: () => {
      appState = { ...appState, recentProjects: [] };
      saveAppState(appState);
      refreshApplicationMenu();
    },
    openExternalUrl: (url: string) => {
      void shell.openExternal(url);
    },
    reconfigureMcpWiring:
      process.platform === 'darwin' && app.isPackaged
        ? async () => {
            mcpWiringHandle?.destroy();
            mcpWiringHandle = null;
            try {
              mcpWiringHandle = armMcpWiring({
                forceShow: true,
                immediateDispatchTarget: pickLoadedRendererForMcpDialog(),
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error('[main] reconfigureMcpWiring failed', { err: message });
              dialog.showErrorBox(
                'Configure AI Tool Integrations failed',
                `OpenKnowledge couldn't re-arm the MCP consent dialog:\n\n${message}`,
              );
            }
          }
        : undefined,
    openInstallSkillDialog: () => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!target) return;
      target.webContents.executeJavaScript(
        "window.location.hash = '#install-claude-desktop'; undefined",
      );
    },
    openSettings: () => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!target) return;
      target.webContents.executeJavaScript("window.location.hash = '#settings'; undefined");
    },
    onCheckForUpdates: autoUpdaterHandle
      ? () => {
          void autoUpdaterHandle?.checkForUpdatesNow().catch((err) => {
            console.warn('[main] checkForUpdatesNow rejected', {
              message: err instanceof Error ? err.message : String(err),
            });
          });
        }
      : undefined,
    activeTarget: editorActiveTarget,
    onNewFile: () => sendMenuActionToFocused('new-doc'),
    onNewFolder: () => sendMenuActionToFocused('new-folder'),
    onNewFromTemplate: () => sendMenuActionToFocused('new-from-template'),
    onNewProject: () => sendMenuActionToFocused('new-project'),
    onRename: () => sendMenuActionToFocused('rename'),
    onDuplicate: () => sendMenuActionToFocused('duplicate'),
    onMoveToTrash: () => sendMenuActionToFocused('move-to-trash'),
    onCloseActiveTabOrWindow: () => sendMenuActionToFocused('close-active-tab-or-window'),
    onRevealInFinder: () => sendMenuActionToFocused('reveal-in-finder'),
    onSendToAi: () => sendMenuActionToFocused('send-to-ai'),
    onCopyFullPath: () => sendMenuActionToFocused('copy-full-path'),
    onCopyRelativePath: () => sendMenuActionToFocused('copy-relative-path'),
    showHiddenFilesChecked: editorViewMenuState.showHiddenFiles,
    canExpandAll: editorViewMenuState.canExpandAll,
    canCollapseAll: editorViewMenuState.canCollapseAll,
    sidebarVisible: editorViewMenuState.sidebarVisible,
    docPanelVisible: editorViewMenuState.docPanelVisible,
    terminalVisible: editorViewMenuState.terminalVisible,
    terminalLive: editorViewMenuState.terminalLive,
    onToggleShowHiddenFiles: () => sendMenuActionToFocused('toggle-show-hidden-files'),
    onToggleSidebar: () => sendMenuActionToFocused('toggle-sidebar'),
    onToggleDocPanel: () => sendMenuActionToFocused('toggle-doc-panel'),
    onToggleTerminal: () => sendMenuActionToFocused('toggle-terminal'),
    onNewTerminal: () => sendMenuActionToFocused('new-terminal'),
    onKillTerminal: () => sendMenuActionToFocused('kill-terminal'),
    onExpandAll: () => sendMenuActionToFocused('expand-all-tree'),
    onCollapseAll: () => sendMenuActionToFocused('collapse-all-tree'),
    spellCheckEnabled: appState.spellCheckEnabled,
    onToggleSpellCheck: () => setSpellCheckEnabledAppWide(!appState.spellCheckEnabled),
  });
}


function sendMenuActionToFocused(action: OkMenuAction): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!target) return;
  sendToRenderer(target.webContents, 'ok:menu-action', action);
}

function createMcpWiringCliSurface(): McpWiringCliSurface {
  return {
    detectInstalledEditors: (cwd, home) => detectInstalledEditors(cwd, home),
    writeUserMcpConfigs: (writeOpts) => writeUserMcpConfigs(writeOpts),
    readExistingMcpEntry: (editorId, home) =>
      readExistingMcpEntry(EDITOR_TARGETS[editorId], '', home),
    classifyExistingMcpEntry: (editorId, home) =>
      classifyExistingMcpEntry(EDITOR_TARGETS[editorId], '', home),
    allEditorIds: ALL_EDITOR_IDS,
    editorTargets: EDITOR_TARGETS,
  };
}

function createProjectMcpReclaimCliSurface(): ProjectMcpReclaimCliSurface {
  return {
    editorTargets: EDITOR_TARGETS,
    allEditorIds: ALL_EDITOR_IDS,
    classifyExistingProjectMcpConfig: (editorId, projectDir, projectPath) =>
      classifyExistingMcpEntry(EDITOR_TARGETS[editorId], projectDir, undefined, projectPath),
    writeProjectMcpConfig: ({ editorId, projectDir, projectPath }) => {
      const installOpts: McpInstallOptions = {
        mode: 'published',
        skipAvailabilityCheck: true,
      };
      const result = writeEditorMcpConfig(
        EDITOR_TARGETS[editorId],
        projectDir,
        installOpts,
        undefined,
        projectPath,
      );
      if (result.action === 'failed') {
        return { action: 'failed', error: result.error };
      }
      return { action: 'overwritten' };
    },
  };
}

interface ArmMcpWiringOpts {
  forceShow?: boolean;
  immediateDispatchTarget?: McpWiringDispatchTarget;
}

function createMcpWiringOpts(opts: ArmMcpWiringOpts = {}) {
  return {
    isPackaged: app.isPackaged,
    executablePath: app.getPath('exe'),
    home: osHomedir(),
    platform: process.platform,
    ipcMain,
    cli: createMcpWiringCliSurface(),
    forceEnv: process.env.OK_M6B_FORCE ?? null,
    reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
    forceShow: opts.forceShow ?? false,
    immediateDispatchTarget: opts.immediateDispatchTarget,
  };
}

function armMcpWiring(opts: ArmMcpWiringOpts = {}): RunMcpWiringHandle {
  return runMcpWiringOnFirstLaunch(createMcpWiringOpts(opts));
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function probeLoginShellOnPath(args?: readonly string[]): Promise<number | null> {
  return runLoginShellProbe(
    (file, spawnArgs) => {
      const child = spawn(file, [...spawnArgs], { stdio: 'ignore', shell: false });
      return {
        onExit: (cb) => {
          child.on('exit', (code) => cb(code));
        },
        onError: (cb) => {
          child.on('error', (err) => cb(err));
        },
        kill: () => {
          child.kill('SIGKILL');
        },
      };
    },
    resolveShell(process.env),
    {
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
    },
    undefined,
    args,
  );
}

function isProjectClaudeMcpOwn(projectRoot: string | undefined): boolean {
  if (projectRoot === undefined) return false;
  const target = EDITOR_TARGETS.claude;
  const projectPath = target.projectConfigPath?.(projectRoot);
  if (projectPath === undefined) return false;
  const classified = classifyExistingMcpEntry(target, projectRoot, undefined, projectPath);
  return classified.kind === 'present' && isOwnManagedEntry(classified.entry);
}

function resolveTerminalClaudeReadiness(projectRoot: string | undefined): Promise<ClaudeReadiness> {
  return resolveClaudeReadiness({
    probeClaude: () => probeLoginShellOnPath(),
    classifyMcpEntry: () =>
      createMcpWiringCliSurface().classifyExistingMcpEntry('claude', osHomedir()).kind,
    isProjectMcpPreApprovable: () => isProjectClaudeMcpOwn(projectRoot),
  });
}

function resolveTerminalCliOnPath(cli: TerminalCli): Promise<CliReadiness> {
  return resolveCliOnPath({
    probe: () => probeLoginShellOnPath(cliProbeArgs(TERMINAL_CLIS[cli].bin)),
  });
}

function pickLoadedRendererForMcpDialog(): McpWiringDispatchTarget | undefined {
  const isUsable = (win: BrowserWindow): boolean =>
    !win.isDestroyed() && !win.webContents.isLoading();
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && isUsable(focused)) return focused.webContents;
  return BrowserWindow.getAllWindows().find(isUsable)?.webContents;
}

function dispatchStartupReclaimToastWhenReady(results: {
  mcp: McpStartupRepairResult;
  path: EnsureCliOnPathResult;
}): void {
  const { mcp, path } = results;
  const pathLeg = computePathLeg(path);
  if (mcp.status === 'failed') {
    dispatchToastWhenReady({
      kind: 'startup-reclaim',
      mcp: { status: 'failed', editors: mcp.failedEditors.map((f) => f.editor) },
      path: pathLeg,
    });
    return;
  }
  const hasMcp = mcp.status === 'repaired';
  if (!hasMcp && pathLeg.status === 'none') return;
  dispatchToastWhenReady({
    kind: 'startup-reclaim',
    mcp: hasMcp ? { status: 'repaired', editors: mcp.repairedEditors } : { status: 'none' },
    path: pathLeg,
  });
}

function dispatchToastWhenReady(payload: {
  readonly kind: 'startup-reclaim';
  readonly mcp:
    | { readonly status: 'none' }
    | { readonly status: 'repaired'; readonly editors: readonly string[] }
    | { readonly status: 'failed'; readonly editors: readonly string[] };
  readonly path:
    | { readonly status: 'none' }
    | { readonly status: 'installed'; readonly summary: string }
    | { readonly status: 'failed'; readonly summary: string };
}): void {
  let dispatched = false;
  const send = (win: Electron.BrowserWindow): void => {
    if (dispatched || win.isDestroyed()) return;
    try {
      sendToRenderer(win.webContents, 'ok:onboarding:toast', payload);
      dispatched = true;
    } catch (err) {
      console.warn('[main] startup reclaim toast send failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const tryDispatch = (win: Electron.BrowserWindow): void => {
    if (dispatched || win.isDestroyed()) return;
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => send(win));
      return;
    }
    send(win);
  };
  for (const win of BrowserWindow.getAllWindows()) {
    tryDispatch(win);
    if (dispatched) return;
  }
  const onCreated = (_event: Electron.Event, win: Electron.BrowserWindow) => {
    win.webContents.once('did-finish-load', () => {
      send(win);
      if (dispatched) app.off('browser-window-created', onCreated);
    });
  };
  app.on('browser-window-created', onCreated);
  setTimeout(() => {
    app.off('browser-window-created', onCreated);
  }, 60_000);
}

const RECENT_GIT_ROOTS_CAP = 256;

function registerIpcHandlers() {
  const handle = createHandler(ipcMain);

  const recentGitRoots = new Set<string>();
  const recordRecentGitRoot = (gitRoot: string): void => {
    if (recentGitRoots.has(gitRoot)) {
      recentGitRoots.delete(gitRoot);
    }
    recentGitRoots.add(gitRoot);
    while (recentGitRoots.size > RECENT_GIT_ROOTS_CAP) {
      const oldest = recentGitRoots.values().next().value;
      if (oldest === undefined) break;
      recentGitRoots.delete(oldest);
    }
  };

  const terminalManager = createTerminalManager({
    forkPtyHost: () =>
      utilityProcess.fork(join(__dirname, 'utility/pty-host.js')) as unknown as PtyUtilityLike,
    sendData: (wc, payload) => sendToRenderer(wc, 'ok:pty:data', payload),
    sendExit: (wc, payload) => sendToRenderer(wc, 'ok:pty:exit', payload),
    newPtyId: () => randomUUID(),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
    logger: { warn: (data) => getLogger('terminal').warn(data, 'unexpected pty-host message') },
    recordShellExit,
    recordTerminalSession,
    recordConcurrentSessions,
  });
  terminalReaper = terminalManager;

  handle('ok:pty:create', async (event, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const ctx =
      win && wm ? wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike) : null;
    const projectPath = ctx?.projectPath ?? null;
    if (!win || !wm || !projectPath) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:pty:create',
        reason: 'no-project',
        handler: 'createPty',
      });
      return { ok: false, reason: 'no-project' };
    }
    if (!isTerminalConsented(projectPath) && !(await isTerminalConsentedWithGrace(projectPath))) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:pty:create',
        reason: 'not-consented',
        handler: 'createPty',
      });
      return { ok: false, reason: 'not-consented' };
    }
    return terminalManager.create({
      windowId: win.id,
      webContents: win.webContents,
      projectRoot: projectPath,
      cols: clampPtyDimension(opts.cols, DEFAULT_PTY_COLS),
      rows: clampPtyDimension(opts.rows, DEFAULT_PTY_ROWS),
    });
  });
  handle('ok:pty:input', async (event, req) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) terminalManager.input({ windowId: win.id, ptyId: req.ptyId, data: req.data });
    return undefined;
  });
  handle('ok:pty:resize', async (event, req) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      terminalManager.resize({
        windowId: win.id,
        ptyId: req.ptyId,
        cols: clampPtyDimension(req.cols, DEFAULT_PTY_COLS),
        rows: clampPtyDimension(req.rows, DEFAULT_PTY_ROWS),
      });
    }
    return undefined;
  });
  handle('ok:pty:kill', async (event, req) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) terminalManager.kill({ windowId: win.id, ptyId: req.ptyId });
    return undefined;
  });
  handle('ok:pty:drain', async (event, req) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) terminalManager.drain({ windowId: win.id, ptyId: req.ptyId, bytes: req.bytes });
    return undefined;
  });
  handle('ok:terminal:claude-assist', async (event, req) => {
    let rewireError: string | undefined;
    if (req.action === 'rewire' && process.platform === 'darwin' && app.isPackaged) {
      const win = BrowserWindow.fromWebContents(event.sender);
      mcpWiringHandle?.destroy();
      mcpWiringHandle = null;
      try {
        mcpWiringHandle = armMcpWiring({
          forceShow: true,
          immediateDispatchTarget: win?.webContents,
        });
      } catch (err) {
        rewireError = formatUnknownError(err);
        getLogger('terminal').warn({ err: rewireError }, 'claude mcp rewire failed');
      }
    }
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    const projectRoot =
      callerWin && wm
        ? wm.getContextForBrowserWindow(callerWin as unknown as BrowserWindowLike)?.projectPath
        : undefined;
    const readiness = await resolveTerminalClaudeReadiness(projectRoot);
    return rewireError === undefined ? readiness : { ...readiness, rewireError };
  });

  handle('ok:terminal:cli-preflight', async (_event, req): Promise<CliReadiness> => {
    if (!(req.cli in TERMINAL_CLIS)) {
      getLogger('terminal').warn({ cli: req.cli }, 'cli-preflight: unknown cli discriminant');
      return { onPath: 'unknown' };
    }
    return resolveTerminalCliOnPath(req.cli);
  });

  handle('ok:dialog:open-folder', async (_event, opts) => {
    return promptForExistingFolder(dialog, opts);
  });

  const shellOpenExternal = handleShellOpenExternal({
    openExternal: (url) => shell.openExternal(url),
  });
  handle('ok:shell:open-external', async (_event, url) => {
    await shellOpenExternal(url);
    return undefined;
  });

  handle('ok:shell:detect-protocol', async (_event, scheme) => {
    return detectProtocolImpl(
      {
        platform: process.platform,
        getApplicationInfoForProtocol: (url) => app.getApplicationInfoForProtocol(url),
      },
      scheme,
    );
  });

  handle('ok:shell:spawn-cursor', async (event, path) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    const callerProjectPath =
      callerWin && wm
        ? wm.getContextForBrowserWindow(callerWin as unknown as BrowserWindowLike)?.projectPath
        : undefined;
    const outcome = await spawnCursorImpl(
      {
        platform: process.platform,
        projectPath: callerProjectPath,
        getApplicationInfoForProtocol: (url) => app.getApplicationInfoForProtocol(url),
        spawn: (exec, args, timeoutMs) =>
          new Promise((resolve) => {
            try {
              const child = spawn(exec, [...args], {
                shell: false,
                timeout: timeoutMs,
                stdio: ['ignore', 'ignore', 'pipe'],
              });
              child.stderr?.on('data', () => {});
              child.once('spawn', () => resolve({ ok: true }));
              child.once('error', () => resolve({ ok: false, reason: 'spawn-error' }));
            } catch {
              resolve({ ok: false, reason: 'spawn-error' });
            }
          }),
      },
      path,
    );
    if (!outcome.ok) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:shell:spawn-cursor',
        reason: outcome.reason,
        handler: 'spawnCursor',
      });
    }
    return outcome;
  });

  handle('ok:shell:record-handoff', async (_event, line) => {
    await recordHandoffImpl(
      {
        homedir: osHomedir,
        appendFile: (path, content) => fsPromises.appendFile(path, content, 'utf-8'),
        mkdir: (path) => fsPromises.mkdir(path, { recursive: true }).then(() => undefined),
      },
      line,
    );
    return undefined;
  });

  handle('ok:shell:open-asset', async (event, relPath) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    const callerProjectPath =
      callerWin && wm
        ? wm.getContextForBrowserWindow(callerWin as unknown as BrowserWindowLike)?.projectPath
        : undefined;
    if (!callerProjectPath) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:shell:open-asset',
        reason: 'path-escape',
        handler: 'openAsset',
      });
      return { ok: false, reason: 'path-escape' } as const;
    }
    const outcome = await openAssetSafely(
      {
        projectPath: callerProjectPath,
        platform: process.platform,
        openPath: (canonical) => shell.openPath(canonical),
      },
      relPath,
    );
    if (!outcome.ok) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:shell:open-asset',
        reason: outcome.reason,
        handler: 'openAsset',
      });
    }
    return outcome;
  });

  handle('ok:shell:reveal-asset', async (event, relPath) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    const callerProjectPath =
      callerWin && wm
        ? wm.getContextForBrowserWindow(callerWin as unknown as BrowserWindowLike)?.projectPath
        : undefined;
    if (!callerProjectPath) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:shell:reveal-asset',
        reason: 'path-escape',
        handler: 'revealAsset',
      });
      return { ok: false, reason: 'path-escape' } as const;
    }
    const outcome = await revealAssetSafely(
      {
        projectPath: callerProjectPath,
        platform: process.platform,
        showItemInFolder: (canonical) => shell.showItemInFolder(canonical),
      },
      relPath,
    );
    if (!outcome.ok) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:shell:reveal-asset',
        reason: outcome.reason,
        handler: 'revealAsset',
      });
    }
    return outcome;
  });

  handle('ok:shell:show-asset-menu', async (event, params) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    if (!callerWin || !wm) return undefined;
    const projectPath = wm.getContextForBrowserWindow(
      callerWin as unknown as BrowserWindowLike,
    )?.projectPath;
    if (!projectPath) return undefined;
    popAssetMenu(
      {
        Menu,
        window: callerWin,
      },
      {
        kind: params.kind,
        platform: process.platform,
        actions: {
          reveal: async () => {
            await revealAssetSafely(
              {
                projectPath,
                platform: process.platform,
                showItemInFolder: (canonical) => shell.showItemInFolder(canonical),
              },
              params.relPath,
            );
          },
          openInDefault: async () => {
            await openAssetSafely(
              {
                projectPath,
                platform: process.platform,
                openPath: (canonical) => shell.openPath(canonical),
              },
              params.relPath,
            );
          },
          copyLink: () => {
            clipboard.writeText(params.relPath);
          },
        },
      },
    );
    return undefined;
  });

  handle('ok:shell:show-item-in-folder', async (event, path) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    const callerProjectPath =
      callerWin && wm
        ? wm.getContextForBrowserWindow(callerWin as unknown as BrowserWindowLike)?.projectPath
        : undefined;
    const result = showItemInFolderImpl(
      {
        platform: process.platform,
        projectPath: callerProjectPath,
        showItemInFolder: (p) => shell.showItemInFolder(p),
      },
      path,
    );
    if (!result.ok) {
      console.warn('[main] show-item-in-folder refused', { reason: result.reason });
    }
    return undefined;
  });

  handle('ok:shell:trash-item', async (event, absPath) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    const callerProjectPath =
      callerWin && wm
        ? wm.getContextForBrowserWindow(callerWin as unknown as BrowserWindowLike)?.projectPath
        : undefined;
    const start = performance.now();
    const result = await withSpan(
      'ok.shell.trash_item',
      {
        attributes: {
          'ok.shell.path': normalizeFsPath(absPath),
          'ok.shell.path.role': classifyFsPath(absPath),
        },
      },
      async (span) => {
        const outcome = await trashItemImpl(
          {
            platform: process.platform,
            projectPath: callerProjectPath,
            realpath: (p) => realpathSync(p),
            trashItem: (p) => shell.trashItem(p),
          },
          absPath,
        );
        span.setAttribute('ok.shell.outcome', outcome.ok ? 'ok' : 'failure');
        if (!outcome.ok) {
          span.setAttribute('ok.shell.reason', outcome.reason);
        }
        return outcome;
      },
    );
    const elapsedMs = performance.now() - start;
    _trashItemDurationHist().record(elapsedMs, {
      'ok.shell.outcome': result.ok ? 'ok' : 'failure',
    });
    if (!result.ok) {
      _trashItemFailureCounter().add(1, { 'ok.shell.reason': result.reason });
      console.warn('[main] trash-item refused', {
        reason: result.reason,
        detail: result.detail,
      });
    }
    return result;
  });

  handle('ok:editor:active-target-changed', async (_event, target) => {
    editorActiveTarget = target;
    refreshApplicationMenu();
    return undefined;
  });

  handle('ok:editor:view-menu-state-changed', async (_event, state) => {
    editorViewMenuState = mergeViewMenuState(editorViewMenuState, state);
    refreshApplicationMenu();
    return undefined;
  });

  handle('ok:clipboard:write-text', async (_event, text) => {
    clipboard.writeText(text);
    return undefined;
  });

  handle('ok:theme:set-source', async (_event, { source }) => {
    return applyThemeSource(
      {
        getThemeSource: () =>
          isOkThemeSource(nativeTheme.themeSource) ? nativeTheme.themeSource : 'system',
        setThemeSource: (s) => {
          nativeTheme.themeSource = s;
        },
        warn: (line) => console.warn(line),
      },
      source,
    );
  });

  handle('ok:theme:applied', async (event, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    applyThemeApplied(
      {
        fireThemeApplied: (w) => showGate.fireThemeApplied(w as BrowserWindowLike),
        applyReducedTransparency: (reduced) =>
          applyReducedTransparency(reducedTransparencyDeps, reduced),
        warn: (line) => console.warn(line),
      },
      win as unknown as object | null,
      opts,
    );
    return undefined;
  });

  handle('ok:project:get-info', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('webContents has no parent BrowserWindow');
    const ctx = wm?.getContextForBrowserWindow(win as unknown as BrowserWindowLike);
    if (!ctx) throw new Error('No project context for this window');
    return {
      collabUrl: `ws://localhost:${ctx.port}/collab`,
      apiOrigin: ctx.apiOrigin,
      projectPath: ctx.projectPath,
      projectName: ctx.projectName,
      mode: 'editor' as const,
      e2eSmoke: process.env.OK_DESKTOP_E2E_SMOKE === '1',
      singleFile: ctx.ephemeral !== undefined,
      initialDoc: null,
    };
  });

  handle('ok:sharing:dispatch', async (event, request) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('webContents has no parent BrowserWindow');
    const ctx = wm?.getContextForBrowserWindow(win as unknown as BrowserWindowLike);
    if (!ctx) throw new Error('No project context for this window');
    if (request.kind === 'status') {
      return handleSharingStatus(ctx.projectPath);
    }
    const mode: 'shared' | 'local-only' = request.mode === 'local-only' ? 'local-only' : 'shared';
    return handleSharingSetMode(ctx.projectPath, mode);
  });

  handle('ok:project:list-recent', async () => {
    return annotateMissing(appState) as RecentProject[];
  });

  handle('ok:project:remove-recent', async (_event, projectPath) => {
    if (typeof projectPath !== 'string' || projectPath.length === 0) {
      throw new Error('ok:project:remove-recent rejected: invalid projectPath');
    }
    appState = removeRecentProject(appState, projectPath);
    saveAppState(appState);
    refreshApplicationMenu();
    return undefined;
  });

  handle('ok:project:get-session-state', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !wm)
      return {
        openTabs: [],
        pinnedTabIds: [],
        activeDocName: null,
        activeTabId: null,
        updatedAt: null,
      };
    const ctx = wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike);
    if (!ctx)
      return {
        openTabs: [],
        pinnedTabIds: [],
        activeDocName: null,
        activeTabId: null,
        updatedAt: null,
      };
    return getProjectSessionState(appState, ctx.projectPath);
  });

  handle('ok:project:set-session-state', async (event, state) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !wm) return undefined;
    const ctx = wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike);
    if (!ctx) return undefined;
    appState = setProjectSessionState(appState, ctx.projectPath, state);
    saveAppState(appState);
    return undefined;
  });

  handle('ok:project:open', async (_event, request) => {
    if (!isEntryPoint(request.entryPoint)) {
      throw new Error(
        `ok:project:open rejected: invalid entryPoint '${String(request.entryPoint)}'`,
      );
    }
    if (request.pendingDeepLinkTarget !== undefined && wm) {
      const existing = wm.focusWindowForProject(request.path) as
        | (BrowserWindowLike & { webContents: BrowserWindowLike['webContents'] })
        | null;
      if (existing) {
        sendToRenderer(existing.webContents, 'ok:deep-link', {
          doc: request.pendingDeepLinkTarget.path,
          kind: request.pendingDeepLinkTarget.kind,
          branch: request.pendingBranch ?? null,
          multiCandidate: request.pendingMultiCandidate === true,
        });
        return undefined;
      }
    }
    if (request.pendingShareBranchSwitch !== undefined && wm) {
      const existing = wm.focusWindowForProject(request.path) as
        | (BrowserWindowLike & { webContents: BrowserWindowLike['webContents'] })
        | null;
      if (existing) {
        sendToRenderer(existing.webContents, 'ok:share:received', {
          kind: 'project-branch-switch' as const,
          share: request.pendingShareBranchSwitch.share,
          projectPath: request.pendingShareBranchSwitch.projectPath,
          currentBranch: request.pendingShareBranchSwitch.currentBranch,
        });
        return undefined;
      }
    }
    await openProjectOrFallbackToNavigator(
      request.path,
      request.entryPoint,
      request.pendingDeepLinkTarget,
      request.pendingBranch,
      request.pendingMultiCandidate,
      request.pendingShareBranchSwitch,
    );
    return undefined;
  });

  handle('ok:share:validate-folder', async (_event, request) => {
    return validateLocalFolderForShare(request.folderPath, {
      owner: request.owner,
      repo: request.repo,
    });
  });

  handle('ok:project:check-target-exists', async (_event, request) => {
    return checkTargetExistsImpl(request.projectPath, request.kind, request.path);
  });

  handle('ok:project:read-head-branch', async (_event, projectPath) => {
    return readHeadBranchImpl(projectPath);
  });

  const branchInfoProxyDeps: BranchInfoProxyDeps = {
    readServerLock: (lockDir) => readServerLock(lockDir),
    isProcessAlive,
    fetch: globalThis.fetch,
    log: {
      warn: (message, meta) => console.warn(message, meta ?? {}),
    },
  };

  handle('ok:project:fetch-branch-info', async (_event, request) => {
    return proxyFetchBranchInfo(request, branchInfoProxyDeps);
  });

  handle('ok:project:run-checkout', async (_event, request) => {
    return proxyRunCheckout(request, branchInfoProxyDeps);
  });

  handle('ok:project:await-branch-switched', async (_event, request) => {
    return proxyAwaitBranchSwitched(request, branchInfoProxyDeps);
  });

  handle('ok:project:ok-init', async (_event, request) => {
    return runOkInit(request.projectPath);
  });

  handle('ok:project:close', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !wm) return undefined;
    const ctx = wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike);
    if (ctx) {
      wm.closeProjectWindow(ctx.projectPath);
    }
    return undefined;
  });

  handle('ok:project:restart-server', async (_event, projectPath) => {
    if (!wm) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:project:restart-server',
        reason: 'no-window-manager',
        handler: 'restartServer',
      });
      return { ok: false, reason: 'other' };
    }
    try {
      const outcome = await wm.restartAttachedServer(projectPath, {
        localOpCliArgs: resolveLocalOpCliArgs(),
      });
      if (outcome.ok === false) {
        logIpcError({
          event: 'ipc.error',
          channel: 'ok:project:restart-server',
          reason: outcome.reason,
          handler: 'restartServer',
        });
      }
      return outcome;
    } catch (err) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:project:restart-server',
        reason: 'other',
        handler: 'restartServer',
        cause: err,
      });
      return { ok: false, reason: 'other' };
    }
  });


  handle('ok:fs:default-projects-root', async () => {
    return resolveDefaultProjectsRoot(appState.lastUsedProjectParent, app.getPath('documents'));
  });

  handle('ok:fs:folder-state', async (_event, path) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('ok:fs:folder-state rejected: path must be a non-empty string');
    }
    return folderState(path);
  });

  handle('ok:fs:find-enclosing-project-root', async (_event, path) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(
        'ok:fs:find-enclosing-project-root rejected: path must be a non-empty string',
      );
    }
    return findEnclosingProjectRoot(path);
  });

  handle('ok:fs:find-enclosing-git-root', async (_event, path) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('ok:fs:find-enclosing-git-root rejected: path must be a non-empty string');
    }
    const result = findEnclosingGitRoot(path);
    if (result !== null) {
      recordRecentGitRoot(result.gitRoot);
    }
    return result;
  });

  handle('ok:fs:remove-git-folder', async (_event, gitRoot) => {
    if (typeof gitRoot === 'string' && recentGitRoots.has(gitRoot)) {
      try {
        const outcome = runStop({
          lockDir: resolveLockDir(gitRoot),
          log: (msg) => getLogger('project').info({ gitRoot }, `[remove-git-folder] ${msg}`),
        });
        getLogger('project').info(
          { gitRoot, stopped: outcome.stopped.length, hadTargets: outcome.hadTargets },
          'remove-git-folder: stopped worktree server before .git removal',
        );
      } catch (err) {
        getLogger('project').warn(
          { gitRoot, err: err instanceof Error ? err.message : String(err) },
          'remove-git-folder: worktree server stop failed',
        );
      }
    }
    await removeGitFolder(gitRoot, { allowedGitRoots: recentGitRoots });
    return undefined;
  });

  handle('ok:project:create-new', async (_event, args) => {
    let result: Awaited<ReturnType<typeof runCreateNew>>;
    try {
      result = await runCreateNew({
        parent: args.parent,
        name: args.name,
        editors: args.editors,
        sharing: args.sharing,
      });
    } catch (err) {
      if (err instanceof CreateNewProjectError) {
        logIpcError({
          event: 'ipc.error',
          channel: 'ok:project:create-new',
          reason: err.reason,
          handler: 'runCreateNew',
          cause: { message: err.message },
        });
      } else {
        logIpcError({
          event: 'ipc.error',
          channel: 'ok:project:create-new',
          reason: 'unexpected',
          handler: 'runCreateNew',
          cause: err,
        });
      }
      throw err;
    }

    const aiFailedCount = logAiIntegrationOutcomes(result.aiIntegrations);

    appState = setLastUsedProjectParent(appState, args.parent);
    saveAppState(appState);

    recordOnboardingFlow({
      flowKind: result.variant,
      entryPoint: 'create-new',
      gitInitRequested: !result.gitRootPromoted,
      contentDirChanged: false,
      warningsCount: 0,
      failedCount: aiFailedCount,
    });

    getLogger('create-new').info(
      {
        projectDir: result.projectDir,
        target: result.target,
        variant: result.variant,
        gitRootPromoted: result.gitRootPromoted,
      },
      'created project',
    );

    await openProjectOrFallbackToNavigator(result.projectDir, 'create-new');
    return undefined;
  });

  handle('ok:project:record-create-new-banner-shown', async (_event, banner) => {
    if (banner !== 'nested' && banner !== 'nonempty' && banner !== 'git-confirm') {
      throw new Error(
        `ok:project:record-create-new-banner-shown rejected: unknown banner ${JSON.stringify(banner)}`,
      );
    }
    recordCreateNewBannerShown(banner);
    return undefined;
  });

  handle('ok:navigator:open', async () => {
    openNavigator();
    return undefined;
  });

  const updateStateDeps = (): UpdateStateHandlerDeps => ({
    getAppState: () => appState,
    setAppState: (s) => {
      appState = s;
    },
    saveAppState,
    getBuildChannel: () => channelFromVersion(app.getVersion()),
    getPendingSchemaIncompatibility,
    clearPendingSchemaIncompatibility,
  });
  handle('ok:state:reset-incompatible', async () => applyResetIncompatible(updateStateDeps()));
  handle('ok:state:query', async () => applyStateQuery(updateStateDeps()));

  handle('ok:debug:keyring-smoke', async (event) => {
    return ensureDebugIpc().requestKeyringSmoke(event.sender);
  });

  const resolveSeedProjectRoot = (event: Electron.IpcMainInvokeEvent): string | undefined => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    return callerWin && wm
      ? wm.getContextForBrowserWindow(callerWin as unknown as BrowserWindowLike)?.projectPath
      : undefined;
  };
  handle('ok:seed:plan', async (event, options) => {
    const result = await handleSeedPlan(
      { resolveProjectRoot: () => resolveSeedProjectRoot(event) },
      options,
    );
    if (!result.ok) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:seed:plan',
        reason: result.error.kind,
        handler: 'handleSeedPlan',
        cause: { message: result.error.message },
      });
    }
    return result;
  });
  handle('ok:seed:apply', async (event, plan, options) => {
    const result = await handleSeedApply(
      { resolveProjectRoot: () => resolveSeedProjectRoot(event) },
      plan,
      options,
    );
    if (!result.ok) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:seed:apply',
        reason: result.error.kind,
        handler: 'handleSeedApply',
        cause: { message: result.error.message },
      });
    }
    return result;
  });
  handle('ok:seed:list-packs', async () => handleSeedListPacks());

  handle('ok:skill:detect-claude-desktop', async () => {
    return handleDetectClaudeDesktop();
  });
  handle('ok:skill:build-and-open', async (_event, opts) => {
    const result = await handleBuildAndOpen({ app, shell, force: opts?.force });
    if (!result.ok) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:skill:build-and-open',
        reason: result.reason,
        handler: 'handleBuildAndOpen',
        cause: result.message !== undefined ? { message: result.message } : undefined,
      });
    }
    return result;
  });

  const localOpDeps: LocalOpDeps = {
    resolveCliArgs: resolveLocalOpCliArgs,
    state: createLocalOpState(),
  };
  handle('ok:local-op:auth:start', async (event) => {
    const result = handleAuthStart(localOpDeps, event.sender);
    if (!result.ok) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:local-op:auth:start',
        reason: result.error,
        handler: 'handleAuthStart',
      });
    }
    return result;
  });
  handle('ok:local-op:auth:cancel', async (_event, streamId) => {
    handleAuthCancel(localOpDeps, streamId);
    return undefined;
  });
  handle('ok:local-op:clone:start', async (event, request) => {
    const result = handleCloneStart(localOpDeps, event.sender, request);
    if (!result.ok) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:local-op:clone:start',
        reason: result.error,
        handler: 'handleCloneStart',
      });
    }
    return result;
  });
  handle('ok:local-op:clone:cancel', async (_event, streamId) => {
    handleCloneCancel(localOpDeps, streamId);
    return undefined;
  });
  handle('ok:local-op:auth:status', async (_event, request) => {
    return handleAuthStatus(localOpDeps, request);
  });
  handle('ok:local-op:auth:repos', async (_event, request) => {
    return handleAuthRepos(localOpDeps, request);
  });
}

const ICON_PNG_PATH = join(__dirname, '..', '..', 'build', 'icon.png');

function installDockIcon() {
  if (process.platform !== 'darwin') return;
  if (app.isPackaged) return; // packaged build uses the bundle's .icns
  if (!existsSync(ICON_PNG_PATH)) {
    console.warn('[main] skipping dock icon — build/icon.png missing');
    return;
  }
  try {
    const image = nativeImage.createFromPath(ICON_PNG_PATH);
    if (!image.isEmpty()) {
      app.dock?.setIcon(image);
    } else {
      console.warn('[main] dock icon image loaded empty; skipping', { ICON_PNG_PATH });
    }
  } catch (err) {
    console.warn('[main] dock icon install failed', { err: (err as Error).message });
  }
}

function installLocalhostCorsInjector() {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://localhost:*/*', 'http://127.0.0.1:*/*'] },
    (details, callback) => {
      const headers: Record<string, string[]> = { ...details.responseHeaders };
      const hasAcao = Object.keys(headers).some(
        (k) => k.toLowerCase() === 'access-control-allow-origin',
      );
      if (hasAcao) {
        callback({});
        return;
      }
      headers['Access-Control-Allow-Origin'] = ['*'];
      headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS'];
      headers['Access-Control-Allow-Headers'] = [
        `Content-Type, Authorization, ${CLIENT_VERSION_HEADER.protocol}, ${CLIENT_VERSION_HEADER.runtime}, ${CLIENT_VERSION_HEADER.kind}`,
      ];
      const isPreflightReject =
        details.method === 'OPTIONS' && details.statusCode >= 400 && details.statusCode < 500;
      if (isPreflightReject) {
        callback({ responseHeaders: headers, statusLine: 'HTTP/1.1 204 No Content' });
        return;
      }
      callback({ responseHeaders: headers });
    },
  );
}

function installEmbedRefererRewriter() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [...EMBED_HOST_PATTERNS] },
    (details, callback) => {
      callback({
        requestHeaders: rewriteEmbedRequestHeaders(details.requestHeaders),
      });
    },
  );
}

const safetyNetLogger = getLogger('process-safety-net');
installStdioBrokenPipeGuard(process, {
  onNonBenignError: (stream, err) => {
    safetyNetLogger.error(
      { stream, code: (err as NodeJS.ErrnoException).code, message: err.message },
      'unexpected stdio stream error',
    );
  },
});


if (!app.isPackaged && process.env.OK_INSTANCE) {
  const relocatedUserData = deriveInstanceUserDataDir(
    app.getPath('userData'),
    process.env.OK_INSTANCE,
  );
  if (relocatedUserData) {
    mkdirSync(relocatedUserData, { recursive: true });
    app.setPath('userData', relocatedUserData);
    getRootDesktopLogger().info(
      {
        event: 'desktop.parallel-instance',
        instance: process.env.OK_INSTANCE,
        userData: relocatedUserData,
      },
      'relocated userData for parallel dev instance',
    );
  }
}

const instanceLabel = resolveInstanceLabel(app.getPath('userData'));
if (instanceLabel) {
  app.setName(formatInstanceAppName(app.getName(), instanceLabel));
  setWindowInstanceLabel(instanceLabel);
}

if (isDriverBootSmokeMode(process.env)) {
  app.whenReady().then(() => {
    runDriverBootSmokeInProduction();
  });
} else {
  const GOT_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
  if (!GOT_SINGLE_INSTANCE_LOCK) {
    app.quit();
  }

  if (GOT_SINGLE_INSTANCE_LOCK) {
    bootPrimaryInstance();
  }
}

function bootPrimaryInstance(): void {
  getRootDesktopLogger().info(
    {
      event: 'desktop.boot',
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      electronVersion: process.versions.electron,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    'desktop main process starting',
  );

  app.on('web-contents-created', (_event, contents) => {
    attachRendererConsoleCapture(contents);
  });

  const protocolControl = registerProtocolHandler({
    app: {
      on: (event, cb) => {
        app.on(event as Parameters<typeof app.on>[0], cb as Parameters<typeof app.on>[1]);
      },
      whenReady: () => app.whenReady(),
      isPackaged: app.isPackaged,
      setAsDefaultProtocolClient: (scheme) => app.setAsDefaultProtocolClient(scheme),
      removeAsDefaultProtocolClient: (scheme) => app.removeAsDefaultProtocolClient(scheme),
    },
    focusWindowForProject: (projectPath) => {
      if (!wm) return null;
      return wm.focusWindowForProject(projectPath) as unknown as object | null;
    },
    openProject: async (projectPath, opts) => {
      await openProjectOrFallbackToNavigator(
        projectPath,
        'deep-link',
        opts?.pendingDeepLinkTarget,
        opts?.pendingBranch,
        opts?.pendingMultiCandidate,
        opts?.pendingShareBranchSwitch,
        opts?.pendingTargetMissing,
      );
      const ctx = wm?.getWindowFor(projectPath);
      if (!ctx) {
        return null;
      }
      return ctx.window as unknown as object;
    },
    openEphemeralFile: (filePath) => openEphemeralFile(filePath),
    sendDeepLink: (win, payload) => {
      const w = win as BrowserWindowLike;
      sendToRenderer(w.webContents, 'ok:deep-link', payload);
    },
    sendShareDeepLink: (win, payload) => {
      const w = win as BrowserWindowLike;
      sendToRenderer(w.webContents, 'ok:share:received', payload);
    },
    resolveShareTarget: (share) =>
      resolveShareTargetMain(share, {
        listRecent: () => annotateMissing(appState),
      }),
    checkShareTargetExists: (projectPath, kind, path) =>
      checkTargetExistsImpl(projectPath, kind, path),
    routeShareToNavigator: (payload) => {
      openNavigator(payload);
    },
    openScreen: (win, screen) => {
      const w = win as BrowserWindowLike;
      const hashByScreen: Record<ScreenTarget, string> = {
        settings: '#settings',
        'install-claude': '#install-claude-desktop',
      };
      w.webContents.executeJavaScript(
        `window.location.hash = '${hashByScreen[screen]}'; undefined`,
      );
    },
    getFocusedWindow: () => {
      const focused = BrowserWindow.getFocusedWindow();
      return focused ? (focused as unknown as object) : null;
    },
    getAnyReadyWindow: () => {
      const first = BrowserWindow.getAllWindows()[0];
      return first ? (first as unknown as object) : null;
    },
    getInitialArgv: () => process.argv,
    log: {
      warn: (obj, msg) => console.warn(msg, obj),
      info: (obj, msg) => console.info(msg, obj),
    },
  });

  app
    .whenReady()
    .then(async () => {
      const userDataMigrationLog = getLogger('userdata-migration');
      const userDataMigration = await migrateLegacyUserDataDir({
        userDataDir: app.getPath('userData'),
        platform: process.platform,
        logger: { event: (payload) => userDataMigrationLog.info(payload, payload.event) },
      });
      if (userDataMigration.status === 'failed') {
        userDataMigrationLog.warn(
          { status: userDataMigration.status, error: userDataMigration.error },
          'userData migration failed; starting as first run',
        );
      }

      app.setAboutPanelOptions(buildAboutPanelOptions(app.getVersion()));

      const isTrueFirstRun = !existsSync(join(app.getPath('userData'), 'state.json'));

      const result = await runBootstrap({
        loadAppState,
        evaluateSchemaCompatibility,
        installLocalhostCorsInjector,
        installEmbedRefererRewriter,
        registerIpcHandlers,
        setNativeThemeSource: (source) => {
          nativeTheme.themeSource = source;
        },
        refreshApplicationMenu,
        installDockIcon,
        log: { warn: (msg, obj) => console.warn(msg, obj) },
        appVersion: app.getVersion(),
        maxSupportedSchemaVersion: MAX_SUPPORTED_SCHEMA_VERSION,
      });
      appState = result.appState;
      pendingSchemaIncompatibility = result.pendingSchemaIncompatibility;

      app.on('browser-window-created', (_event, win) => {
        win.webContents.once('did-finish-load', () => {
          const pending = appState.versionPendingInstall;
          if (pending) {
            sendToRenderer(win.webContents, 'ok:update:downloaded', { version: pending });
          }
          const whatsNew = autoUpdaterHandle?.getActiveWhatsNew();
          if (whatsNew) {
            sendToRenderer(win.webContents, 'ok:update:whats-new', whatsNew);
          }
        });
      });

      mcpWiringHandle = armMcpWiring();
      void Promise.allSettled([
        checkAndRepairMcpWiringOnStartup(createMcpWiringOpts()),
        ensureCliOnPath({
          executablePath: app.getPath('exe'),
          isPackaged: app.isPackaged,
          platform: process.platform,
          forceEnv: process.env.OK_M6B_FORCE ?? null,
          reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
          home: osHomedir(),
          bundleVersion: app.getVersion(),
          logger: {
            event: (payload) => getLogger('path-install').info(payload, payload.event),
          },
        }),
      ])
        .then(([mcpSettled, pathSettled]) => {
          if (mcpSettled.status === 'rejected') {
            console.warn('[main] MCP startup repair threw', {
              error: formatUnknownError(mcpSettled.reason),
            });
          }
          const mcp: McpStartupRepairResult =
            mcpSettled.status === 'fulfilled'
              ? mcpSettled.value
              : { status: 'failed', failedEditors: [] };
          const path: EnsureCliOnPathResult =
            pathSettled.status === 'fulfilled'
              ? pathSettled.value
              : { status: 'failed-all', error: formatUnknownError(pathSettled.reason) };
          dispatchStartupReclaimToastWhenReady({ mcp, path });
        })
        .catch((err) => {
          console.warn('[main] startup reclaim dispatch threw', {
            error: formatUnknownError(err),
          });
        });

      const decision = bootRestoreDecision({
        pendingRestore: appState.pendingWindowRestore,
        lastOpenedProject: appState.lastOpenedProject,
        optionHeld: process.argv.includes('--navigator'),
        pathExists: existsSync,
        urlLaunch: protocolControl.urlLaunchOwnsWindow(),
      });
      if (decision.clearSnapshot) {
        appState = { ...appState, pendingWindowRestore: null };
        if (!saveAppState(appState)) {
          console.warn('[main] failed to persist cleared window-restore snapshot', {
            projectCount: decision.action === 'restore' ? decision.projects.length : 0,
          });
        }
      }

      const skipGitPreflight = decision.action === 'none' && protocolControl.singleFileLaunch();
      if (!skipGitPreflight) {
        const gitOutcome = await ensureGitAvailable({
          assertGitAvailable,
          showMessageBox: async (opts) =>
            dialog.showMessageBox({ ...opts, buttons: [...opts.buttons] }),
          openExternal: (url) => shell.openExternal(url),
          log: { warn: (msg, obj) => console.warn(msg, obj) },
        });
        if (gitOutcome === 'aborted') {
          app.quit();
          return;
        }
      }

      if (decision.action === 'restore') {
        for (const projectPath of decision.projects) {
          void openProjectOrFallbackToNavigator(projectPath, 'recents');
        }
      } else if (decision.action === 'lastOpened') {
        void openProjectOrFallbackToNavigator(decision.project, 'recents');
      } else if (decision.action === 'navigator') {
        openNavigator();
      } else {
        protocolControl.drainQueuedUrls();
      }

      if (isTrueFirstRun && decision.action === 'navigator') {
        startFirstRunHandshake({
          isFirstRun: () => true,
          createServer: (handler) => {
            const httpServer = createHttpServer((req, res) => handler(req, res));
            return {
              listen: (port, host, cb) => {
                httpServer.listen(port, host, cb);
              },
              on: (event, cb) => {
                httpServer.on(event, cb);
              },
              address: () => httpServer.address(),
              close: () => {
                httpServer.close();
              },
            };
          },
          openExternal: (url) => {
            void shell.openExternal(url).catch((err) => {
              console.warn('[main] deferred-share openExternal failed', {
                err: err instanceof Error ? err.message : String(err),
              });
            });
          },
          routeShareUrl: (url) => protocolControl.routeUrl(url),
          recordOutcome: (outcome) => recordFirstRunShareHandoff(outcome),
          log: {
            warn: (obj, msg) => console.warn(msg, obj),
            info: (obj, msg) => console.info(msg, obj),
          },
        });
      }

      void reclaimUserSkillsOnLaunch({
        home: osHomedir(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        executablePath: app.getPath('exe'),
        forceEnv: process.env.OK_M6B_FORCE ?? null,
        reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
        deps: {
          userGlobalBundles: USER_GLOBAL_BUNDLE_IDS.map((id) => ({
            id,
            name: BUNDLE_SKILL_NAME[id],
          })),
          resolveBundledSkillDir: (bundle) =>
            resolveBundledSkillDir(bundle, { checkDesktop: false }),
          readServerPackageVersion,
          writeTargetVersion: (home, target, version, surface) =>
            writeTargetVersion(home, target, version, surface),
          recordSkillInstallEvent: (event) =>
            recordSkillInstallEvent(event as Parameters<typeof recordSkillInstallEvent>[0]),
        },
      }).catch((err) => {
        console.warn('[main] user-skill reclaim failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });

      autoUpdaterHandle = await bootAutoUpdater(() => import('electron-updater'), {
        logger: {
          info: (msg: string, ctx?: object) =>
            getLogger('updater').info((ctx ?? {}) as Record<string, unknown>, msg),
          warn: (msg: string, ctx?: object) =>
            getLogger('updater').warn((ctx ?? {}) as Record<string, unknown>, msg),
          error: (msg: string, ctx?: object) =>
            getLogger('updater').error((ctx ?? {}) as Record<string, unknown>, msg),
          debug: (msg: string, ctx?: object) =>
            getLogger('updater').debug((ctx ?? {}) as Record<string, unknown>, msg),
        },
        ipcMain,
        readState: () => appState,
        writeState: (next) => {
          const prev = appState;
          appState = next;
          const ok = saveAppState(appState);
          if (!ok) {
            appState = prev;
            throw new Error('saveAppState failed — rolled back in-memory state');
          }
        },
        getPrimaryWindow: () => {
          const focused = BrowserWindow.getFocusedWindow();
          if (focused) return focused;
          const all = BrowserWindow.getAllWindows();
          return all[0] ?? null;
        },
        getAllWindows: () => BrowserWindow.getAllWindows(),
        getAppVersion: () => app.getVersion(),
        isPackaged: app.isPackaged,
        forceDevBypass: process.env.OK_UPDATER_FORCE_DEV === '1',
        feedUrl: process.env.OK_UPDATER_FEED_URL || undefined,
        proxyFeed: {
          base: 'https://openknowledge.ai/updates',
          channels: new Set<UpdateChannel>(['beta', 'latest']),
        },
        whenRendererReady: (fn) => {
          const tryFire = (win: BrowserWindow): void => {
            if (win.webContents.isLoading() || win.webContents.getURL() === '') {
              win.webContents.once('did-finish-load', fn);
            } else {
              fn();
            }
          };
          const focused = BrowserWindow.getFocusedWindow();
          const existing = focused ?? BrowserWindow.getAllWindows()[0] ?? null;
          if (existing) {
            tryFire(existing);
            return;
          }
          app.once('browser-window-created', (_event, createdWin) => {
            tryFire(createdWin as BrowserWindow);
          });
        },
        prepareForRelaunch: async () => {
          const openProjects = wm?.getOpenProjectPaths() ?? [];
          appState = { ...appState, pendingWindowRestore: openProjects };
          if (!saveAppState(appState)) {
            console.warn('[main] failed to persist window-restore snapshot before relaunch', {
              projectCount: openProjects.length,
            });
          }
          await wm?.stopAllOwnedServers();
          flushDesktopLogger();
        },
        showCheckNowResult: (result) => {
          const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          if (!target) return;
          if (result.kind === 'not-available') {
            void dialog.showMessageBox(target, {
              type: 'info',
              buttons: ['OK'],
              defaultId: 0,
              title: 'Up to Date',
              message: "You're on the latest version of OpenKnowledge.",
              detail: `OpenKnowledge ${result.currentVersion} is the most current version available.`,
            });
          } else if (result.kind === 'available') {
            void dialog.showMessageBox(target, {
              type: 'info',
              buttons: ['OK'],
              defaultId: 0,
              title: 'Update Available',
              message: `OpenKnowledge ${result.latestVersion} is available.`,
              detail: `It's downloading in the background. You'll be prompted to relaunch when the install is ready.`,
            });
          } else {
            void dialog.showMessageBox(target, {
              type: 'warning',
              buttons: ['OK'],
              defaultId: 0,
              title: "Couldn't Check for Updates",
              message: "OpenKnowledge couldn't check for updates right now.",
              detail: result.message,
            });
          }
        },
      });
      refreshApplicationMenu();

      if (process.platform === 'darwin' && app.isPackaged) {
        const exePath = app.getPath('exe');
        const infoPlistPath = join(dirname(dirname(exePath)), 'Info.plist');
        bundleReplaceWatcherHandle = startBundleReplaceWatcher({
          infoPlistPath,
          getCurrentVersion: () => app.getVersion(),
          dialog,
          app,
        });
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? (err.stack ?? '') : '';
      console.error(JSON.stringify({ event: 'whenReady-unhandled-rejection', message, stack }));
    });

  app.on('before-quit', () => {
    getLogger('lifecycle').info({}, 'before-quit');
    flushDesktopLogger();
  });
  electronAutoUpdater.on('before-quit-for-update', () => {
    getLogger('updater').info({}, 'before-quit-for-update — update install will relaunch the app');
    wm?.signalStopAllOwnedServers();
    flushDesktopLogger();
  });

  app.on('will-quit', () => {
    getLogger('lifecycle').info({}, 'will-quit');
    terminalReaper?.killAll();
    autoUpdaterHandle?.destroy();
    autoUpdaterHandle = null;
    bundleReplaceWatcherHandle?.stop();
    bundleReplaceWatcherHandle = null;
    mcpWiringHandle?.destroy();
    mcpWiringHandle = null;
    flushDesktopLogger();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openNavigator();
    }
  });
} // end bootPrimaryInstance

let _trashItemDurationHistCache: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null =
  null;
function _trashItemDurationHist() {
  _trashItemDurationHistCache ||= getMeter().createHistogram('ok.shell.trash_item.duration_ms', {
    description: 'Duration of ok:shell:trash-item IPC dispatches in milliseconds',
    unit: 'ms',
  });
  return _trashItemDurationHistCache;
}

let _trashItemFailureCounterCache: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function _trashItemFailureCounter() {
  _trashItemFailureCounterCache ||= getMeter().createCounter('ok.shell.trash_item.failures', {
    description: 'Count of ok:shell:trash-item handler failures, labeled by reason',
  });
  return _trashItemFailureCounterCache;
}
