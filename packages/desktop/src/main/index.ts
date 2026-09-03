import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  promises as fsPromises,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { homedir as osHomedir, hostname as osHostname, release as osRelease } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  ALL_EDITOR_IDS,
  addOkPathsToGitExclude,
  classifyExistingMcpEntry,
  defaultBugReportZipPath,
  detectInstalledEditors,
  EDITOR_TARGETS,
  editorConfigPathDisplay,
  editorEntryLocator,
  getOkArtifactPaths,
  isEntryUpToDate,
  isOwnManagedEntry,
  loadConfig,
  type McpInstallOptions,
  okBugReportsDir,
  type ProjectAiIntegrationsResult,
  previewContent,
  readExistingMcpEntry,
  removeOwnMcpEntry,
  removeProjectSkill,
  removeUserGlobalSkillBundle,
  runStop,
  type TrackedRefusal,
  validateLocalFolderForShare,
  writeEditorMcpConfig,
  writeProjectAiIntegrations,
  writeProjectSkill,
  writeUserMcpConfigs,
} from '@inkeep/open-knowledge';
import {
  AGENTS_SKILLS_ROOT,
  CLIENT_VERSION_HEADER,
  estimateSkillCost,
  hasUninstallFeedbackContent,
  type LanguagePreference,
  OPENKNOWLEDGE_SKILLS_REPO,
  PROTOCOL_VERSION,
  projectSkillDecisionKey,
  ServerInfoSuccessSchema,
  SPAWN_ERROR_LOG,
  TERMINAL_CLIS,
  type TerminalCli,
  type UninstallFeedbackAnswers,
  type UninstallIntent,
  type UninstallScreenSpec,
  USER_SKILL_HOSTS,
} from '@inkeep/open-knowledge-core';
import type {
  OkTerminalDockStateWriteResult,
  OkTerminalRestartSnapshot,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import { openSpawnErrorLog } from '@inkeep/open-knowledge-core/server';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import {
  assertGitAvailable,
  BUNDLE_SKILL_NAME,
  classifyFsPath,
  createEphemeralProjectDir,
  discoverLockDirs,
  ensureProjectGit,
  ensureProjectSkillGitignore,
  findEnclosingGitRoot,
  findEnclosingProjectRoot,
  getLocalDir,
  getMeter,
  initContent,
  isProcessAlive,
  normalizeFsPath,
  ONBOARDING_BUNDLE_IDS,
  prepareSingleFileOpen,
  type ResolvedSkillHost,
  RUNTIME_VERSION,
  readBundleDecision,
  readServerLock,
  readServerPackageVersion,
  recordSkillInstallEvent,
  reportSkillInstall,
  resolveBuiltinSkillHosts,
  resolveBundledSkillDir,
  resolveLockDir,
  resolveSkillInstallReportSettings,
  runAuthStatusSubprocess,
  trustSystemCertificates,
  USER_GLOBAL_BUNDLE_IDS,
  untrackTrackedProjectSkillProjection,
  withSpan,
  writeBundleDecision,
  writeTargetVersion,
} from '@inkeep/open-knowledge-server';
import type { BrowserWindowConstructorOptions, MessageBoxOptions, WebContents } from 'electron';
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  autoUpdater as electronAutoUpdater,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  session,
  shell,
  utilityProcess,
} from 'electron';
import type {
  ClaudeReadiness,
  CliReadiness,
  OkChromeColors,
  OkMenuAction,
  OkMenuActionOrigin,
} from '../shared/bridge-contract.ts';
import { type EntryPoint, isEntryPoint } from '../shared/entry-point.ts';
import type {
  EditorActiveTargetSnapshot,
  MenuDispatchCommand,
  MenuDispatchRole,
  OnboardingShowPayload,
  RecentProject,
} from '../shared/ipc-channels.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { registerPendingDelivery, sendToRenderer } from '../shared/ipc-send.ts';
import { UNINSTALL_PRELOAD_ARG } from '../shared/uninstall-preload-arg.ts';
import { getWindowsEnvValue } from '../shared/windows-env.ts';
import { resolveShell } from '../utility/pty-host.ts';
import { buildAboutPanelOptions } from './about-panel.ts';
import {
  accessibilityPostureFacts,
  resolveAccessibilityFeatures,
} from './accessibility-posture.ts';
import { docNameFromActiveTarget, EditorActiveTargetRegistry } from './active-target-registry.ts';
import { appendOkIgnoreSync } from './append-okignore.ts';
import { registerAppImageDeepLinks } from './appimage-integration.ts';
import { openAssetSafely, revealAssetSafely } from './asset-allowlist.ts';
import { popAssetMenu, revealMenuLabel } from './asset-menu.ts';
import { attachAssetSafetyNet } from './asset-safety-net.ts';
import { resolveEffectiveInstanceName } from './auto-instance.ts';
import {
  bootAutoUpdater,
  channelFromVersion,
  installWasInFlightDuring,
  type StartAutoUpdaterHandle,
} from './auto-updater.ts';
import { applyBackgroundThrottle } from './background-throttle.ts';
import {
  describeDesktopLanguage,
  readStoredLanguagePreference,
  resolveDesktopLocale,
  resolveDesktopLocaleForPushed,
} from './boot-locale.ts';
import { resolveBootRestoreDecision, resolveRestoreActions } from './boot-restore-decision.ts';
import { readBootSessionUuid } from './boot-session.ts';
import { runBootstrap } from './bootstrap.ts';
import {
  type BranchInfoProxyDeps,
  proxyAwaitBranchSwitched,
  proxyFetchBranchInfo,
  proxyRunCheckout,
  proxyShareTargetStatus,
} from './branch-info-proxy.ts';
import { createBugReportSidecarStore } from './bug-report-sidecar.ts';
import { appBundleRootFromExecutable, wrapperPathInBundle } from './bundle-paths.ts';
import {
  type BundleReplaceWatcherHandle,
  startBundleReplaceWatcher,
} from './bundle-replace-detector.ts';
import { cascadePosition } from './cascade-position.ts';
import {
  checkProjectDirExists,
  checkTargetExists as checkTargetExistsImpl,
  computeShareTargetMissing,
  resolveTargetProbeCoordinate,
} from './check-target-exists.ts';
import {
  cliProbeArgs,
  type ProbeChild,
  type ProbeTimers,
  probePlatformCliOnPath,
  resolveClaudeReadiness,
  resolveCliOnPath,
  resolvePlatformCliInstalledMap,
  runLoginShellProbe,
  runWindowsPathProbe,
} from './claude-readiness.ts';
import { requestUserConsent, walkExceedsCap } from './consent-dialog.ts';
import { copyImageToClipboard } from './copy-image-clipboard.ts';
import {
  type CrashDetection,
  createCrashDetection,
  SENTINEL_HEARTBEAT_INTERVAL_MS,
  startLocalCrashReporter,
} from './crash-detection.ts';
import {
  CreateNewProjectError,
  folderState,
  resolveDefaultProjectsRoot,
  runCreateNew,
} from './create-new-project.ts';
import { createDebugIpc, type DebugIpcHandle } from './debug-ipc.ts';
import { flushDesktopLogger, getLogger, getRootDesktopLogger } from './desktop-logger.ts';
import {
  collectDesktopUninstallProjectCandidates,
  confirmDesktopUninstall,
  type DesktopUninstallFlowPreviewMode,
  type DesktopUninstallNoticeSpec,
  type DesktopUninstallProjectCandidate,
  type DesktopUninstallUiPreviewMode,
  defaultDesktopUninstallLogPath,
  desktopUninstallCompletionNotice,
  desktopUninstallConfirmNotice,
  desktopUninstallFailureNotice,
  desktopUninstallFinalStepNotice,
  isSupportedApplicationsBundle,
  normalizeDesktopUninstallFeedbackAnswers,
  type RunDesktopUninstallCleanupResult,
  readDesktopUninstallLogForDisplay,
  resolveAppBundleFromExecPath,
  resolveDesktopUninstallUiPreviewMode,
  runDesktopUninstallCleanup,
  runDesktopUninstallFeedbackStep,
  runDesktopUninstallOutcomeStep,
  selectDesktopUninstallProjectsByIndex,
} from './desktop-uninstall.ts';
import { promptForExistingFolder, promptForExistingMarkdownFile } from './dialog-helpers.ts';
import {
  type DriverUtilityLike,
  isDriverBootSmokeMode,
  runDriverBootSmoke,
} from './driver-boot-smoke.ts';
import { EMBED_HOST_PATTERNS, rewriteEmbedRequestHeaders } from './embed-referer.ts';
import { defaultGitTopLevel, discoverProject, validateFolderPick } from './folder-admission.ts';
import { ensureGitAvailable } from './git-preflight-handler.ts';
import { readCanonicalGitHubRemoteUrl } from './git-remote.ts';
import { classifyInstallShape } from './install-shape.ts';
import { formatInstanceAppName, resolveInstanceLabel } from './instance-identity.ts';
import { deriveInstanceUserDataDir } from './instance-isolation.ts';
import {
  type EditorPresenceProbes,
  registerIntegrationsSettings,
} from './integrations-settings.ts';
import {
  type BugReportScreenshotEntry,
  createBugReportScreenshotHold,
  handleBugReportCaptureScreenshot,
  handleBugReportCrashAck,
  handleBugReportCrashDumpAvailability,
  handleBugReportCreate,
  handleBugReportSend,
  resolveBugReportIntakeUrl,
} from './ipc/bug-report.ts';
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
import { handleSlidesOpen, handleSlidesStatus, shouldLogSlidesOpenError } from './ipc/slides.ts';
import {
  detectProtocol as detectProtocolImpl,
  recordHandoff as recordHandoffImpl,
  revealAllowedRoots,
  showItemInFolder as showItemInFolderImpl,
  spawnCursor as spawnCursorImpl,
  trashItem as trashItemImpl,
} from './ipc-handlers.ts';
import { logIpcError, withIpcErrorLogging } from './ipc-log.ts';
import { createDesktopKeepaliveFactory, toKeepaliveLogger } from './keepalive.ts';
import {
  detectGraphicalAuthCommand,
  runManualInstallFallbackDialog,
} from './linux-install-fallback.ts';
import { createMenuTranslator, resolveMenuCatalogDir } from './main-i18n.ts';
import {
  checkAndRepairMcpWiringOnStartup,
  type McpStartupRepairResult,
  type McpWiringCliSurface,
  type McpWiringDispatchTarget,
  type RunMcpWiringHandle,
  runMcpWiringOnFirstLaunch,
} from './mcp-wiring.ts';
import { installApplicationMenu } from './menu.ts';
import {
  LAUNCHER_FREE_ORIGIN,
  originForMenuDispatch,
  resolveMenuActionTarget,
} from './menu-action-target.ts';
import type { MenuTranslator } from './menu-translator.ts';
import { beginNavigatorHandoff, createNavigatorWindow } from './navigator-window.ts';
import {
  closeNoteWindowsForProject,
  dispatchNoteWindowMainActionToProject,
  type NoteBrowserWindow,
  type NoteWindowProject,
  noteWindowNativeChromeOptions,
  noteWindowTitle,
  openNoteWindow,
  resolveNoteWindowProject,
  resolveWindowProjectScope,
} from './note-window.ts';
import {
  getNoteWindowContext,
  listNoteWindows,
  listNoteWindowsForProject,
  type NoteWindowEntryPoint,
  setNoteWindowDoc,
  touchNoteWindow,
} from './note-window-registry.ts';
import { runOkInit } from './ok-init.ts';
import {
  type OnboardingFlowKind,
  recordCreateNewBannerShown,
  recordFirstRunShareHandoff,
  recordOnboardingFlow,
} from './onboarding-telemetry.ts';
import {
  computePathInstallDescriptor,
  computePathLeg,
  type EnsureCliOnPathResult,
  ensureCliOnPath,
  isPathShimInstalled,
  removePathShimFromRcFiles,
} from './path-install.ts';
import { probeLoopbackPort } from './port-probe.ts';
import { installStdioBrokenPipeGuard } from './process-safety-net.ts';
import {
  type ProjectIntegrationsCliSurface,
  registerProjectIntegrationsSettings,
} from './project-integrations-settings.ts';
import {
  checkAndRepairProjectMcpOnProjectOpen,
  type ProjectMcpReclaimCliSurface,
} from './project-mcp-reclaim.ts';
import { readHeadBranch as readHeadBranchImpl } from './read-head-branch.ts';
import {
  applyReducedTransparency,
  type BrowserWindowVibrancyTarget,
  type ReducedTransparencyDeps,
  setPreferredWindowVibrancy,
  type VibrancyMaterial,
} from './reduced-transparency-handler.ts';
import { removeGitFolder } from './remove-git-folder.ts';
import { attachRendererConsoleCapture } from './renderer-console-capture.ts';
import { createRendererReadySink, type RendererReadySink } from './renderer-ready-sink.ts';
import { createRendererRecovery, type RendererRecovery } from './renderer-recovery.ts';
import { resolveDetachedSpawnArgs } from './resolve-detached-spawn-args.ts';
import { resolveShareTarget as resolveShareTargetMain } from './resolve-share-target.ts';
import {
  RESTORE_REVEAL_TIMEOUT_MS,
  type RevealableWindow,
  raiseMostRecentlyFocusedAfterRestore,
  shouldRevealInactiveNow,
} from './restore-focus.ts';
import { handleRevealExternal } from './reveal-external.ts';
import { attachServerExitObserver } from './server-exit-observer.ts';
import { createServerExitRecorder, type ServerExitRecorder } from './server-exit-record.ts';
import { breakServerLockHeldBy } from './server-lock-break.ts';
import { startFirstRunHandshake } from './share-handoff.ts';
import { checkOutboundUrl, handleShellOpenExternal } from './shell-allowlist.ts';
import { applyHarvestedAuthSock, harvestShellAuthSock } from './shell-env.ts';
import { createShowGateRegistry, type ShowGateRegistry } from './show-gate.ts';
import { installSignalCleanQuit } from './signal-clean-quit.ts';
import { reclaimProjectSkillsOnProjectOpen, reclaimUserSkillsOnLaunch } from './skill-reclaim.ts';
import { resolveDeckPath } from './slides-deck-path.ts';
import { createSlidesDeckRegistry, type SlidesDeckWindow } from './slides-registry.ts';
import { recordDeckOpen } from './slides-telemetry.ts';
import { createSlidesWindow, slidesWindowChrome } from './slides-window.ts';
import { realIsExecutableFile, resolveSlidev } from './slidev-resolve.ts';
import { findFreePort, probeSlidevReady, realSpawnSlidev } from './slidev-server.ts';
import { attachSpellcheckContextMenu } from './spellcheck-context-menu.ts';
import { popSpellcheckMenu } from './spellcheck-menu.ts';
import { beginRoot, childSpan, endRoot, injectTraceparent } from './startup-trace.ts';
import { type RendererMarks, StartupWaterfall } from './startup-waterfall.ts';
import {
  type AppState,
  addRecentFile,
  addRecentProject,
  annotateMissing,
  emptyProjectSessionState,
  emptyState,
  evaluateSchemaCompatibility,
  getProjectSessionState,
  getTerminalDockState,
  MAX_SUPPORTED_SCHEMA_VERSION,
  normalizeTerminalRestartSnapshot,
  type PersistedWindowBounds,
  parseAppState,
  type RestoredWindow,
  removeRecentProject,
  type SchemaIncompatibilityDiagnostic,
  saveAppStateToDir,
  setLastUsedProjectParent,
  setNoteWindowBounds,
  setProjectSessionState,
  setProjectWindowBounds,
  setSpellCheckEnabled as setSpellCheckEnabledState,
  type UpdateChannel,
  windowRestoreKey,
} from './state-store.ts';
import { quoteStopCommandPath } from './stop-command.ts';
import { isTerminalAvailable, withTerminalCapabilityArg } from './terminal-capability.ts';
import {
  isTerminalConsented,
  isTerminalConsentedWithGrace,
  readTerminalShellSetting,
} from './terminal-consent.ts';
import { commitTerminalDockState } from './terminal-dock-persistence.ts';
import { type TerminalReaper, wireWindowTerminalReap } from './terminal-lifecycle.ts';
import {
  clampPtyDimension,
  createTerminalManager,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  type PtyUtilityLike,
} from './terminal-manager.ts';
import { createTerminalQuitDrain } from './terminal-quit-drain.ts';
import { terminalStateKeyForContext } from './terminal-state-key.ts';
import {
  recordConcurrentSessions,
  recordShellExit,
  recordTerminalSession,
  recordTerminalWindowOpened,
} from './terminal-telemetry.ts';
import {
  createTerminalWindow,
  resolveTerminalWindowProject,
  type TerminalBrowserWindow,
} from './terminal-window.ts';
import { getTerminalWindowContext, resolvePtyProjectRoot } from './terminal-window-registry.ts';
import { applyThemeApplied } from './theme-applied-handler.ts';
import { applyThemeSource, isOkThemeSource } from './theme-handler.ts';
import { createUninstallScreenRegistry } from './uninstall-ipc.ts';
import {
  loadUninstallEntry,
  noticeCloseIsConfirm,
  resolveUninstallEntryTarget,
  resolveUninstallWindowTheme,
} from './uninstall-window.ts';
import {
  applyResetIncompatible,
  applyStateQuery,
  type UpdateStateHandlerDeps,
} from './update-state-handlers.ts';
import { reclaimPendingUpdateCache } from './updater-cache.ts';
import {
  registerProtocolHandler,
  type ScreenTarget,
  type ShareDeepLinkBranchSwitchPayload,
  type ShareNavigatorPayload,
} from './url-scheme.ts';
import { migrateLegacyUserDataDir } from './userdata-migration.ts';
import { buildUtilityForkEnv } from './utility-fork-env.ts';
import { computeFirstLaunchAfterUpgrade } from './version-drift.ts';
import { buildViewMenuStateDeps, EditorViewMenuStateRegistry } from './view-menu-state.ts';
import { applyThemeToWindow, buildNonDarwinChromeOpts } from './window-chrome.ts';
import {
  type BrowserWindowLike,
  collabUrlFromApiOrigin,
  setWindowInstanceLabel,
  type UtilityProcessLike,
  WindowManager,
} from './window-manager.ts';
import { WINDOW_MIN_SIZE } from './window-min-size.ts';
import { resolveRestoredPlacement, sortWindowsByFocusSequence } from './window-placement.ts';
import {
  sweepWindowsUpdateSurvivors,
  type WindowsUpdateSurvivorSweepResult,
} from './windows-update-survivor-sweep.ts';
import {
  classifyRecentGit,
  classifyRecentGitAsync,
  readWorktreeBranchAsync,
} from './worktree-recents.ts';
import {
  checkoutShareBranchWorktree,
  createWorktree,
  listWorktreeSelector,
} from './worktree-service.ts';

const VIBRANCY_DEFAULT: VibrancyMaterial = 'sidebar';

const AGENTS_HUB_DIR = AGENTS_SKILLS_ROOT.split('/')[0] ?? '.agents';

function installedSkillRoots(home: string): string[] {
  return [
    ...(existsSync(join(home, AGENTS_HUB_DIR)) ? [AGENTS_SKILLS_ROOT] : []),
    ...USER_SKILL_HOSTS.filter((h) => existsSync(join(home, h.hostDir))).map((h) => h.skillsRoot),
  ];
}

function builtinSkillInstalled(home: string, name: string): boolean {
  return installedSkillRoots(home).some((root) => existsSync(join(home, root, name)));
}

function computeBuiltinSkillDisclosure(home: string, id: (typeof USER_GLOBAL_BUNDLE_IDS)[number]) {
  const name = BUNDLE_SKILL_NAME[id];
  let sourceDir: string;
  try {
    sourceDir = resolveBundledSkillDir(id, { checkDesktop: false });
  } catch {
    sourceDir = '';
  }
  const parsed = sourceDir ? parseSkillDir(sourceDir) : null;
  const roots = installedSkillRoots(home);
  return {
    name,
    description: parsed?.description ?? '',
    size: parsed ? estimateSkillCost(parsed) : undefined,
    installed: roots.some((root) => existsSync(join(home, root, name))),
    sourceDir,
    paths: roots.map((root) => `~/${root}/${name}`),
  };
}

let lastChromeColors: OkChromeColors | undefined;

function fanOutChromeColors(): void {
  if (process.platform === 'darwin') return;
  for (const win of BrowserWindow.getAllWindows()) {
    applyThemeToWindow(win, process.platform, nativeTheme.shouldUseDarkColors, lastChromeColors);
  }
}

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
    : buildNonDarwinChromeOpts(nativeTheme.shouldUseDarkColors)),
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

function registerCascadeAnchor(win: BrowserWindow): void {
  cascadeOrder.push(win);
  win.on('closed', () => {
    const idx = cascadeOrder.indexOf(win);
    if (idx !== -1) cascadeOrder.splice(idx, 1);
  });
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
  registerCascadeAnchor(win);
}

function applyProjectWindowPlacement(win: BrowserWindow, projectPath: string | undefined): void {
  const saved = projectPath !== undefined ? appState.projectWindowBounds[projectPath] : undefined;
  const placement = resolveRestoredPlacement({
    saved,
    workAreas: screen.getAllDisplays().map((d) => d.workArea),
    minSize: WINDOW_MIN_SIZE.EDITOR,
  });
  if (!placement) {
    applyCascadePosition(win);
    return;
  }
  win.setBounds(placement.bounds);
  if (placement.maximize || placement.fullscreen) {
    win.once('show', () => {
      if (win.isDestroyed()) return;
      if (placement.fullscreen) win.setFullScreen(true);
      else win.maximize();
    });
  }
  registerCascadeAnchor(win);
}

function applyNoteWindowPlacement(
  win: BrowserWindow,
  projectRoot: string,
  restoredBounds?: PersistedWindowBounds,
): void {
  const saved = restoredBounds ?? appState.noteWindowBounds[projectRoot];
  const occupied =
    restoredBounds === undefined &&
    listNoteWindowsForProject(projectRoot).some((windowId) => {
      if (windowId === win.id) return false;
      return BrowserWindow.fromId(windowId)?.isDestroyed() === false;
    });
  const placement = occupied
    ? null
    : resolveRestoredPlacement({
        saved,
        workAreas: screen.getAllDisplays().map((d) => d.workArea),
        minSize: WINDOW_MIN_SIZE.EDITOR,
      });
  if (!placement) {
    applyCascadePosition(win);
    return;
  }
  win.setBounds(placement.bounds);
  registerCascadeAnchor(win);
}

function trackNoteWindowFocus(win: BrowserWindow): void {
  win.on('focus', () => {
    if (win.isDestroyed()) return;
    touchNoteWindow(win.id);
    editorViewMenuStates.select(win.id);
    refreshApplicationMenu();
    const context = getNoteWindowContext(win.id);
    if (!context) return;
    recordWindowFocusSeq(
      windowRestoreKey({
        kind: 'doc',
        projectPath: context.projectRoot,
        docName: context.currentDocName,
      }),
    );
  });
}

function trackNoteWindowBounds(win: BrowserWindow, projectRoot: string): void {
  const persist = () => {
    if (win.isDestroyed()) return;
    appState = setNoteWindowBounds(appState, projectRoot, {
      ...win.getNormalBounds(),
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
    });
    saveAppState(appState);
  };
  win.on('moved', persist);
  win.on('resized', persist);
  win.on('close', persist);
}

function trackProjectWindowBounds(win: BrowserWindow, projectPath: string): void {
  const persist = () => {
    if (win.isDestroyed()) return;
    const bounds: PersistedWindowBounds = {
      ...win.getNormalBounds(),
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
    };
    appState = setProjectWindowBounds(appState, projectPath, bounds);
    saveAppState(appState);
  };
  win.on('moved', persist);
  win.on('resized', persist);
  win.on('maximize', persist);
  win.on('unmaximize', persist);
  win.on('enter-full-screen', persist);
  win.on('leave-full-screen', persist);
  win.on('close', persist);
}

let projectFocusSeqCounter = 0;
const projectFocusSeq = new Map<string, number>();
let focusTrackingFrozen = false;

function freezeFocusTracking(reason: string): void {
  if (focusTrackingFrozen) return;
  focusTrackingFrozen = true;
  getLogger('lifecycle').info({ reason }, 'project focus tracking frozen for shutdown');
}

function recordWindowFocusSeq(key: string): void {
  projectFocusSeqCounter += 1;
  projectFocusSeq.set(key, projectFocusSeqCounter);
}

function trackProjectWindowFocus(win: BrowserWindow, projectPath: string): void {
  win.on('focus', () => {
    if (focusTrackingFrozen) return;
    editorViewMenuStates.select(win.id);
    refreshApplicationMenu();
    recordWindowFocusSeq(projectPath);
    if (appState.lastOpenedProject !== projectPath) {
      appState = { ...appState, lastOpenedProject: projectPath };
      saveAppState(appState);
    }
  });
}

/*
 * STOP: never write `lastOpenedProject` from an ephemeral window. Its
 * "projectPath" is the file's PARENT directory, which poisons the
 * single-project restore fallback and collides two loose files in one dir.
 */
function trackEphemeralWindowFocus(win: BrowserWindow, fileKey: string): void {
  win.on('focus', () => {
    if (focusTrackingFrozen) return;
    editorViewMenuStates.select(win.id);
    refreshApplicationMenu();
    recordWindowFocusSeq(fileKey);
  });
}

let windowRestoreSnapshotWritten = false;

function captureWindowRestoreSnapshot(reason: string): void {
  if (windowRestoreSnapshotWritten) return;
  windowRestoreSnapshotWritten = true;
  const noteWindows: RestoredWindow[] = listNoteWindows().flatMap(({ windowId, context }) => {
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) return [];
    return [
      {
        kind: 'doc' as const,
        projectPath: context.projectRoot,
        docName: context.currentDocName,
        bounds: {
          ...win.getNormalBounds(),
          isMaximized: win.isMaximized(),
          isFullScreen: win.isFullScreen(),
        },
      },
    ];
  });
  const windows = sortWindowsByFocusSequence(
    [...(wm?.getOpenWindows() ?? []), ...noteWindows],
    projectFocusSeq,
  );
  appState = { ...appState, pendingWindowRestore: windows };
  if (!saveAppState(appState)) {
    console.warn('[main] failed to persist window-restore snapshot', {
      reason,
      windowCount: windows.length,
    });
  }
}

function probeWsUpgrade(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
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
let firstLaunchAfterUpgrade = false;
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
    canViewInSource: () => editorViewMenuStates.get(win.id).canViewInSource === true,
    setSpellCheckEnabled: setSpellCheckEnabledAppWide,
    addToDictionary: (word) => {
      session.defaultSession.addWordToSpellCheckerDictionary(word);
    },
    openExternal: (url) => {
      void openExternalSafely(url).catch((err: unknown) => {
        getLogger('spellcheck-menu').warn({ err, url }, 'context-menu search openExternal failed');
      });
    },
    viewInSource: () => {
      if (win.isDestroyed()) return;
      sendToRenderer(win.webContents, 'ok:menu-action', {
        action: 'toggle-source',
        origin: { launcherBorne: false },
      });
    },
    popMenu: (input) => {
      popSpellcheckMenu({ Menu, window: win }, { ...input, translate: currentMenuTranslator() });
    },
  });
}
let navigatorWindow: BrowserWindowLike | null = null;
let wm: WindowManager;
let terminalReaper: TerminalReaper | null = null;

function sweepConsoleHostsBeforeUpdate(): WindowsUpdateSurvivorSweepResult {
  const logger = getLogger('updater');
  return sweepWindowsUpdateSurvivors({
    installTree: process.resourcesPath,
    logger: {
      info: (event) => logger.info(event, 'Windows update console-host sweep complete'),
      warn: (event) => logger.warn(event, 'Windows update console-host sweep warning'),
    },
  });
}
const slidesDeckRegistry = createSlidesDeckRegistry();
const dockVisibleForWindow = new Map<number, boolean>();
const agentPanelVisibleForWindow = new Map<number, boolean>();
type DockOrderRecord = { order: string[]; activeKey: string | null };
const dockOrderForWindow = new Map<
  number,
  Partial<Record<'terminal' | 'agents', DockOrderRecord>>
>();
const terminalSnapshotForWindow = new Map<number, OkTerminalRestartSnapshot>();

function terminalStateKey(win: BrowserWindow): string | null {
  const context = wm?.getContextForBrowserWindow(win as unknown as BrowserWindowLike) ?? null;
  return terminalStateKeyForContext(context);
}

function persistTerminalDockForWindow(
  win: BrowserWindow,
  update: Partial<{
    terminalVisible: boolean;
    terminalSnapshot: OkTerminalRestartSnapshot;
  }>,
): OkTerminalDockStateWriteResult {
  const stateKey = terminalStateKey(win);
  if (stateKey === null) return { ok: false, reason: 'no-window-context' };
  const committed = commitTerminalDockState({
    current: appState,
    stateKey,
    update,
    save: saveAppState,
  });
  appState = committed.state;
  return committed.result;
}
const startupWaterfall = new StartupWaterfall({ otelEnabled: false });
let firstWindowShown = false;
let waterfallDeadlineTimer: ReturnType<typeof setTimeout> | undefined;

function emitStartupWaterfall(): void {
  if (waterfallDeadlineTimer !== undefined) {
    clearTimeout(waterfallDeadlineTimer);
    waterfallDeadlineTimer = undefined;
  }
  const payload = startupWaterfall.emit({
    info: (obj, msg) => getLogger('startup').info(obj, msg),
  });
  if (payload !== undefined) {
    if (startupWaterfall.otelEnabled) {
      for (const phase of startupWaterfall.mainPhaseIntervals()) {
        childSpan(phase.name, {}, phase.startMs, phase.endMs);
      }
    }
    endRoot();
  }
}

function onFirstWindowShown(): void {
  if (firstWindowShown) return;
  firstWindowShown = true;
  startupWaterfall.mark('windowShown');
  if (startupWaterfall.readyToEmit) {
    emitStartupWaterfall();
    return;
  }
  waterfallDeadlineTimer = setTimeout(() => {
    waterfallDeadlineTimer = undefined;
    emitStartupWaterfall();
  }, startupWaterfall.flushDeadlineMs);
  waterfallDeadlineTimer.unref?.();
}

let serverBootFetched = false;
function maybeFetchServerBoot(apiOrigin: string): void {
  if (serverBootFetched) return;
  serverBootFetched = true;
  void (async () => {
    try {
      const res = await fetch(`${apiOrigin}/api/server-info`, {
        signal: AbortSignal.timeout(startupWaterfall.flushDeadlineMs),
      });
      if (!res.ok) return;
      const parsed = ServerInfoSuccessSchema.safeParse(await res.json());
      if (!parsed.success || parsed.data.boot === undefined) return;
      startupWaterfall.ingestServerBoot(parsed.data.boot);
      if (firstWindowShown && startupWaterfall.canEmit) emitStartupWaterfall();
    } catch {}
  })();
}

function ingestRendererStartupMarks(marks: RendererMarks): void {
  startupWaterfall.ingestRendererMarks(marks);
  if (firstWindowShown && startupWaterfall.canEmit) emitStartupWaterfall();
}

let restoreRevealInactive = false;

let appIsActive = false;

let appHasEverBeenActive = false;

let deepLinkClaimedWindowDuringRestore = false;

function endRestoreQuietReveal(): void {
  restoreRevealInactive = false;
}

function yieldRestoreToDeepLink(): void {
  endRestoreQuietReveal();
  deepLinkClaimedWindowDuringRestore = true;
}

const showGate: ShowGateRegistry = createShowGateRegistry({
  log: {
    warn: (obj, msg) => {
      console.warn(JSON.stringify({ ...obj, msg }));
    },
  },
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  onShown: () => onFirstWindowShown(),
  shouldRevealInactive: () =>
    shouldRevealInactiveNow({
      restoreInProgress: restoreRevealInactive,
      appHasEverBeenActive,
      appIsActive,
    }),
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
let rendererReadySink: RendererReadySink | null = null;
let crashDetection: CrashDetection | null = null;
let rendererRecovery: RendererRecovery | null = null;
let crashSentinelHeartbeat: NodeJS.Timeout | null = null;
let osShutdownNoted = false;

let serverExitRecorder: ServerExitRecorder | null = null;
function getServerExitRecorder(): ServerExitRecorder {
  if (serverExitRecorder === null) {
    serverExitRecorder = createServerExitRecorder({
      now: () => new Date(),
      logger: getLogger('server-exit'),
    });
  }
  return serverExitRecorder;
}

const bugReportScreenshots = new Map<number, BugReportScreenshotEntry>();

const bugReportSendScreenshots = createBugReportScreenshotHold({
  onEvict: (reportId) => {
    getLogger('bug-report').info(
      { event: 'bug-report.screenshot-evicted', reportId },
      'bug-report: dropped a held screenshot to stay under the cap',
    );
  },
});

const bugReportSendScreenshotReapers = new Set<number>();

const BUG_REPORT_SCREENSHOT_PREVIEW_WIDTH = 720;

const bugReportSidecar = createBugReportSidecarStore({
  dir: okBugReportsDir(),
  logger: {
    warn: (data, message) => getLogger('bug-report').warn(data as Record<string, unknown>, message),
  },
});

const editorActiveTargets = new EditorActiveTargetRegistry();

function currentActiveTarget(): EditorActiveTargetSnapshot {
  return editorActiveTargets.current(BrowserWindow.getFocusedWindow()?.id ?? null);
}

const editorViewMenuStates = new EditorViewMenuStateRegistry();

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
      } catch {}
    },
    setTimeout: (fn, ms) => {
      setTimeout(fn, ms);
    },
    utilityEntryPath: join(__dirname, 'utility/server-entry.js'),
  });
}

function withWindowRuntimeArgs(args: readonly string[]): string[] {
  const withDebug = isDebugKeyringSmokeAllowed()
    ? [...args, '--ok-debug-keyring-smoke=1']
    : [...args];
  const withTerminalCapability = withTerminalCapabilityArg(withDebug, isTerminalAvailable());
  const withSmoke =
    process.env.OK_DESKTOP_E2E_SMOKE === '1'
      ? [...withTerminalCapability, '--ok-e2e-smoke=1']
      : withTerminalCapability;
  return app.isAccessibilitySupportEnabled()
    ? [...withSmoke, '--ok-screen-reader-active=1']
    : withSmoke;
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

function readPositiveIntEnv(envVar: string): number | undefined {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    getLogger('lifecycle').warn(
      { event: 'desktop-env-override-rejected', envVar, raw },
      `[main] ignoring malformed ${envVar}; expected a positive integer count of milliseconds`,
    );
    return undefined;
  }
  return parsed;
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
          additionalArguments: withWindowRuntimeArgs(opts.additionalArguments),
          preload: join(__dirname, '../preload/index.js'),
        },
      });
      win.on('page-title-updated', (e) => {
        e.preventDefault();
      });
      applyProjectWindowPlacement(win, opts.projectPath);
      if (opts.projectPath !== undefined) {
        trackProjectWindowBounds(win, opts.projectPath);
        trackProjectWindowFocus(win, opts.projectPath);
      } else if (opts.focusKey !== undefined) {
        trackEphemeralWindowFocus(win, opts.focusKey);
      }
      attachSpellcheckMenuToWindow(win);
      win.on('closed', () => {
        editorViewMenuStates.delete(win.id);
        editorActiveTargets.delete(win.id);
      });
      if (opts.projectPath !== undefined) {
        const noteProjectRoot = opts.projectPath;
        win.on('closed', () => {
          closeNoteWindowsForProject({
            projectRoot: noteProjectRoot,
            reason: windowRestoreSnapshotWritten ? 'quit' : 'project-close',
            closingProjectWindow: win as unknown as BrowserWindowLike,
            activeProjectWindow: wm?.getWindowFor(noteProjectRoot)?.window,
            closeWindowById: (windowId) => {
              BrowserWindow.fromId(windowId)?.close();
            },
          });
        });
      }
      if (terminalReaper)
        wireWindowTerminalReap(win, terminalReaper, (windowId) => {
          dockVisibleForWindow.delete(windowId);
          agentPanelVisibleForWindow.delete(windowId);
          dockOrderForWindow.delete(windowId);
          terminalSnapshotForWindow.delete(windowId);
        });
      return win as unknown as BrowserWindowLike;
    },
    /*
     * UPSTREAM(electron/electron#19920): a BrowserWindow.focus() on a
     * backgrounded app reorders within the app without foregrounding it, so
     * bring-to-front needs this app-level activation as well.
     */
    activateApp: () => {
      if (process.platform === 'darwin') app.focus({ steal: true });
    },
    forkUtility: (entry, args, opts) => {
      startupWaterfall.mark('serverSpawned');
      const child = utilityProcess.fork(entry, args, {
        ...opts,
        env: buildUtilityForkEnv(process.env, {
          startupTraceparent: injectTraceparent(),
          otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        }),
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
              spawnErrorLogFd = openSpawnErrorLog(spawnErrorLogPath, process.pid);
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
              env: buildUtilityForkEnv(process.env, {
                startupTraceparent: injectTraceparent(),
                otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
              }),
              ...(singleFile !== undefined ? { singleFile, projectDir } : {}),
            });
            let childRef: ReturnType<typeof spawn>;
            startupWaterfall.mark('serverSpawned');
            try {
              childRef = spawn(spawnArgs.file, spawnArgs.args, {
                ...spawnArgs.opts,
                windowsHide: true,
              });
            } catch (spawnErr) {
              try {
                closeSync(spawnErrorLogFd);
              } catch {}
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
              } catch {}
            }
            let exitRecord: { code: number | null; signal: string | null } | null = null;
            childRef.on('exit', (code, signal) => {
              exitRecord = { code, signal };
            });
            attachServerExitObserver(childRef, {
              lockDir,
              recordExit: (info) => getServerExitRecorder().recordExit(info),
              logger: getLogger('server-exit'),
            });
            childRef.unref();
            const pid = childRef.pid;
            if (pid === undefined) {
              throw new Error(
                'spawnDetachedServer: child_process.spawn did not return a pid after spawn-event resolution.',
              );
            }
            return { pid, readExit: () => exitRecord };
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
    spawnLockPollDeadlineMs: readPositiveIntEnv('OK_SPAWN_STARTUP_TIMEOUT_MS'),
    spawnLockProgressDeadlineMs: readPositiveIntEnv('OK_SPAWN_BIND_TIMEOUT_MS'),
    reclaimForeignServerInDev: !app.isPackaged,
    isFirstLaunchAfterUpgrade: () => firstLaunchAfterUpgrade,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    setInterval: (cb, ms) => setInterval(cb, ms).unref(),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    killProbe: (pid, signal) => {
      process.kill(pid, signal as NodeJS.Signals | 0);
    },
    readServerLock: (lockDir) => readServerLock(lockDir),
    removeServerLock: (lockDir, expected) => breakServerLockHeldBy(lockDir, expected),
    isProcessAlive: (pid) => isProcessAlive(pid),
    hostname: () => osHostname(),
    probeWsUpgrade: (url, timeoutMs) => probeWsUpgrade(url, timeoutMs),
    realpathSync: (p) => realpathSync(p),
    onUtilityMessage: (msg) => {
      ensureDebugIpc().handleUtilityMessage(msg);
    },
    onProjectServerRestarted: ({ projectPath, apiOrigin }) => {
      recreateNoteWindowsForProject(projectPath, apiOrigin);
    },
    onUtilityExit: (utility) => {
      ensureDebugIpc().cancelPendingForUtility(utility);
    },
    log: getLogger('window-manager'),
    recordServerExit: (info) =>
      getServerExitRecorder().recordExit({ ...info, observer: 'utility-process' }),
    createKeepalive: createDesktopKeepaliveFactory({
      readServerLock: (lockDir) => readServerLock(lockDir),
      logger: toKeepaliveLogger(getLogger('keepalive')),
    }),
    showGate,
    startup: {
      get traceparent() {
        return injectTraceparent();
      },
      markServerLockReady: (info) => {
        startupWaterfall.mark('serverLockReady');
        if (info?.apiOrigin !== undefined) maybeFetchServerBoot(info.apiOrigin);
      },
      markWindowCreated: () => startupWaterfall.mark('windowCreated'),
      markLoadUrlResolved: () => startupWaterfall.mark('loadUrlResolved'),
    },
    safetyNet: {
      openExternal: handleShellOpenExternal({
        openExternal: (url) => shell.openExternal(url),
      }),
      openAsset: (projectPath, relPath) =>
        openAssetSafely(
          {
            projectPath,
            platform: process.platform,
            openPath: (canonical) => shell.openPath(canonical),
          },
          relPath,
        ),
    },
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
        width: 920,
        height: 680,
        webPreferences: {
          ...DEFAULT_WIN_OPTS.webPreferences,
          additionalArguments: withWindowRuntimeArgs(opts.additionalArguments),
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
    languagePreference: readStoredLanguagePreference(osHomedir(), (message) =>
      getLogger('navigator-window').warn(
        { message },
        'user config unreadable; launcher falls back to system',
      ),
    ),
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
        ...(o.reason !== undefined ? { reason: o.reason } : {}),
      })),
    }),
  );
  return interesting.filter((o) => o.action === 'failed').length;
}

const BOOT_BUDGET_FILE_CAP = 10_000;

async function openProject(
  projectPath: string,
  entryPoint: EntryPoint,
  pendingDeepLinkTarget?: {
    kind: 'doc' | 'folder';
    path: string;
    repositoryPath?: string;
    contentRootDepth?: number;
  },
  pendingBranch?: string | null,
  pendingMultiCandidate?: boolean,
  pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload,
  pendingTargetMissing?: boolean,
) {
  getLogger('project').info(
    {
      pickedName: basename(projectPath),
      entryPoint,
      hasDeepLinkTarget: !!pendingDeepLinkTarget,
      hasPendingBranch: !!pendingBranch,
    },
    'opening project',
  );
  ensureWindowManager();
  const navigatorHandoff = beginNavigatorHandoff(navigatorWindow);

  const validation = validateFolderPick(projectPath);
  getLogger('project').info({ pickedName: basename(projectPath) }, 'resolving project admission');
  const discovery = await discoverProject(projectPath, {
    dirSizeProbe: async (dir) => {
      getLogger('project').info(
        { projectName: basename(dir), pickedName: basename(projectPath) },
        'probing ancestor size',
      );
      try {
        const exceedsCap = await walkExceedsCap(dir, BOOT_BUDGET_FILE_CAP);
        return { exceedsCap };
      } catch (err) {
        getLogger('project').warn(
          { err },
          'project admission size probe failed, treating as over cap',
        );
        return { exceedsCap: true };
      }
    },
    gitTopLevel: async (cwd) => {
      getLogger('project').info(
        { pickedName: basename(projectPath), resolvedPickedName: basename(cwd) },
        'resolving git root',
      );
      return defaultGitTopLevel(cwd);
    },
  });

  getLogger('project').info(
    discovery.kind === 'rejected'
      ? {
          pickedName: basename(projectPath),
          discoveryKind: discovery.kind,
          reason: discovery.reason,
        }
      : {
          projectName: basename(discovery.projectDir),
          pickedName: basename(projectPath),
          discoveryKind: discovery.kind,
          ...(discovery.projectDir === discovery.pickedPath
            ? {}
            : { resolvedPickedName: basename(discovery.pickedPath) }),
          ...(discovery.kind === 'fresh'
            ? { gitState: discovery.gitState, gitRootPromoted: discovery.gitRootPromoted }
            : { ancestorPromoted: discovery.ancestorPromoted }),
        },
    'project admission resolved',
  );

  if (discovery.kind === 'rejected') {
    dialog.showErrorBox(
      'Cannot open this folder',
      `${projectPath}\n\nReason: ${
        discovery.reason === 'symlink-escape'
          ? 'Symlink resolves outside its parent directory.'
          : discovery.reason === 'home-directory'
            ? "This is your home directory, not a project. ~/.ok is OpenKnowledge's own user-global folder (settings, skills), and opening a project here would set up git in your home directory and write project config into your editors' global folders. Make a folder for your notes and open that instead."
            : 'Folder is unreadable or does not exist.'
      }`,
    );
    openNavigator();
    return;
  }

  const warningsCount = validation.warnings.length;
  const resolvedProjectDir = discovery.projectDir;
  const projectName = basename(resolvedProjectDir);
  void checkAndRepairProjectMcpOnProjectOpen({
    projectDir: resolvedProjectDir,
    executablePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
    platform: process.platform,
    cli: createProjectMcpReclaimCliSurface(),
    forceEnv: process.env.OK_M6B_FORCE ?? null,
    reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
    logger: { event: (payload) => getLogger('mcp-wiring').info(payload, payload.event) },
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
    const resolvedPickedName = basename(discovery.pickedPath);
    getLogger('project').info(
      { projectName, resolvedPickedName },
      'project admission confirmation requested',
    );
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Cancel', `Open ${projectName}`],
      cancelId: 0,
      defaultId: 0,
      title: 'Open existing project?',
      message: `OpenKnowledge wants to open the existing project at ${discovery.projectDir} (because it contains an .ok/ config). The folder you picked, ${resolvedPickedName}, is inside that project. Open ${projectName}?`,
    });
    getLogger('project').info(
      { projectName, confirmed: response !== 0 },
      'project admission confirmation answered',
    );
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
        getLogger('project').info({ projectName }, 'awaiting navigator load');
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
    navigatorHandoff.adopt(navigator);
    const showPayload: OnboardingShowPayload = {
      pickedPath: discovery.pickedPath,
      projectDir: discovery.projectDir,
      defaultContentDir: discovery.defaultContentDir,
      gitState: discovery.gitState,
      gitRootPromoted: discovery.gitRootPromoted,
      warnings: validation.warnings.map((w) => ({ kind: w.kind })),
    };
    getLogger('project').info(
      { projectName, gitState: discovery.gitState },
      'onboarding consent requested',
    );
    const decision = await requestUserConsent(
      {
        ipcMain: rendererReadySink?.ipcMain ?? ipcMain,
        navigator: (navigator as unknown as { webContents: Electron.WebContents }).webContents,
        previewContent,
      },
      showPayload,
    );
    getLogger('project').info(
      { projectName, outcome: decision.outcome },
      'onboarding consent answered',
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
      contentDirChanged || request.additionalIgnores.trim().length > 0 || !request.connectEditors
        ? 'fresh-customized'
        : 'fresh-default';
    if (
      request.initGit &&
      (discovery.gitState === 'absent' || discovery.gitState === 'shell-only')
    ) {
      getLogger('project').info(
        { projectName, gitState: discovery.gitState },
        'ensuring project git',
      );
      await ensureProjectGit(discovery.projectDir);
      didEnsureGit = true;
      getLogger('project').info({ projectName }, 'ensured project git');
    }
    getLogger('project').info({ projectName, contentDirChanged }, 'initializing project content');
    await initContent(discovery.projectDir, {
      contentDir: request.contentDir !== '.' ? request.contentDir : undefined,
    });
    getLogger('project').info({ projectName, contentDirChanged }, 'initialized project content');
    if (request.additionalIgnores.trim().length > 0) {
      appendOkIgnoreSync(discovery.projectDir, request.additionalIgnores);
    }
    aiIntegrationsFailedCount = logAiIntegrationOutcomes(
      writeProjectAiIntegrations(discovery.projectDir, [...request.editorIds]),
    );
    try {
      ensureProjectSkillGitignore(discovery.projectDir);
    } catch (err) {
      console.warn(
        `[onboarding] skipping project-skill .gitignore entry at ${discovery.projectDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    getLogger('project').info(
      {
        projectName,
        aiIntegrationsFailedCount,
        sharing: request.sharing,
        toastKind: toastPayload?.kind,
      },
      'project artifacts written',
    );
  }

  if (discovery.kind === 'managed' || discovery.kind === 'managed-requires-confirmation') {
    getLogger('project').info({ projectName }, 'reclaiming project skills');
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
        readProjectSkillDecision: (dir) =>
          readBundleDecision(osHomedir(), projectSkillDecisionKey(dir)),
        reportInstalled: (skillNames, scope) => {
          const home = osHomedir();
          void reportSkillInstall(
            {
              source: OPENKNOWLEDGE_SKILLS_REPO,
              skills: skillNames,
              ...(scope === undefined ? {} : { scope }),
            },
            { home, enabled: resolveSkillInstallReportSettings(home).enabled },
          );
        },
      },
    }).catch((err) => {
      console.warn('[main] project-skill reclaim failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });

    try {
      ensureProjectSkillGitignore(resolvedProjectDir);
    } catch (err) {
      console.warn('[main] project-skill .gitignore ensure failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    void untrackTrackedProjectSkillProjection(resolvedProjectDir)
      .then((result) => {
        if (result.kind === 'untracked') {
          getLogger('project').info(
            { dirs: result.dirs, commitSha: result.commitSha },
            'untracked OpenKnowledge project-skill projection (now local-only)',
          );
        } else if (result.kind === 'failed') {
          console.warn('[main] project-skill untrack failed', { err: result.error });
        }
      })
      .catch((err) => {
        console.warn('[main] project-skill untrack threw', {
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

  getLogger('project').info({ projectName, flowKind, didEnsureGit }, 'creating project window');
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
    freshlyCreated: entryPoint === 'create-new',
  });
  getLogger('project').info(
    {
      projectName,
      apiOrigin: ctx.apiOrigin,
      flowKind,
      didEnsureGit,
      warningsCount,
    },
    'project window created',
  );
  if (toastPayload !== null) {
    const payload = toastPayload;
    ctx.window.webContents.once('did-finish-load', () => {
      sendToRenderer(ctx.window.webContents, 'ok:onboarding:toast', payload);
    });
  }

  navigatorHandoff.close({ projectPath });
  const gitRemoteUrl = readCanonicalGitHubRemoteUrl(resolvedProjectDir) ?? undefined;
  appState = addRecentProject(appState, resolvedProjectDir, ctx.projectName, gitRemoteUrl);
  if (entryPoint === 'worktree') {
    const mainRoot = classifyRecentGit(resolvedProjectDir).mainRoot;
    if (mainRoot !== null) appState = { ...appState, lastOpenedProject: mainRoot };
  }
  saveAppState(appState);
  refreshApplicationMenu();
}

function pruneRecentIfMissing(projectPath: string): { removed: boolean; name: string } {
  const entry = appState.recentProjects.find((p) => p.path === projectPath);
  if (entry === undefined) return { removed: false, name: basename(projectPath) };
  const dirState = checkProjectDirExists(projectPath);
  if (dirState !== 'missing') {
    if (dirState === 'unreadable') {
      console.warn('[main] recents entry left intact: project folder is unreadable', {
        projectPath,
      });
    }
    return { removed: false, name: entry.name };
  }
  appState = removeRecentProject(appState, projectPath);
  saveAppState(appState);
  refreshApplicationMenu();
  console.warn('[main] pruned stale recents entry: project folder no longer exists', {
    projectPath,
  });
  return { removed: true, name: entry.name };
}

async function openProjectOrFallbackToNavigator(
  projectPath: string,
  entryPoint: EntryPoint,
  pendingDeepLinkTarget?: {
    kind: 'doc' | 'folder';
    path: string;
    repositoryPath?: string;
    contentRootDepth?: number;
  },
  pendingBranch?: string | null,
  pendingMultiCandidate?: boolean,
  pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload,
  pendingTargetMissing?: boolean,
) {
  if (
    pendingDeepLinkTarget === undefined &&
    pendingShareBranchSwitch === undefined &&
    pruneRecentIfMissing(projectPath).removed
  ) {
    openNavigator();
    return;
  }
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
    const isStaleLockHolder = kind === 'stale-lock-holder';
    const staleLockReason = isStaleLockHolder
      ? (err as Error & { reason?: string }).reason
      : undefined;
    const holderIsOwnChild =
      isStaleLockHolder &&
      (err as Error & { holderIsOwnChild?: boolean }).holderIsOwnChild === true;
    getLogger('project').error(
      {
        event: 'desktop-open-project-failed',
        projectPath,
        entryPoint,
        kind,
        exitCode: (err as Error & { exitCode?: number | null }).exitCode,
        exitSignal: (err as Error & { exitSignal?: string | null }).exitSignal,
        err,
      },
      '[main] openProject failed, falling back to Navigator',
    );
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
    } else if (kind === 'stale-lock-holder') {
      dialogTitle =
        staleLockReason === 'lock-not-attachable'
          ? 'This project\u2019s server lock cannot be used'
          : 'A stopped server is still holding this project';
      dialogBody = `${projectPath}\n\n${errorMessage}`;
    }
    const holderInTheWay =
      kind === 'lock-collision' ||
      kind === 'stale-lock-holder' ||
      (kind === 'spawn-lock-timeout' && errorMessage.includes('already running'));
    const warnsHolderMayBeLive = staleLockReason === 'lock-not-attachable' && !holderIsOwnChild;
    if (holderInTheWay) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: dialogTitle,
        message: dialogTitle,
        detail:
          `${dialogBody}\n\n` +
          (warnsHolderMayBeLive
            ? `OpenKnowledge can stop that process and retry opening the project. It may still be ` +
              `running, so stop it only if you do not need it.`
            : holderIsOwnChild
              ? `OpenKnowledge already asked that server to stop during this open. It can make ` +
                `sure it is gone and try again.`
              : `OpenKnowledge can stop the conflicting server process and retry opening the project.`),
        buttons: ['Stop Server & Retry', 'Cancel'],
        defaultId: warnsHolderMayBeLive ? 1 : 0,
        cancelId: 1,
      });
      if (response === 0) {
        ensureWindowManager();
        const stop = await wm.forceStopConflictingServer(projectPath);
        if (stop.ok) {
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
            return;
          } catch (retryErr) {
            getLogger('project').error(
              {
                event: 'desktop-open-project-retry-failed',
                projectPath,
                entryPoint,
                err: retryErr,
              },
              '[main] openProject retry after stopping the conflicting server failed',
            );
            dialog.showErrorBox(
              'Unable to open project',
              `${projectPath}\n\n${(retryErr as Error).message}`,
            );
          }
        } else {
          dialog.showErrorBox(
            'Unable to open project',
            `${projectPath}\n\n` +
              (stop.reason === 'eperm'
                ? 'The conflicting server belongs to another user account and cannot be stopped from here. Quit it from that account and try again.'
                : 'Could not stop the conflicting server. Quit it manually (`ok stop`) and try again.'),
          );
        }
      } else {
        getLogger('project').info(
          {
            projectPath,
            kind,
            ...(isStaleLockHolder ? { reason: staleLockReason, holderIsOwnChild } : {}),
            holderPid,
          },
          'user declined the stop-and-retry remedy',
        );
        if (isStaleLockHolder) {
          const stopCommandTarget = quoteStopCommandPath(projectPath, process.platform);
          dialog.showErrorBox(
            dialogTitle,
            `${dialogBody}\n\n` +
              (holderIsOwnChild
                ? `OpenKnowledge has signalled that server to stop. Open the project again. If ` +
                  `this keeps happening, the server is advertising a port it cannot serve on — ` +
                  `there is no way around that from here, so please send a report from ` +
                  `Help > Report a bug.`
                : warnsHolderMayBeLive
                  ? `Nothing was stopped. If you need that process, leave it running and open a ` +
                    `different project; if you do not, run \`ok stop ${stopCommandTarget}\` and ` +
                    `open the project again, or reopen and choose Stop Server & Retry.`
                  : `Nothing was stopped. Run \`ok stop ${stopCommandTarget}\` and open the ` +
                    `project again, or reopen and choose Stop Server & Retry to have ` +
                    `OpenKnowledge do it.`),
          );
        }
      }
      openNavigator();
      return;
    }
    dialog.showErrorBox(dialogTitle, dialogBody);
    openNavigator();
  }
}

async function openEphemeralFile(filePath: string): Promise<void> {
  ensureWindowManager();
  const navigatorHandoff = beginNavigatorHandoff(navigatorWindow);

  let plan: ReturnType<typeof prepareSingleFileOpen>;
  try {
    plan = prepareSingleFileOpen(filePath);
  } catch (err) {
    getLogger('project').warn({ file: filePath, err }, 'single-file open could not be prepared');
    dialog.showErrorBox(
      'Cannot open this file',
      `${filePath}\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    if (BrowserWindow.getAllWindows().length === 0) {
      openNavigator();
    }
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
    const existingBefore = wm.getWindowFor(plan.canonicalFilePath);
    const ctx = await wm.createEphemeralWindow({
      canonicalFilePath: plan.canonicalFilePath,
      contentDir: plan.contentDir,
      docName: plan.docName,
    });
    const deduped = existingBefore !== undefined && existingBefore === ctx;
    getLogger('project').info(
      {
        file: plan.canonicalFilePath,
        apiOrigin: ctx.apiOrigin,
        outcome: deduped ? 'focused-existing' : 'spawned-fresh',
      },
      deduped
        ? 'ephemeral single-file window focused (deduped)'
        : 'ephemeral single-file window created',
    );
    appState = addRecentFile(appState, plan.canonicalFilePath, basename(plan.canonicalFilePath));
    saveAppState(appState);
    navigatorHandoff.close({ projectPath: plan.contentDir });
    refreshApplicationMenu();
  } catch (err) {
    getLogger('project').error(
      { file: plan.canonicalFilePath, err },
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

let menuTranslator: MenuTranslator | null = null;

let pushedLanguagePreference: LanguagePreference | null = null;

function currentMenuTranslator(): MenuTranslator {
  if (menuTranslator === null) {
    const locale =
      pushedLanguagePreference === null
        ? resolveDesktopLocale({
            homedir: osHomedir(),
            preferredSystemLanguages: () => app.getPreferredSystemLanguages(),
            env: process.env,
          })
        : resolveDesktopLocaleForPushed(pushedLanguagePreference, {
            preferredSystemLanguages: () => app.getPreferredSystemLanguages(),
            env: process.env,
          });
    menuTranslator = createMenuTranslator(
      resolveMenuCatalogDir({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        mainDir: __dirname,
      }),
      locale,
    );
  }
  return menuTranslator;
}

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

async function runMenuDispatchCommand(
  command: MenuDispatchCommand,
  sender: Electron.WebContents,
): Promise<void> {
  switch (command) {
    case 'open-navigator':
      openNavigator();
      return;
    case 'open-folder-dialog': {
      const picked = await promptForExistingFolder(dialog);
      if (picked) await openProjectOrFallbackToNavigator(picked, 'pick-existing');
      return;
    }
    case 'clear-recent-projects':
      appState = { ...appState, recentProjects: [] };
      saveAppState(appState);
      refreshApplicationMenu();
      return;
    case 'open-settings': {
      const target =
        BrowserWindow.fromWebContents(sender) ??
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows()[0];
      if (!target) return;
      target.webContents
        .executeJavaScript("window.location.hash = '#settings'; undefined")
        .catch(() => {});
      return;
    }
    case 'check-for-updates':
      void autoUpdaterHandle?.checkForUpdatesNow().catch((err) => {
        console.warn('[main] checkForUpdatesNow rejected', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    case 'reconfigure-mcp-wiring':
      reconfigureMcpWiringNow();
      return;
    case 'open-github':
      void shell.openExternal('https://github.com/inkeep/open-knowledge');
      return;
    case 'toggle-spell-check':
      setSpellCheckEnabledAppWide(!appState.spellCheckEnabled);
      return;
  }
}

function applyMenuDispatchRole(role: MenuDispatchRole, sender: Electron.WebContents): void {
  if (role === 'quit') {
    app.quit();
    return;
  }
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getFocusedWindow();
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  switch (role) {
    case 'undo':
      wc.undo();
      return;
    case 'redo':
      wc.redo();
      return;
    case 'cut':
      wc.cut();
      return;
    case 'copy':
      wc.copy();
      return;
    case 'paste':
      wc.paste();
      return;
    case 'selectAll':
      wc.selectAll();
      return;
    case 'reload':
      wc.reload();
      return;
    case 'forceReload':
      wc.reloadIgnoringCache();
      return;
    case 'toggleDevTools':
      if (!app.isPackaged || channelFromVersion(app.getVersion()) === 'beta') {
        wc.toggleDevTools();
      }
      return;
    case 'resetZoom':
      wc.setZoomLevel(0);
      return;
    case 'zoomIn':
      wc.setZoomLevel(wc.getZoomLevel() + 0.5);
      return;
    case 'zoomOut':
      wc.setZoomLevel(wc.getZoomLevel() - 0.5);
      return;
    case 'toggleFullScreen':
      win.setFullScreen(!win.isFullScreen());
      return;
    case 'minimize':
      win.minimize();
      return;
    case 'close':
      win.close();
      return;
  }
}

async function runApplicationMenuRefresh(): Promise<void> {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const focusedWindowId = focusedWindow?.id ?? null;
  const editorViewMenuState = editorViewMenuStates.current(focusedWindowId);
  await installApplicationMenu({
    appName: app.name,
    translate: currentMenuTranslator(),
    showDevToolsMenu: !app.isPackaged || channelFromVersion(app.getVersion()) === 'beta',
    terminalCapable: isTerminalAvailable(),
    dialog,
    openNavigator,
    openProject: (path, entryPoint) => openProjectOrFallbackToNavigator(path, entryPoint),
    openEphemeralFile: (filePath) => openEphemeralFile(filePath),
    getRecentProjects: () => appState.recentProjects,
    clearRecentProjects: () => {
      appState = { ...appState, recentProjects: [] };
      saveAppState(appState);
      refreshApplicationMenu();
    },
    getRecentFiles: () => appState.recentFiles,
    clearRecentFiles: () => {
      appState = { ...appState, recentFiles: [] };
      saveAppState(appState);
      refreshApplicationMenu();
    },
    openExternalUrl: (url: string) => {
      void shell.openExternal(url);
    },
    reconfigureMcpWiring:
      app.isPackaged && supportedPackagedInstall()
        ? () => {
            reconfigureMcpWiringNow();
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
      target.webContents
        .executeJavaScript("window.location.hash = '#settings'; undefined")
        .catch(() => {});
    },
    onReportBug: () => sendMenuAction('report-bug'),
    onSendFeedback: () => sendMenuAction('send-feedback'),
    onCheckForUpdates: autoUpdaterHandle
      ? () => {
          void autoUpdaterHandle?.checkForUpdatesNow().catch((err) => {
            console.warn('[main] checkForUpdatesNow rejected', {
              message: err instanceof Error ? err.message : String(err),
            });
          });
        }
      : undefined,
    onUninstall: desktopSelfUninstallAvailable()
      ? () =>
          void startDesktopSelfUninstallFlow().catch((err) => {
            getLogger('lifecycle').error({ err }, 'desktop self-uninstall flow failed');
          })
      : undefined,
    onNavigateBack: () => sendMenuAction('navigate-back'),
    onNavigateForward: () => sendMenuAction('navigate-forward'),
    noteWindow: focusedWindow !== null && getNoteWindowContext(focusedWindow.id) !== undefined,
    activeTarget: currentActiveTarget(),
    onOpenInNewWindow: () => {
      const focused = BrowserWindow.getFocusedWindow();
      const docName = docNameFromActiveTarget(editorActiveTargets.current(focused?.id ?? null));
      if (!docName) return;
      openNoteWindowForDoc({ origin: focused, docName, entryPoint: 'window-menu' });
    },
    onNewFile: () => sendMenuAction('new-doc'),
    onNewFolder: () => sendMenuAction('new-folder'),
    onNewFromTemplate: () => sendMenuAction('new-from-template'),
    onNewProject: () => sendMenuAction('new-project'),
    onNewWorktree: () => sendMenuAction('new-worktree'),
    onSwitchWorktree: () => sendMenuAction('switch-worktree'),
    onRename: () => sendMenuAction('rename'),
    onDuplicate: () => sendMenuAction('duplicate'),
    onMoveToTrash: () => sendMenuAction('move-to-trash'),
    onCloseActiveTabOrWindow: () => sendMenuAction('close-active-tab-or-window'),
    onRevealInFinder: () => sendMenuAction('reveal-in-finder'),
    onSendToAi: () => sendMenuAction('send-to-ai'),
    onCopyFullPath: () => sendMenuAction('copy-full-path'),
    onCopyRelativePath: () => sendMenuAction('copy-relative-path'),
    ...buildViewMenuStateDeps(editorViewMenuState, sendMenuAction),
    ...(isTerminalAvailable()
      ? { onNewTerminalWindow: () => openTerminalWindow() }
      : {
          onToggleTerminal: undefined,
          onMoveTerminal: undefined,
          onNewTerminal: undefined,
          onKillTerminal: undefined,
          onNewTerminalWindow: undefined,
        }),
    spellCheckEnabled: appState.spellCheckEnabled,
    onToggleSpellCheck: () => setSpellCheckEnabledAppWide(!appState.spellCheckEnabled),
  });
}

function supportedPackagedInstall(): boolean {
  const kind = classifyInstallShape(process.platform, app.getPath('exe'), process.env).kind;
  return kind !== 'appimage' && kind !== 'unsupported';
}

function desktopSelfUninstallAvailable(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) return false;
  const appBundlePath = resolveAppBundleFromExecPath(process.execPath, process.platform);
  return appBundlePath !== null && isSupportedApplicationsBundle(appBundlePath, osHomedir());
}

async function showMessageBoxAttached(options: MessageBoxOptions) {
  const target = BrowserWindow.getFocusedWindow();
  return target ? dialog.showMessageBox(target, options) : dialog.showMessageBox(options);
}

async function showDesktopUninstallNotice(
  spec: DesktopUninstallNoticeSpec,
  options: {
    width?: number;
    height?: number;
    resizable?: boolean;
    onRevealLog?: () => void;
  } = {},
): Promise<boolean> {
  const closeMeansConfirm = noticeCloseIsConfirm(spec);
  return new Promise((resolveNotice) => {
    let settled = false;
    const finish = (confirmed: boolean, win?: BrowserWindow) => {
      if (settled) return;
      settled = true;
      resolveNotice(confirmed);
      if (win !== undefined && !win.isDestroyed()) win.destroy();
    };

    void openDesktopUninstallRendererWindow({
      screen: { kind: 'notice', notice: spec },
      width: options.width ?? 480,
      height: options.height ?? 300,
      resizable: options.resizable ?? false,
      title: spec.title,
      onIntent: (intent, win) => {
        if (intent.kind === 'notice-reveal-log') {
          options.onRevealLog?.();
        } else if (intent.kind === 'notice-confirm') {
          finish(true, win);
        } else if (intent.kind === 'notice-cancel') {
          finish(false, win);
        }
      },
      onClosed: () => finish(closeMeansConfirm),
    }).catch((err) => {
      getLogger('lifecycle').warn({ err }, 'desktop uninstall notice failed to load');
      finish(closeMeansConfirm);
    });
  });
}

function createDesktopUninstallUtilityWindow(options: {
  parent: BrowserWindow | null;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  title: string;
  modal?: boolean;
  resizable?: boolean;
  uninstallBridge?: boolean;
}): BrowserWindow {
  const win = new BrowserWindow({
    width: options.width,
    height: options.height,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    parent: options.parent ?? undefined,
    modal: options.modal ?? options.parent != null,
    resizable: options.resizable ?? true,
    minimizable: false,
    maximizable: false,
    show: false,
    title: options.title,
    fullscreenable: false,
    webPreferences: {
      ...DEFAULT_WIN_OPTS.webPreferences,
      ...(options.uninstallBridge === true
        ? {
            preload: join(__dirname, '../preload/index.js'),
            additionalArguments: [UNINSTALL_PRELOAD_ARG],
          }
        : {}),
    },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

const uninstallScreens = createUninstallScreenRegistry();

async function openDesktopUninstallRendererWindow(options: {
  screen: UninstallScreenSpec;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  title?: string;
  resizable?: boolean;
  preventClose?: boolean;
  onIntent: (intent: UninstallIntent, win: BrowserWindow) => void;
  onClosed?: () => void;
}): Promise<BrowserWindow> {
  const parent = BrowserWindow.getFocusedWindow();
  const win = createDesktopUninstallUtilityWindow({
    parent,
    width: options.width ?? 560,
    height: options.height ?? 420,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    title: options.title ?? 'Uninstall OpenKnowledge',
    resizable: options.resizable,
    uninstallBridge: true,
  });
  if (options.preventClose === true) {
    win.on('close', (event) => event.preventDefault());
  }
  const release = uninstallScreens.open(win.webContents.id, {
    screen: options.screen,
    onIntent: (intent) => options.onIntent(intent, win),
  });
  const shown = new Promise<void>((resolveShown) => {
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
      resolveShown();
    });
    win.once('closed', () => {
      release();
      options.onClosed?.();
      resolveShown();
    });
  });

  const theme = resolveUninstallWindowTheme(nativeTheme.shouldUseDarkColors);
  try {
    await loadUninstallEntry(
      win,
      resolveUninstallEntryTarget(
        {
          devServerUrl: rendererDevUrl,
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          mainDir: __dirname,
        },
        theme,
      ),
    );
  } catch (err) {
    release();
    if (!win.isDestroyed()) win.destroy();
    throw err;
  }
  await shown;
  return win;
}

async function showDesktopUninstallProjectPicker(
  candidates: readonly DesktopUninstallProjectCandidate[],
): Promise<DesktopUninstallProjectCandidate[] | null> {
  const parent = BrowserWindow.getFocusedWindow();
  const workArea = (
    parent ? screen.getDisplayMatching(parent.getBounds()) : screen.getPrimaryDisplay()
  ).workArea;
  const width = Math.max(560, Math.min(820, workArea.width - 80));
  const height = Math.max(460, Math.min(680, workArea.height - 80));

  return new Promise((resolveSelection) => {
    let settled = false;
    const finish = (selection: DesktopUninstallProjectCandidate[] | null, win?: BrowserWindow) => {
      if (settled) return;
      settled = true;
      resolveSelection(selection);
      if (win !== undefined && !win.isDestroyed()) win.destroy();
    };

    void openDesktopUninstallRendererWindow({
      screen: {
        kind: 'picker',
        projects: candidates.map((candidate) => ({
          path: candidate.path,
          open: candidate.open,
          recent: candidate.recent,
          running: candidate.running,
        })),
      },
      width,
      height,
      minWidth: 560,
      minHeight: 420,
      onIntent: (intent, win) => {
        if (intent.kind === 'picker-confirm') {
          finish(selectDesktopUninstallProjectsByIndex(candidates, intent.selectedIndexes), win);
        } else if (intent.kind === 'picker-cancel') {
          finish(null, win);
        }
      },
      onClosed: () => finish(null),
    }).catch((err) => {
      getLogger('lifecycle').warn({ err }, 'desktop uninstall project picker failed to load');
      finish(null);
    });
  });
}

async function showDesktopUninstallFeedbackWindow(): Promise<UninstallFeedbackAnswers> {
  const parent = BrowserWindow.getFocusedWindow();
  const workArea = (
    parent ? screen.getDisplayMatching(parent.getBounds()) : screen.getPrimaryDisplay()
  ).workArea;
  const width = Math.max(520, Math.min(620, workArea.width - 80));
  const height = Math.max(520, Math.min(640, workArea.height - 80));

  return new Promise((resolveAnswers) => {
    let settled = false;
    const finish = (answers: UninstallFeedbackAnswers, win?: BrowserWindow) => {
      if (settled) return;
      settled = true;
      resolveAnswers(answers);
      if (win !== undefined && !win.isDestroyed()) win.destroy();
    };

    void openDesktopUninstallRendererWindow({
      screen: { kind: 'survey' },
      width,
      height,
      minWidth: 480,
      minHeight: 420,
      title: 'Before you go',
      onIntent: (intent, win) => {
        if (intent.kind === 'survey-send') {
          finish(normalizeDesktopUninstallFeedbackAnswers(intent), win);
        } else if (intent.kind === 'survey-skip') {
          finish({}, win);
        }
      },
      onClosed: () => finish({}),
    }).catch((err) => {
      getLogger('lifecycle').warn({ err }, 'desktop uninstall feedback window failed to load');
      finish({});
    });
  });
}

async function collectDesktopUninstallFeedback(): Promise<void> {
  const outcome = await runDesktopUninstallFeedbackStep({
    collect: showDesktopUninstallFeedbackWindow,
    appVersion: app.getVersion(),
  });
  if (outcome.status === 'failed') {
    getLogger('lifecycle').warn({ err: outcome.error }, 'desktop uninstall feedback step failed');
  } else if (outcome.status === 'submitted' && !outcome.result.ok) {
    const log = getLogger('lifecycle');
    const line = 'desktop uninstall feedback was not delivered';
    if (outcome.result.reason === 'invalid') log.warn({ reason: outcome.result.reason }, line);
    else log.info({ reason: outcome.result.reason }, line);
  }
}

async function withDesktopUninstallProgress<T>(work: () => Promise<T>): Promise<T> {
  const win = await openDesktopUninstallRendererWindow({
    screen: { kind: 'progress' },
    width: 420,
    height: 220,
    resizable: false,
    preventClose: true,
    title: 'Uninstalling OpenKnowledge',
    onIntent: () => undefined,
  }).catch((err) => {
    getLogger('lifecycle').warn({ err }, 'desktop uninstall progress window failed to load');
    return null;
  });

  try {
    return await work();
  } finally {
    if (win !== null && !win.isDestroyed()) win.destroy();
  }
}

async function startDesktopSelfUninstallFlow(): Promise<void> {
  const appBundlePath = resolveAppBundleFromExecPath(process.execPath, process.platform);
  if (appBundlePath === null || !isSupportedApplicationsBundle(appBundlePath, osHomedir())) {
    await showMessageBoxAttached({
      type: 'error',
      message: 'OpenKnowledge cannot uninstall itself from this location.',
      detail:
        'Self-uninstall only works when OpenKnowledge.app is in Applications. Move this copy to the Trash manually.',
    });
    return;
  }

  let lockDirs: string[] = [];
  try {
    lockDirs = await discoverLockDirs();
  } catch (err) {
    getLogger('lifecycle').warn(
      { err },
      'desktop self-uninstall could not discover running project locks',
    );
  }

  const projectCandidates = collectDesktopUninstallProjectCandidates({
    recentProjects: appState.recentProjects,
    openProjectPaths: wm?.getOpenProjectPaths() ?? [],
    lockDirs,
  });
  const confirmation = await confirmDesktopUninstall({
    candidates: projectCandidates,
    showProjectPicker: showDesktopUninstallProjectPicker,
    showConfirmNotice: () =>
      showDesktopUninstallNotice(desktopUninstallConfirmNotice(), { height: 280 }),
  });
  if (!confirmation.proceed) return;

  const projectPaths = confirmation.projectPaths;
  const includeProjects = projectPaths.length > 0;
  const logPath = defaultDesktopUninstallLogPath(osHomedir());
  const cleanup = await withDesktopUninstallProgress(() =>
    runDesktopUninstallCleanup({
      cliPath: wrapperPathInBundle(process.execPath),
      projectPaths,
      logPath,
    }),
  );
  await runDesktopUninstallOutcomeStep({
    cleanup,
    runFeedbackStep: collectDesktopUninstallFeedback,
    showCompletion: async () => {
      getLogger('lifecycle').info(
        { includeProjects, projectCount: projectPaths.length, logPath },
        'desktop self-uninstall cleanup finished',
      );
      await showDesktopUninstallNotice(
        desktopUninstallCompletionNotice({ projectCount: projectPaths.length }),
        { height: 440, onRevealLog: () => shell.showItemInFolder(logPath) },
      );
    },
    showFailure: async ({ error }) => {
      getLogger('lifecycle').warn(
        { includeProjects, projectCount: projectPaths.length, logPath, error },
        'desktop self-uninstall cleanup reported failures',
      );
      await showDesktopUninstallNotice(
        desktopUninstallFailureNotice({
          error,
          logPath,
          logText: readDesktopUninstallLogForDisplay(logPath),
        }),
        { width: 560, height: 520, resizable: true },
      );
      await showDesktopUninstallNotice(desktopUninstallFinalStepNotice(), { height: 240 });
    },
  });

  shell.showItemInFolder(appBundlePath);
  autoUpdaterHandle?.suppressAutoInstallOnQuit();
  app.quit();
}

function maybeRunDesktopUninstallUiPreview(): void {
  const mode = resolveDesktopUninstallUiPreviewMode(
    process.env.OK_UNINSTALL_UI_PREVIEW,
    app.isPackaged,
  );
  if (mode === null) return;
  void runDesktopUninstallPreviewMode(mode).catch((err) => {
    getLogger('lifecycle').error({ err }, 'desktop uninstall UI preview failed');
  });
}

async function runDesktopUninstallPreviewMode(mode: DesktopUninstallUiPreviewMode): Promise<void> {
  if (mode === 'renderer') {
    await openDesktopUninstallRendererWindow({
      screen: { kind: 'notice', notice: desktopUninstallConfirmNotice() },
      onIntent: (intent, win) => {
        getLogger('lifecycle').info(
          { intent: intent.kind },
          'uninstall UI preview: renderer intent received',
        );
        if (!win.isDestroyed()) win.destroy();
      },
    });
    return;
  }
  if (mode === 'picker') {
    const selection = await showDesktopUninstallProjectPicker(
      desktopUninstallPreviewCandidates(osHomedir()),
    );
    getLogger('lifecycle').info(
      { cancelled: selection === null, selected: selection?.length ?? 0 },
      'uninstall UI preview: project picker resolved',
    );
    await openDesktopUninstallRendererWindow({
      screen: {
        kind: 'notice',
        notice: {
          title: describeDesktopUninstallPreviewSelection(selection),
          paragraphs: selection?.map((candidate) => candidate.path) ?? [],
          confirmLabel: 'Close',
        },
      },
      onIntent: (_intent, win) => {
        if (!win.isDestroyed()) win.destroy();
      },
    });
    return;
  }
  if (mode === 'notice') {
    const confirmed = await showDesktopUninstallNotice(desktopUninstallConfirmNotice(), {
      height: 280,
    });
    let reveals = 0;
    const acknowledged = await showDesktopUninstallNotice(
      desktopUninstallCompletionNotice({ projectCount: 2 }),
      { height: 440, onRevealLog: () => (reveals += 1) },
    );
    getLogger('lifecycle').info(
      { confirmed, acknowledged, reveals },
      'uninstall UI preview: notices resolved',
    );
    await openDesktopUninstallRendererWindow({
      screen: {
        kind: 'notice',
        notice: {
          title: 'Notice results',
          paragraphs: [
            `confirm=${confirmed ? 'confirmed' : 'cancelled'}`,
            `completion=${acknowledged ? 'confirmed' : 'cancelled'}`,
            `revealLog=${reveals}`,
          ],
          confirmLabel: 'Close',
        },
      },
      onIntent: (_intent, win) => {
        if (!win.isDestroyed()) win.destroy();
      },
    });
    return;
  }
  if (mode === 'survey') {
    const answers = await showDesktopUninstallFeedbackWindow();
    getLogger('lifecycle').info(
      { answered: hasUninstallFeedbackContent(answers) },
      'uninstall UI preview: churn survey resolved',
    );
    await openDesktopUninstallRendererWindow({
      screen: {
        kind: 'notice',
        notice: {
          title: describeDesktopUninstallPreviewAnswers(answers),
          paragraphs: [],
          confirmLabel: 'Close',
        },
      },
      onIntent: (_intent, win) => {
        if (!win.isDestroyed()) win.destroy();
      },
    });
    return;
  }
  await runDesktopUninstallUiPreview(mode);
}

function describeDesktopUninstallPreviewSelection(
  selection: readonly DesktopUninstallProjectCandidate[] | null,
): string {
  if (selection === null) return 'Picker cancelled';
  if (selection.length === 0) return 'Picker confirmed with no projects';
  return `Picker confirmed: ${selection.map((candidate) => candidate.path).join(', ')}`;
}

function describeDesktopUninstallPreviewAnswers(answers: UninstallFeedbackAnswers): string {
  if (!hasUninstallFeedbackContent(answers)) return 'Survey continued unanswered';
  return [
    'Survey answered',
    `reason=${answers.reason ?? '(none)'}`,
    `note=${answers.note ?? '(none)'}`,
    `email=${answers.email ?? '(none)'}`,
  ].join(' | ');
}

function desktopUninstallPreviewCandidates(home: string): DesktopUninstallProjectCandidate[] {
  return [
    { path: `${home}/Notes`, open: true, recent: true, running: true },
    { path: `${home}/Work/Team Handbook`, open: false, recent: true, running: false },
    { path: `${home}/Personal/Journal`, open: false, recent: true, running: false },
  ];
}

async function collectDesktopUninstallFeedbackPreview(): Promise<void> {
  const origin = process.env.OK_FEEDBACK_INTAKE_ORIGIN;
  const hasLocalIntake =
    typeof origin === 'string' && origin.length > 0 && !/openknowledge\.ai/i.test(origin);
  if (hasLocalIntake) {
    await collectDesktopUninstallFeedback();
    return;
  }
  await showDesktopUninstallFeedbackWindow();
  getLogger('lifecycle').warn(
    { submitted: false },
    'uninstall UI preview: feedback survey shown but not submitted — set OK_FEEDBACK_INTAKE_ORIGIN to a local ok-marketing origin to exercise delivery',
  );
}

async function runDesktopUninstallUiPreview(mode: DesktopUninstallFlowPreviewMode): Promise<void> {
  const log = getLogger('lifecycle');
  log.warn(
    { mode },
    'desktop uninstall UI preview started — non-destructive; no files are removed and the app is not trashed',
  );

  const home = osHomedir();
  const candidates = desktopUninstallPreviewCandidates(home);

  const confirmation = await confirmDesktopUninstall({
    candidates,
    showProjectPicker: showDesktopUninstallProjectPicker,
    showConfirmNotice: () =>
      showDesktopUninstallNotice(desktopUninstallConfirmNotice(), { height: 280 }),
  });
  if (!confirmation.proceed) {
    log.info({ mode }, 'desktop uninstall UI preview cancelled at the confirm surface');
    return;
  }

  const projectPaths = confirmation.projectPaths;
  const logPath = defaultDesktopUninstallLogPath(home);
  try {
    writeFileSync(
      logPath,
      'OpenKnowledge uninstall UI preview — this is a simulated log. Nothing was removed.\n',
    );
  } catch (err) {
    log.warn({ err, logPath }, 'uninstall UI preview: could not write placeholder log');
  }

  const cleanup: RunDesktopUninstallCleanupResult = await withDesktopUninstallProgress(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return mode === 'failure'
      ? { ok: false, error: 'Simulated cleanup failure (preview) — nothing was removed.' }
      : { ok: true };
  });

  await runDesktopUninstallOutcomeStep({
    cleanup,
    runFeedbackStep: collectDesktopUninstallFeedbackPreview,
    showCompletion: async () => {
      await showDesktopUninstallNotice(
        desktopUninstallCompletionNotice({ projectCount: projectPaths.length }),
        { height: 440, onRevealLog: () => shell.showItemInFolder(logPath) },
      );
    },
    showFailure: async ({ error }) => {
      await showDesktopUninstallNotice(
        desktopUninstallFailureNotice({
          error,
          logPath,
          logText: readDesktopUninstallLogForDisplay(logPath),
        }),
        { width: 560, height: 520, resizable: true },
      );
      await showDesktopUninstallNotice(desktopUninstallFinalStepNotice(), { height: 240 });
    },
  });

  log.warn({ mode }, 'desktop uninstall UI preview finished — OpenKnowledge is still installed');
}

function sendMenuAction(
  action: OkMenuAction,
  sender: WebContents | null = null,
  origin: OkMenuActionOrigin = LAUNCHER_FREE_ORIGIN,
): void {
  const target = resolveMenuActionTarget(sender, {
    fromWebContents: (contents) => BrowserWindow.fromWebContents(contents),
    getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
    getAllWindows: () => BrowserWindow.getAllWindows(),
  });
  if (!target) return;
  sendToRenderer(target.webContents, 'ok:menu-action', { action, origin });
}

function openTerminalWindow(): void {
  if (terminalReaper == null) return;
  const focused = BrowserWindow.getFocusedWindow();
  const editorCtx =
    focused && wm ? wm.getContextForBrowserWindow(focused as unknown as BrowserWindowLike) : null;
  const project = resolveTerminalWindowProject({
    editor: editorCtx ?? null,
    terminal: focused ? getTerminalWindowContext(focused.id) : undefined,
    note: focused ? getNoteWindowContext(focused.id) : undefined,
  });
  const rendererEntryPath = app.isPackaged
    ? join(process.resourcesPath, 'app', 'index.html')
    : join(__dirname, '../renderer/index.html');
  createTerminalWindow({
    createWindow: (opts) => {
      const win = new BrowserWindow({
        ...DEFAULT_WIN_OPTS,
        minWidth: WINDOW_MIN_SIZE.EDITOR.width,
        minHeight: WINDOW_MIN_SIZE.EDITOR.height,
        title: opts.title,
        webPreferences: {
          ...DEFAULT_WIN_OPTS.webPreferences,
          additionalArguments: withWindowRuntimeArgs(opts.additionalArguments),
          preload: join(__dirname, '../preload/index.js'),
        },
      });
      win.on('page-title-updated', (e) => {
        e.preventDefault();
      });
      applyCascadePosition(win);
      attachSpellcheckMenuToWindow(win);
      return win as unknown as TerminalBrowserWindow;
    },
    rendererEntryPath,
    rendererDevUrl,
    appVersion: app.getVersion(),
    showGate,
    terminalReaper,
    project,
  });
  recordTerminalWindowOpened();
}

function restoreNoteWindow(entry: {
  readonly projectPath: string;
  readonly docName: string;
  readonly bounds?: PersistedWindowBounds;
}): void {
  const ctx = wm?.getWindowFor(entry.projectPath);
  if (!ctx) return;
  openNoteWindowForDoc({
    origin: null,
    docName: entry.docName,
    project: {
      projectPath: ctx.projectPath,
      projectName: ctx.projectName,
      collabUrl: collabUrlFromApiOrigin(ctx.apiOrigin),
      apiOrigin: ctx.apiOrigin,
    },
    restoredBounds: entry.bounds,
  });
}

function recreateNoteWindowsForProject(projectRoot: string, apiOrigin: string): void {
  const docNames = listNoteWindowsForProject(projectRoot)
    .map((windowId) => getNoteWindowContext(windowId)?.currentDocName)
    .filter((docName): docName is string => docName !== undefined);
  if (docNames.length === 0) return;

  closeNoteWindowsForProject({
    projectRoot,
    reason: 'project-close',
    closeWindowById: (windowId) => {
      BrowserWindow.fromId(windowId)?.close();
    },
  });

  const project: NoteWindowProject = {
    projectPath: projectRoot,
    projectName: basename(projectRoot),
    collabUrl: collabUrlFromApiOrigin(apiOrigin),
    apiOrigin,
  };
  for (const docName of docNames) {
    try {
      openNoteWindowForDoc({ origin: null, docName, project });
    } catch (err) {
      getLogger('note-window').warn(
        { err, projectRoot, docName },
        'failed to recreate a note window after server restart',
      );
    }
  }
}

function windowProjectScope(win: BrowserWindow | null): {
  projectPath: string | undefined;
  apiOrigin: string | undefined;
} {
  if (!win) return { projectPath: undefined, apiOrigin: undefined };
  return resolveWindowProjectScope({
    editor: wm?.getContextForBrowserWindow(win as unknown as BrowserWindowLike),
    note: getNoteWindowContext(win.id),
  });
}

function windowProjectPath(win: BrowserWindow | null): string | undefined {
  return windowProjectScope(win).projectPath;
}

function applyNoteWindowTargetChange(win: BrowserWindow, target: EditorActiveTargetSnapshot): void {
  if (getNoteWindowContext(win.id) === undefined) return;
  const docName = docNameFromActiveTarget(target);
  if (!docName) return;
  setNoteWindowDoc(win.id, docName);
  if (!win.isDestroyed()) win.setTitle(noteWindowTitle(docName));
}

function openNoteWindowForDoc(args: {
  readonly origin: BrowserWindow | null;
  readonly docName: string;
  readonly entryPoint?: NoteWindowEntryPoint;
  readonly project?: NoteWindowProject;
  readonly restoredBounds?: PersistedWindowBounds;
}): { ok: true; outcome: 'created' | 'focused' } | { ok: false; reason: 'no-project' } {
  const { origin, docName, entryPoint } = args;
  const editorCtx =
    origin && wm ? wm.getContextForBrowserWindow(origin as unknown as BrowserWindowLike) : null;
  const project =
    args.project ??
    resolveNoteWindowProject({
      editor: editorCtx ?? null,
      note: origin ? getNoteWindowContext(origin.id) : undefined,
      collabUrlFromApiOrigin,
      projectNameFromPath: (projectPath) => basename(projectPath),
    });
  if (!project) return { ok: false, reason: 'no-project' };

  const rendererEntryPath = app.isPackaged
    ? join(process.resourcesPath, 'app', 'index.html')
    : join(__dirname, '../renderer/index.html');
  const nativeChrome = noteWindowNativeChromeOptions(process.platform);

  const result = openNoteWindow({
    createWindow: (opts) => {
      const win = new BrowserWindow({
        ...DEFAULT_WIN_OPTS,
        ...nativeChrome,
        minWidth: WINDOW_MIN_SIZE.EDITOR.width,
        minHeight: WINDOW_MIN_SIZE.EDITOR.height,
        title: opts.title,
        webPreferences: {
          ...DEFAULT_WIN_OPTS.webPreferences,
          additionalArguments: withWindowRuntimeArgs(opts.additionalArguments),
          preload: join(__dirname, '../preload/index.js'),
        },
      });
      win.on('page-title-updated', (e) => {
        e.preventDefault();
      });
      if (nativeChrome.vibrancy !== undefined) {
        setPreferredWindowVibrancy(win, nativeChrome.vibrancy);
      }
      attachSpellcheckMenuToWindow(win);
      return win as unknown as NoteBrowserWindow;
    },
    rendererEntryPath,
    rendererDevUrl,
    appVersion: app.getVersion(),
    showGate,
    project,
    docName,
    entryPoint,
    attachSafetyNet: (win) =>
      attachAssetSafetyNet(win.webContents, {
        editorOrigin: project.apiOrigin,
        openExternal: handleShellOpenExternal({
          openExternal: (url) => shell.openExternal(url),
        }),
        openAsset: (relPath) =>
          openAssetSafely(
            {
              projectPath: project.projectPath,
              platform: process.platform,
              openPath: (canonical) => shell.openPath(canonical),
            },
            relPath,
          ),
      }),
    placeWindow: (win) => {
      const browserWindow = win as unknown as BrowserWindow;
      applyNoteWindowPlacement(browserWindow, project.projectPath, args.restoredBounds);
      trackNoteWindowBounds(browserWindow, project.projectPath);
      trackNoteWindowFocus(browserWindow);
    },
    onClosed: (windowId) => {
      editorActiveTargets.delete(windowId);
    },
    focusWindowById: (windowId) => {
      const win = BrowserWindow.fromId(windowId);
      if (!win || win.isDestroyed()) return false;
      if (win.isMinimized()) win.restore();
      win.focus();
      return true;
    },
  });
  return { ok: true, outcome: result.outcome };
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
      if (result.action === 'declined') {
        return { action: 'declined', reason: result.declineReason };
      }
      return { action: 'overwritten' };
    },
  };
}

interface ArmMcpWiringOpts {
  forceShow?: boolean;
  immediateDispatchTarget?: McpWiringDispatchTarget;
}

const pathInstallLogger = {
  event: (payload: { event: string; [key: string]: unknown }) =>
    getLogger('path-install').info(payload, payload.event),
};

function buildEnsureCliOnPathOpts() {
  return {
    executablePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
    platform: process.platform,
    forceEnv: process.env.OK_M6B_FORCE ?? null,
    reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
    home: osHomedir(),
    bundleVersion: app.getVersion(),
    logger: pathInstallLogger,
  };
}

function buildReclaimUserSkillsOpts(): Parameters<typeof reclaimUserSkillsOnLaunch>[0] {
  return {
    home: osHomedir(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    executablePath: app.getPath('exe'),
    forceEnv: process.env.OK_M6B_FORCE ?? null,
    reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
    deps: {
      userGlobalBundles: USER_GLOBAL_BUNDLE_IDS.map((id) => ({ id, name: BUNDLE_SKILL_NAME[id] })),
      resolveBundledSkillDir: (bundle) =>
        resolveBundledSkillDir(bundle as (typeof USER_GLOBAL_BUNDLE_IDS)[number], {
          checkDesktop: false,
        }),
      readServerPackageVersion,
      writeTargetVersion: (home, target, version, surface) =>
        writeTargetVersion(home, target, version, surface),
      readBundleDecision: (home, name) => readBundleDecision(home, name),
      writeBundleDecision: (home, name, enabled) => writeBundleDecision(home, name, enabled),
      reportInstalled: (skillNames, scope) => {
        const home = osHomedir();
        void reportSkillInstall(
          {
            source: OPENKNOWLEDGE_SKILLS_REPO,
            skills: skillNames,
            global: true,
            ...(scope === undefined ? {} : { scope }),
          },
          { home, enabled: resolveSkillInstallReportSettings(home).enabled },
        );
      },
      removeBundleFromDisk: (bundleId) =>
        removeUserGlobalSkillBundle(
          osHomedir(),
          bundleId as (typeof USER_GLOBAL_BUNDLE_IDS)[number],
        ),
      recordSkillInstallEvent: (event) =>
        recordSkillInstallEvent(event as Parameters<typeof recordSkillInstallEvent>[0]),
    },
  };
}

function userGlobalSkillDestinations(home: string, name: string): string[] {
  return [
    ...(existsSync(join(home, AGENTS_HUB_DIR)) ? [`~/${AGENTS_SKILLS_ROOT}/${name}`] : []),
    ...USER_SKILL_HOSTS.filter((h) => existsSync(join(home, h.hostDir))).map(
      (h) => `~/${h.skillsRoot}/${name}`,
    ),
  ];
}

function createMcpWiringOpts(opts: ArmMcpWiringOpts = {}) {
  return {
    isPackaged: app.isPackaged,
    executablePath: app.getPath('exe'),
    home: osHomedir(),
    platform: process.platform,
    ipcMain: rendererReadySink?.ipcMain ?? ipcMain,
    cli: createMcpWiringCliSurface(),
    pathInstall: {
      computeDescriptor: () =>
        computePathInstallDescriptor({
          home: osHomedir(),
          env: process.env,
          logger: pathInstallLogger,
        }),
      applyConsent: async (status: 'granted' | 'declined') => {
        const result = await ensureCliOnPath({
          ...buildEnsureCliOnPathOpts(),
          consentDecision: { status, at: new Date().toISOString() },
        });
        if (result.status === 'failed-all') {
          return { ok: false as const, error: result.error };
        }
        return { ok: true as const };
      },
    },
    skills: {
      computeDescriptors: () =>
        ONBOARDING_BUNDLE_IDS.map((id) => {
          const home = osHomedir();
          const name = BUNDLE_SKILL_NAME[id];
          return { id, name, paths: userGlobalSkillDestinations(home, name) };
        }),
      applyConsent: async (enabledIds: readonly string[]) => {
        const home = osHomedir();
        for (const id of ONBOARDING_BUNDLE_IDS) {
          try {
            await writeBundleDecision(home, BUNDLE_SKILL_NAME[id], enabledIds.includes(id));
          } catch (err) {
            return {
              ok: false as const,
              error: `Couldn't save your preference for ${BUNDLE_SKILL_NAME[id]}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            };
          }
        }
        try {
          await reclaimUserSkillsOnLaunch(buildReclaimUserSkillsOpts());
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
        }
        return { ok: true as const };
      },
    },
    forceEnv: process.env.OK_M6B_FORCE ?? null,
    reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
    forceShow: opts.forceShow ?? false,
    immediateDispatchTarget: opts.immediateDispatchTarget,
    logger: {
      info: (msg: string, ctx?: object) =>
        getLogger('mcp-wiring').info((ctx ?? {}) as Record<string, unknown>, msg),
      warn: (msg: string, ctx?: object) =>
        getLogger('mcp-wiring').warn((ctx ?? {}) as Record<string, unknown>, msg),
      error: (msg: string, ctx?: object) =>
        getLogger('mcp-wiring').error((ctx ?? {}) as Record<string, unknown>, msg),
      event: (payload: { event: string; [k: string]: unknown }) =>
        getLogger('mcp-wiring').info(payload, payload.event),
    },
  };
}

function armMcpWiring(opts: ArmMcpWiringOpts = {}): RunMcpWiringHandle {
  return runMcpWiringOnFirstLaunch(createMcpWiringOpts(opts));
}

function reconfigureMcpWiringNow(): boolean {
  if (!(app.isPackaged && supportedPackagedInstall())) return false;
  mcpWiringHandle?.destroy();
  mcpWiringHandle = null;
  try {
    mcpWiringHandle = armMcpWiring({
      forceShow: true,
      immediateDispatchTarget: pickLoadedRendererForMcpDialog(),
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[main] reconfigureMcpWiring failed', { err: message });
    dialog.showErrorBox(
      'Set up OpenKnowledge integrations failed',
      `OpenKnowledge couldn't re-arm the MCP consent dialog:\n\n${message}`,
    );
    return false;
  }
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function realProbeSpawn(file: string, spawnArgs: readonly string[]): ProbeChild {
  const child = spawn(file, [...spawnArgs], {
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
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
}

const realProbeTimers: ProbeTimers = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
};

function probeWindowsPath(bin: string): Promise<number | null> {
  const systemRoot = getWindowsEnvValue(process.env, 'SystemRoot') ?? 'C:\\Windows';
  return runWindowsPathProbe(
    realProbeSpawn,
    join(systemRoot, 'System32', 'where.exe'),
    bin,
    realProbeTimers,
  );
}

function probeLoginShellOnPath(args?: readonly string[]): Promise<number | null> {
  return runLoginShellProbe(
    realProbeSpawn,
    resolveShell(process.env, { platform: process.platform }),
    realProbeTimers,
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
    probeClaude: () =>
      probePlatformCliOnPath({
        platform: process.platform,
        bin: 'claude',
        probePosix: (args) => probeLoginShellOnPath(args),
        probeWindows: (bin) => probeWindowsPath(bin),
      }),
    classifyMcpEntry: () =>
      createMcpWiringCliSurface().classifyExistingMcpEntry('claude', osHomedir()).kind,
    isProjectMcpPreApprovable: () => isProjectClaudeMcpOwn(projectRoot),
  });
}

function resolveTerminalCliOnPath(cli: TerminalCli): Promise<CliReadiness> {
  return resolveCliOnPath({
    probe: () =>
      probePlatformCliOnPath({
        platform: process.platform,
        bin: TERMINAL_CLIS[cli].bin,
        probePosix: (args) => probeLoginShellOnPath(args),
        probeWindows: (bin) => probeWindowsPath(bin),
      }),
    ...(cli === 'codex'
      ? {
          okServerConfigured: () =>
            classifyExistingMcpEntry(EDITOR_TARGETS.codex, '', osHomedir()).kind === 'present',
        }
      : {}),
  });
}

const CLI_INSTALLED_MAP_TTL_MS = 60_000;
let cliInstalledMapCache: {
  at: number;
  value: Promise<Partial<Record<TerminalCli, boolean>>>;
} | null = null;

function resolveTerminalCliInstalledMap(): Promise<Partial<Record<TerminalCli, boolean>>> {
  const now = Date.now();
  if (cliInstalledMapCache && now - cliInstalledMapCache.at < CLI_INSTALLED_MAP_TTL_MS) {
    return cliInstalledMapCache.value;
  }
  const value = resolvePlatformCliInstalledMap({
    platform: process.platform,
    probePosix: (args) => probeLoginShellOnPath(args),
    probeWindows: (bin) => probeWindowsPath(bin),
  }).catch((err) => {
    cliInstalledMapCache = null;
    throw err;
  });
  cliInstalledMapCache = { at: now, value };
  return value;
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

  handle('ok:mcp-wiring:reconfigure', async (): Promise<boolean> => reconfigureMcpWiringNow());

  handle('ok:spellcheck:toggle', async (): Promise<boolean> => {
    setSpellCheckEnabledAppWide(!appState.spellCheckEnabled);
    return appState.spellCheckEnabled;
  });

  handle('ok:uninstall:dispatch', (event, request) =>
    uninstallScreens.dispatch(event.sender.id, request),
  );

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
    sendNotice: (wc, payload) => sendToRenderer(wc, 'ok:pty:notice', payload),
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
    const editorCtx =
      win && wm ? wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike) : null;
    const projectPath = resolvePtyProjectRoot({
      editorProjectPath: editorCtx?.projectPath ?? null,
      terminalWindow: win ? getTerminalWindowContext(win.id) : undefined,
      homedir: osHomedir(),
    });
    if (!win || !projectPath) {
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
    const shellSetting =
      process.platform === 'win32'
        ? readTerminalShellSetting(projectPath)
        : { kind: 'unset' as const };
    return terminalManager.create({
      windowId: win.id,
      webContents: win.webContents,
      projectRoot: projectPath,
      cols: clampPtyDimension(opts.cols, DEFAULT_PTY_COLS),
      rows: clampPtyDimension(opts.rows, DEFAULT_PTY_ROWS),
      ...(shellSetting.kind === 'configured' ? { shell: shellSetting.shell } : {}),
      ...(shellSetting.kind === 'invalid' ? { shellInvalidReason: shellSetting.reason } : {}),
      launchCommand: opts.launchCommand,
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
  handle('ok:pty:list', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? terminalManager.listSessions(win.id) : [];
  });
  handle('ok:pty:adopt', async (event, req) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:pty:adopt',
        reason: 'unknown-session',
        handler: 'adoptPty',
      });
      return { ok: false, reason: 'unknown-session' };
    }
    return terminalManager.adoptSession({
      windowId: win.id,
      ptyId: req.ptyId,
      webContents: win.webContents,
    });
  });
  handle('ok:pty:set-meta', async (event, req) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win)
      terminalManager.setSessionMeta({
        windowId: win.id,
        ptyId: req.ptyId,
        customLabel: req.customLabel,
        ordinal: req.ordinal,
      });
    return undefined;
  });
  handle('ok:pty:set-order', async (event, req) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win)
      terminalManager.setSessionOrder({ windowId: win.id, orderedPtyIds: req.orderedPtyIds });
    return undefined;
  });
  handle('ok:terminal:claude-assist', async (event, req) => {
    let rewireError: string | undefined;
    if (req.action === 'rewire' && app.isPackaged && supportedPackagedInstall()) {
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

  handle(
    'ok:terminal:cli-installed-map',
    async (): Promise<Partial<Record<TerminalCli, boolean>>> => {
      return resolveTerminalCliInstalledMap();
    },
  );

  handle('ok:remote-access:dispatch', async (_event, req) => {
    if (req.kind === 'probe-port') return probeLoopbackPort(req.port);
    throw new Error(`unhandled remote-access dispatch kind: ${(req as { kind: string }).kind}`);
  });

  handle('ok:terminal:dock-state', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win)
      return {
        terminalVisible: false,
        agentPanelVisible: false,
      };
    const stateKey = terminalStateKey(win);
    const persisted = stateKey === null ? null : getTerminalDockState(appState, stateKey);
    const orders = dockOrderForWindow.get(win.id);
    return {
      terminalVisible: dockVisibleForWindow.get(win.id) ?? persisted?.terminalVisible ?? false,
      agentPanelVisible: agentPanelVisibleForWindow.get(win.id) ?? false,
      terminal: orders?.terminal,
      terminalSnapshot: terminalSnapshotForWindow.get(win.id) ?? persisted?.terminalSnapshot,
      agents: orders?.agents,
    };
  });

  handle('ok:terminal:set-dock-state', async (event, req) => {
    const surface = Reflect.get(req, 'surface');
    if (surface !== 'terminal' && surface !== 'agents') {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:terminal:set-dock-state',
        reason: 'invalid-request',
        handler: 'setTerminalDockState',
      });
      return { ok: false, reason: 'invalid-request' } as const;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:terminal:set-dock-state',
        reason: 'no-window-context',
        handler: 'setTerminalDockState',
      });
      return { ok: false, reason: 'no-window-context' } as const;
    }
    const order = Reflect.get(req, 'order');
    const activeKey = Reflect.get(req, 'activeKey');
    if (!Array.isArray(order) || (typeof activeKey !== 'string' && activeKey !== null)) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:terminal:set-dock-state',
        reason: 'invalid-request',
        handler: 'setTerminalDockState',
      });
      return { ok: false, reason: 'invalid-request' } as const;
    }
    const validOrder = order.filter((key): key is string => typeof key === 'string');
    dockOrderForWindow.set(win.id, {
      ...dockOrderForWindow.get(win.id),
      [surface]: { order: validOrder, activeKey },
    });
    if (surface === 'agents') return { ok: true } as const;

    const terminalSnapshot = Reflect.get(req, 'terminalSnapshot');
    if (terminalSnapshot === undefined) return { ok: true } as const;
    const normalizedSnapshot = normalizeTerminalRestartSnapshot(terminalSnapshot);
    terminalSnapshotForWindow.set(win.id, normalizedSnapshot);
    return persistTerminalDockForWindow(win, { terminalSnapshot: normalizedSnapshot });
  });

  handle('ok:dialog:open-folder', async (_event, opts) => {
    return promptForExistingFolder(dialog, opts);
  });

  handle('ok:project:open-file-picker', async () => {
    const picked = await promptForExistingMarkdownFile(dialog);
    if (picked) await openEphemeralFile(picked);
    return undefined;
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
    const callerProjectPath = windowProjectPath(callerWin);
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
                windowsHide: true,
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
    const callerProjectPath = windowProjectPath(callerWin);
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
    const callerProjectPath = windowProjectPath(callerWin);
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
    const projectPath = windowProjectPath(callerWin);
    if (!projectPath) return undefined;
    popAssetMenu(
      {
        Menu,
        window: callerWin,
      },
      {
        kind: params.kind,
        platform: process.platform,
        translate: currentMenuTranslator(),
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
    const callerProjectPath = windowProjectPath(callerWin);
    const result = showItemInFolderImpl(
      {
        platform: process.platform,
        projectPath: callerProjectPath,
        allowedRoots: revealAllowedRoots(),
        showItemInFolder: (p) => shell.showItemInFolder(p),
      },
      path,
    );
    if (!result.ok) {
      console.warn('[main] show-item-in-folder refused', { reason: result.reason });
    }
    return undefined;
  });

  handle('ok:shell:reveal-external', async (event, absPath) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    const result = await handleRevealExternal(absPath, {
      probe: (p) => {
        try {
          statSync(p);
          return 'exists';
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
        }
      },
      confirmReveal: async (p) => {
        const revealQuestion =
          process.platform === 'darwin'
            ? 'Reveal it in Finder?'
            : process.platform === 'win32'
              ? 'Reveal it in File Explorer?'
              : 'Open its containing folder?';
        const opts: MessageBoxOptions = {
          type: 'question',
          buttons: [revealMenuLabel(process.platform), 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: `"${basename(p)}" is outside your project`,
          detail: `${p}\n\n${revealQuestion}`,
        };
        const { response } = callerWin
          ? await dialog.showMessageBox(callerWin, opts)
          : await dialog.showMessageBox(opts);
        return response === 0;
      },
      showItemInFolder: (p) => shell.showItemInFolder(p),
    });
    if (!result.ok) {
      console.warn('[main] reveal-external refused', { reason: result.reason });
    }
    return result;
  });

  handle('ok:shell:trash-item', async (event, absPath) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    const callerProjectPath = windowProjectPath(callerWin);
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

  handle('ok:editor:active-target-changed', async (event, target) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      editorActiveTargets.update(win.id, target);
      applyNoteWindowTargetChange(win, target);
    }
    refreshApplicationMenu();
    return undefined;
  });

  handle('ok:editor:view-menu-state-changed', async (event, state) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) editorViewMenuStates.update(win.id, state);
    if (state.terminalVisible !== undefined || state.agentPanelVisible !== undefined) {
      if (win) {
        if (state.terminalVisible !== undefined) {
          dockVisibleForWindow.set(win.id, state.terminalVisible);
          const result = persistTerminalDockForWindow(win, {
            terminalVisible: state.terminalVisible,
          });
          if (!result.ok) {
            getLogger('terminal').warn(
              { reason: result.reason },
              'terminal visibility persistence failed',
            );
          }
        }
        if (state.agentPanelVisible !== undefined)
          agentPanelVisibleForWindow.set(win.id, state.agentPanelVisible);
      }
    }
    refreshApplicationMenu();
    return undefined;
  });

  handle('ok:editor:background-throttle', async (event, signal) => {
    applyBackgroundThrottle(event.sender, signal);
    return undefined;
  });

  handle('ok:clipboard:write-text', async (_event, text) => {
    clipboard.writeText(text);
    return undefined;
  });

  handle('ok:clipboard:copy-image', async (event, { src, alt }) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    if (!callerWin || !wm) {
      return { ok: false as const, reason: 'read-error' as const, detail: 'no window context' };
    }
    const { projectPath, apiOrigin } = windowProjectScope(callerWin);
    if (!projectPath || !apiOrigin) {
      return { ok: false as const, reason: 'read-error' as const, detail: 'no project context' };
    }
    return copyImageToClipboard(
      {
        projectPath,
        platform: process.platform,
        assetOrigin: apiOrigin,
        clipboard,
        nativeImage,
      },
      { src, alt },
    );
  });

  handle('ok:locale:set-preference', async (_event, { preference }) => {
    pushedLanguagePreference = preference;
    menuTranslator = null;
    getLogger('menu-locale').info({ preference }, 'language preference pushed; rebuilding menu');
    refreshApplicationMenu();
    return { ok: true };
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
        applyChromeColors: (chrome) => {
          lastChromeColors = chrome;
          fanOutChromeColors();
        },
        warn: (line) => console.warn(line),
      },
      win as unknown as object | null,
      opts,
    );
    return undefined;
  });

  handle('ok:menu:dispatch', async (event, request) => {
    switch (request.kind) {
      case 'query':
        return {
          recentProjects: appState.recentProjects.map((r) => ({ path: r.path, name: r.name })),
          spellCheckEnabled: appState.spellCheckEnabled,
          showDevToolsMenu: !app.isPackaged || channelFromVersion(app.getVersion()) === 'beta',
          canCheckForUpdates: autoUpdaterHandle != null,
          canReconfigureMcpWiring: app.isPackaged && supportedPackagedInstall(),
          activeTarget: currentActiveTarget(),
          viewMenuState: (() => {
            const win = BrowserWindow.fromWebContents(event.sender);
            return win ? editorViewMenuStates.get(win.id) : editorViewMenuStates.current();
          })(),
        };
      case 'menu-action':
        sendMenuAction(request.action, event.sender, originForMenuDispatch(request.kind));
        return undefined;
      case 'open-recent-project':
        await openProjectOrFallbackToNavigator(request.path, 'recents');
        return undefined;
      case 'command':
        await runMenuDispatchCommand(request.command, event.sender);
        return undefined;
      case 'role':
        applyMenuDispatchRole(request.role, event.sender);
        return undefined;
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  });

  handle('ok:startup:renderer-marks', async (_event, marks) => {
    if (!Number.isFinite(marks?.pageListReadyMs) || !Number.isFinite(marks?.firstContentMs)) {
      return undefined;
    }
    ingestRendererStartupMarks(marks);
    return undefined;
  });

  handle('ok:project:get-info', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('webContents has no parent BrowserWindow');
    const ctx = wm?.getContextForBrowserWindow(win as unknown as BrowserWindowLike);
    if (!ctx) throw new Error('No project context for this window');
    return {
      collabUrl: collabUrlFromApiOrigin(ctx.apiOrigin),
      apiOrigin: ctx.apiOrigin,
      projectPath: ctx.projectPath,
      projectName: ctx.projectName,
      mode: 'editor' as const,
      e2eSmoke: process.env.OK_DESKTOP_E2E_SMOKE === '1',
      singleFile: ctx.ephemeral !== undefined,
      ptyAvailable: isTerminalAvailable(),
      initialDoc: null,
      freshlyCreated: false,
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

  handle('ok:slides:dispatch', async (event, request) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const projectRoot =
      win && wm
        ? wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike)?.projectPath
        : undefined;
    const probes = {
      isExecutableFile: realIsExecutableFile,
      isOnLoginPath: async (bin: string) =>
        (await (process.platform === 'win32'
          ? probeWindowsPath(bin)
          : probeLoginShellOnPath(cliProbeArgs(bin, process.platform)))) === 0,
    };
    if (request.kind === 'status') {
      return handleSlidesStatus(projectRoot, probes);
    }
    const deckPath = resolveDeckPath({
      docPath: request.docPath,
      projectRoot,
      platform: process.platform,
      realpath: (p) => realpathSync(p),
    });
    if (!deckPath.ok) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:slides:dispatch',
        reason: 'invalid-path',
        handler: 'slidesOpen',
        ...(deckPath.cause === undefined ? {} : { cause: deckPath.cause }),
      });
      return { kind: 'open', ok: false, reason: 'invalid-path' };
    }
    const { resolvedDocPath, projectRoot: containedRoot } = deckPath;
    const resolution = await resolveSlidev(projectRoot, probes);
    if (!resolution.available) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:slides:dispatch',
        reason: 'not-available',
        handler: 'slidesOpen',
      });
      return { kind: 'open', ok: false, reason: 'not-available' };
    }
    const opened = await handleSlidesOpen(resolvedDocPath, {
      registry: slidesDeckRegistry,
      startDeps: {
        findFreePort,
        spawnSlidev: (port) => {
          const base = {
            docPath: resolvedDocPath,
            shell: resolveShell(process.env, { platform: process.platform }),
          };
          return realSpawnSlidev(
            resolution.source === 'project-local'
              ? { ...base, source: 'project-local', projectRoot: containedRoot }
              : { ...base, source: 'global', projectRoot: containedRoot },
            port,
          );
        },
        probeReady: probeSlidevReady,
        now: () => Date.now(),
        delay: (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
      },
      recordOpenAttempt: recordDeckOpen,
      openWindow: (deck) => {
        return createSlidesWindow({
          createWindow: (winOpts) => {
            const win = new BrowserWindow({
              ...DEFAULT_WIN_OPTS,
              ...slidesWindowChrome(),
              minWidth: WINDOW_MIN_SIZE.EDITOR.width,
              minHeight: WINDOW_MIN_SIZE.EDITOR.height,
              title: winOpts.title,
              webPreferences: {
                ...DEFAULT_WIN_OPTS.webPreferences,
                partition: winOpts.partition,
              },
            });
            win.on('page-title-updated', (e) => {
              e.preventDefault();
            });
            applyCascadePosition(win);
            return win as unknown as SlidesDeckWindow;
          },
          registry: slidesDeckRegistry,
          deck: { docPath: deck.docPath, port: deck.port, process: deck.process },
        });
      },
      focusWindow: (window) => {
        if (window.isMinimized?.()) window.restore?.();
        window.show?.();
        window.moveTop?.();
        window.focus();
      },
    });
    if (shouldLogSlidesOpenError(opened)) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:slides:dispatch',
        reason: opened.reason,
        handler: 'slidesOpen',
      });
    }
    return opened;
  });

  handle('ok:bug-report:dispatch', async (event, request) => {
    if (request.kind === 'crash-ack') {
      return handleBugReportCrashAck(
        { ackCrashEvent: (eventId) => crashDetection?.ack(eventId) },
        request,
      );
    }
    if (request.kind === 'list') {
      return bugReportSidecar.list();
    }
    if (request.kind === 'delete') {
      const removed = await bugReportSidecar.remove(request.id);
      if (removed.ok) bugReportSendScreenshots.forget(request.id);
      return removed;
    }
    if (request.kind === 'send') {
      return handleBugReportSend(
        {
          intakeBaseUrl: resolveBugReportIntakeUrl({
            envUrl: process.env.OK_BUG_REPORT_INTAKE_URL,
          }),
          appVersion: app.getVersion(),
          platform: `${process.platform} ${osRelease()}`,
          bugReportsRoot: dirname(defaultBugReportZipPath()),
          sidecar: {
            onSendStart: (id) => bugReportSidecar.sendHooks.onSendStart(id),
            onSendResult: async (id, outcome) => {
              try {
                await bugReportSidecar.sendHooks.onSendResult(id, outcome);
              } finally {
                if (outcome.kind === 'sent') bugReportSendScreenshots.forget(id);
              }
            },
          },
          screenshotPngBytes: (reportId) => bugReportSendScreenshots.read(reportId),
        },
        request,
      );
    }
    if (request.kind === 'crash-dump-availability') {
      return handleBugReportCrashDumpAvailability({
        newestMinidumpForReport: () =>
          crashDetection?.newestMinidumpForReport() ?? {
            path: null,
            foreignSkipped: 0,
            unknownSkipped: 0,
          },
        logger: getLogger('bug-report'),
      });
    }
    if (request.kind === 'capture-screenshot') {
      const captureWin = BrowserWindow.fromWebContents(event.sender);
      if (!captureWin) return null;
      const sender = event.sender;
      return handleBugReportCaptureScreenshot({
        store: bugReportScreenshots,
        senderId: sender.id,
        capturePage: () => captureWin.webContents.capturePage(),
        previewWidth: BUG_REPORT_SCREENSHOT_PREVIEW_WIDTH,
        registerCleanup: (cleanup) => sender.once('destroyed', cleanup),
        unregisterCleanup: (cleanup) => sender.removeListener('destroyed', cleanup),
        logger: getLogger('bug-report'),
      });
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const ctx =
      win && wm ? wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike) : null;
    return handleBugReportCreate(
      {
        projectDir: ctx?.projectPath ?? null,
        desktopMeta: {
          version: app.getVersion(),
          packaged: app.isPackaged,
          channel: channelFromVersion(app.getVersion()),
        },
        readLanguage: () =>
          describeDesktopLanguage({
            homedir: osHomedir(),
            preferredSystemLanguages: () => app.getPreferredSystemLanguages(),
            env: process.env,
            pushedPreference: pushedLanguagePreference,
          }),
        newestMinidumpForReport: () =>
          crashDetection?.newestMinidumpForReport() ?? {
            path: null,
            foreignSkipped: 0,
            unknownSkipped: 0,
          },
        screenshotPngBytes: () => bugReportScreenshots.get(event.sender.id)?.png ?? null,
        onScreenshotStaged: (reportId, png) => {
          const composedBy = event.sender.id;
          bugReportSendScreenshots.remember(reportId, png, composedBy);
          if (bugReportSendScreenshotReapers.has(composedBy)) return;
          bugReportSendScreenshotReapers.add(composedBy);
          event.sender.once('destroyed', () => {
            bugReportSendScreenshotReapers.delete(composedBy);
            bugReportSendScreenshots.forgetOwner(composedBy);
          });
        },
        onReportGenerated: (meta) => bugReportSidecar.recordGenerated(meta),
        logger: getLogger('bug-report'),
        flushLogger: flushDesktopLogger,
      },
      request,
    );
  });

  handle('ok:project:list-recent', async () => {
    return Promise.all(
      annotateMissing(appState).map(async (entry): Promise<RecentProject> => {
        if (entry.missing) return entry;
        const [git, branch] = await Promise.all([
          classifyRecentGitAsync(entry.path),
          readWorktreeBranchAsync(entry.path),
        ]);
        if (git.gitCommonDir === null) return entry;
        return {
          ...entry,
          gitCommonDir: git.gitCommonDir,
          mainRoot: git.mainRoot ?? undefined,
          isLinkedWorktree: git.isLinkedWorktree,
          branch,
        };
      }),
    );
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
    if (!win || !wm) return emptyProjectSessionState();
    const ctx = wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike);
    if (!ctx) return emptyProjectSessionState();
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

  handle('ok:project:open', async (event, request) => {
    if (!isEntryPoint(request.entryPoint)) {
      throw new Error(
        `ok:project:open rejected: invalid entryPoint '${String(request.entryPoint)}'`,
      );
    }
    if (
      request.pendingDeepLinkTarget === undefined &&
      request.pendingShareBranchSwitch === undefined
    ) {
      const pruned = pruneRecentIfMissing(request.path);
      if (pruned.removed) {
        sendToRenderer(event.sender, 'ok:project:recent-removed-missing', {
          path: request.path,
          projectName: pruned.name,
        });
        return undefined;
      }
    }
    const targetMissing = (() => {
      const target = request.pendingDeepLinkTarget;
      if (target === undefined) return false;
      const probeCoordinate = resolveTargetProbeCoordinate(
        request.path,
        target,
        (projectPath) => loadConfig(projectPath).config.content.dir,
        getLogger('share-receive'),
      );
      return computeShareTargetMissing(
        checkTargetExistsImpl,
        probeCoordinate.root,
        probeCoordinate.target,
      );
    })();
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
          ...(request.pendingDeepLinkTarget.repositoryPath === undefined
            ? {}
            : { repositoryPath: request.pendingDeepLinkTarget.repositoryPath }),
          ...(request.pendingDeepLinkTarget.contentRootDepth === undefined
            ? {}
            : { contentRootDepth: request.pendingDeepLinkTarget.contentRootDepth }),
          ...(targetMissing ? { targetMissing: true } : {}),
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
      targetMissing || undefined,
    );
    return undefined;
  });

  handle('ok:worktree:dispatch', async (event, request) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const ctx =
      win && wm ? wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike) : null;
    const projectPath = ctx?.projectPath ?? null;
    if (!projectPath) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:worktree:dispatch',
        reason: 'no-git',
        handler: 'worktreeDispatch',
      });
      return { ok: false, reason: 'no-git' };
    }
    let anchor: string;
    try {
      anchor = realpathSync(projectPath);
    } catch {
      anchor = projectPath;
    }
    if (request.kind === 'list') {
      return listWorktreeSelector(anchor, anchor);
    }
    const result =
      request.kind === 'checkout'
        ? await checkoutShareBranchWorktree({ anchorPath: anchor, branch: request.branch })
        : await createWorktree({
            anchorPath: anchor,
            branch: request.branch,
            baseBranch: request.baseBranch,
            baseRef: request.baseRef,
            remoteRef: request.remoteRef,
            createBranch: request.createBranch,
          });
    if (!result.ok) {
      getLogger('worktree').warn(
        {
          kind: request.kind,
          reason: result.reason,
          helper: result.helper,
          message: result.message,
          branch: request.branch,
        },
        'worktree dispatch failed',
      );
    }
    return result;
  });

  handle('ok:share:validate-folder', async (_event, request) => {
    return validateLocalFolderForShare(request.folderPath, {
      host: request.host,
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

  handle('ok:project:fetch-target-status', async (_event, request) => {
    return proxyShareTargetStatus(request, branchInfoProxyDeps);
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

  handle('ok:project:restart-server', async (event, projectPath) => {
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
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const outcome = await wm.restartServerForWindow(senderWindow, projectPath, {
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
    let documentsDir: string;
    try {
      documentsDir = app.getPath('documents');
    } catch (err) {
      getLogger('fs').warn(
        { err },
        "app.getPath('documents') failed; falling back to home/Documents",
      );
      documentsDir = join(app.getPath('home'), 'Documents');
    }
    return resolveDefaultProjectsRoot(appState.lastUsedProjectParent, documentsDir);
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
        const outcome = await runStop({
          lockDir: resolveLockDir(gitRoot),
          force: true,
          log: (msg) => getLogger('project').info({ gitRoot }, `[remove-git-folder] ${msg}`),
        });
        getLogger('project').info(
          { gitRoot, stopped: outcome.stopped.length, hadTargets: outcome.hadTargets },
          'remove-git-folder: stopped worktree server before .git removal',
        );
      } catch (err) {
        getLogger('project').warn(
          { gitRoot, err },
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
        packId: args.packId,
        rootDir: args.rootDir,
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

  handle('ok:window:open-note', async (event, request) => {
    return withIpcErrorLogging(
      {
        channel: 'ok:window:open-note',
        reason: 'unexpected',
        handler: 'openNoteWindow',
      },
      async () => {
        if (request.kind === 'dispatch-to-main') {
          const origin = BrowserWindow.fromWebContents(event.sender);
          return dispatchNoteWindowMainActionToProject({
            originWindowId: origin?.id ?? null,
            action: request.action,
            getContext: getNoteWindowContext,
            focusProjectWindow: (projectRoot) => wm?.focusWindowForProject(projectRoot) ?? null,
            send: (target, action) =>
              sendToRenderer(target.webContents, 'ok:note-window:main-action', action),
          });
        }
        const docName = typeof request.docName === 'string' ? request.docName.trim() : '';
        if (!docName) return { ok: false as const, reason: 'invalid-request' as const };
        return openNoteWindowForDoc({
          origin: BrowserWindow.fromWebContents(event.sender),
          docName,
          entryPoint: request.entryPoint === 'palette' ? 'palette' : 'tab-menu',
        });
      },
    );
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

  registerIntegrationsSettingsIpc();
  registerProjectIntegrationsSettingsIpc();
}

const EDITOR_PRESENCE_TTL_MS = 60_000;
let editorPresenceCache: { at: number; value: Promise<EditorPresenceProbes> } | null = null;

function probeEditorPresence(): Promise<EditorPresenceProbes> {
  const now = Date.now();
  if (editorPresenceCache && now - editorPresenceCache.at < EDITOR_PRESENCE_TTL_MS) {
    return editorPresenceCache.value;
  }
  const value = probeEditorPresenceUncached().catch((err) => {
    editorPresenceCache = null;
    throw err;
  });
  editorPresenceCache = { at: now, value };
  return value;
}

async function probeEditorPresenceUncached(): Promise<EditorPresenceProbes> {
  const [cliOnPath, ...schemes] = await Promise.all([
    resolveTerminalCliInstalledMap().catch(() => ({}) as Record<TerminalCli, boolean>),
    ...(['claude', 'codex', 'cursor'] as const).map((scheme) =>
      detectProtocolImpl(
        {
          platform: process.platform,
          getApplicationInfoForProtocol: (url) => app.getApplicationInfoForProtocol(url),
        },
        scheme,
      )
        .then((r) => r.installed)
        .catch(() => false),
    ),
  ]);
  return {
    cliOnPath,
    schemeHandler: {
      'claude-code': schemes[0] ?? false,
      codex: schemes[1] ?? false,
      cursor: schemes[2] ?? false,
    },
  };
}

function registerIntegrationsSettingsIpc(): void {
  const integrationsLogger = getLogger('integrations-settings');
  const available =
    process.env.OK_RECLAIM_DISABLE !== '1' &&
    (app.isPackaged || process.env.OK_M6B_FORCE === '1') &&
    !['appimage', 'unsupported'].includes(
      classifyInstallShape(process.platform, app.getPath('exe'), process.env).kind,
    );
  registerIntegrationsSettings({
    home: osHomedir(),
    available,
    ipcMain,
    cli: {
      allEditorIds: ALL_EDITOR_IDS.filter((id) => EDITOR_TARGETS[id].scope === 'global'),
      editorLabel: (editorId) => EDITOR_TARGETS[editorId].label,
      classifyExistingMcpEntry: (editorId, home) =>
        classifyExistingMcpEntry(EDITOR_TARGETS[editorId], '', home),
      isOwnEntry: (entry) => isEntryUpToDate(entry) || isOwnManagedEntry(entry),
      editorConfigPath: (editorId) =>
        editorConfigPathDisplay(EDITOR_TARGETS[editorId], osHomedir()),
      editorEntryLocator: (editorId) => editorEntryLocator(EDITOR_TARGETS[editorId]),
      writeUserMcpConfigs: (writeOpts) => writeUserMcpConfigs(writeOpts),
      removeUserMcpEntry: (editorId) =>
        removeOwnMcpEntry(EDITOR_TARGETS[editorId], '', osHomedir()),
    },
    probeEditorPresence,
    path: {
      computeStatus: () => {
        const descriptor = computePathInstallDescriptor({
          home: osHomedir(),
          env: process.env,
          logger: pathInstallLogger,
        });
        return {
          shellDetected: descriptor.shellDetected,
          rcFilesToTouch: descriptor.rcFilesToTouch,
          installed: isPathShimInstalled({
            home: osHomedir(),
            env: process.env,
            logger: pathInstallLogger,
          }),
        };
      },
      install: async () => {
        const result = await ensureCliOnPath({
          ...buildEnsureCliOnPathOpts(),
          consentDecision: { status: 'granted', at: new Date().toISOString() },
        });
        if (result.status === 'failed-all') return { ok: false as const, error: result.error };
        if (result.status === 'skipped') {
          return {
            ok: false as const,
            error: `PATH setup is unavailable in this build (${result.reason}).`,
          };
        }
        return { ok: true as const };
      },
      uninstall: async () => {
        const result = removePathShimFromRcFiles({
          home: osHomedir(),
          env: process.env,
          logger: pathInstallLogger,
        });
        if (result.status === 'failed') return { ok: false as const, error: result.error };
        return { ok: true as const };
      },
    },
    skills: {
      computeStatuses: () => {
        const home = osHomedir();
        let resolvedHosts: ResolvedSkillHost[];
        try {
          resolvedHosts = resolveBuiltinSkillHosts(home);
        } catch {
          resolvedHosts = [];
        }
        return USER_GLOBAL_BUNDLE_IDS.map((id) => {
          const d = computeBuiltinSkillDisclosure(home, id);
          return {
            id,
            name: d.name,
            description: d.description,
            installed: d.installed,
            onboarding: (ONBOARDING_BUNDLE_IDS as readonly string[]).includes(id),
            size: d.size,
            sourceDir: d.sourceDir,
            resolvedHosts,
            paths: d.paths,
          };
        });
      },
      setEnabled: async (bundleId, enabled) => {
        const home = osHomedir();
        const id = USER_GLOBAL_BUNDLE_IDS.find((b) => b === bundleId);
        if (!id) return { ok: false as const, error: 'Unknown skill.' };
        const name = BUNDLE_SKILL_NAME[id];
        try {
          await writeBundleDecision(home, name, enabled);
        } catch (err) {
          return {
            ok: false as const,
            error: `Couldn't save your preference for ${name}: ${formatUnknownError(err)}`,
          };
        }
        if (!enabled) {
          try {
            removeUserGlobalSkillBundle(home, id);
          } catch (err) {
            return { ok: false as const, error: formatUnknownError(err) };
          }
          return { ok: true as const };
        }
        try {
          const result = await reclaimUserSkillsOnLaunch(buildReclaimUserSkillsOpts());
          if (result.status === 'skipped') {
            return {
              ok: false as const,
              error: `Couldn't install ${name} (${result.reason}).`,
            };
          }
        } catch (err) {
          return { ok: false as const, error: formatUnknownError(err) };
        }
        if (!builtinSkillInstalled(home, name)) {
          return { ok: false as const, error: `Couldn't install ${name}.` };
        }
        return { ok: true as const };
      },
    },
    logger: {
      warn: (msg, ctx) => integrationsLogger.warn((ctx ?? {}) as Record<string, unknown>, msg),
      error: (msg, ctx) => integrationsLogger.error((ctx ?? {}) as Record<string, unknown>, msg),
      event: (payload) => integrationsLogger.info(payload, payload.event),
    },
  });
}

function registerProjectIntegrationsSettingsIpc(): void {
  const projectLogger = getLogger('project-integrations-settings');
  const available =
    process.env.OK_RECLAIM_DISABLE !== '1' &&
    (app.isPackaged || process.env.OK_M6B_FORCE === '1') &&
    supportedPackagedInstall();
  const tildifyHomePath = (path: string): string => {
    const home = osHomedir();
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  };
  const canonicalSkillTarget = EDITOR_TARGETS.claude;
  const projectInstallOpts: McpInstallOptions = { mode: 'published', skipAvailabilityCheck: true };

  const cli: ProjectIntegrationsCliSurface = {
    allEditorIds: ALL_EDITOR_IDS,
    editorLabel: (id) => EDITOR_TARGETS[id].label,
    projectConfigPath: (id, projectDir) =>
      EDITOR_TARGETS[id].projectConfigPath?.(projectDir) ?? null,
    projectSkillPath: (id, projectDir) => EDITOR_TARGETS[id].projectSkillPath?.(projectDir) ?? null,
    projectSkillBundle: () => {
      const sourceDir = resolveBundledSkillDir('project', { checkDesktop: false });
      const parsed = sourceDir ? parseSkillDir(sourceDir) : null;
      if (!parsed) return null;
      return {
        sourceDir,
        description: parsed.description ?? '',
        size: estimateSkillCost(parsed),
      };
    },
    entryLocator: (id) => {
      const target = EDITOR_TARGETS[id];
      if (target.format === 'file') return 'open-knowledge (managed extension file)';
      const server = target.serverName('');
      return target.format === 'toml'
        ? `[${target.topLevelKey}.${server}]`
        : [target.topLevelKey, target.serverMapSubKey, server].filter(Boolean).join('.');
    },
    classifyExistingProjectMcpConfig: (id, projectDir, projectPath) =>
      classifyExistingMcpEntry(EDITOR_TARGETS[id], projectDir, undefined, projectPath),
    isOwnEntry: (entry) => isEntryUpToDate(entry) || isOwnManagedEntry(entry),
    writeProjectMcpConfig: ({ id, projectDir, projectPath }) => {
      const result = writeEditorMcpConfig(
        EDITOR_TARGETS[id],
        projectDir,
        projectInstallOpts,
        undefined,
        projectPath,
      );
      if (result.action === 'written' || result.action === 'overwritten') {
        return { action: result.action };
      }
      if (result.action === 'declined') {
        return { action: 'declined', reason: result.declineReason };
      }
      return { action: 'failed', error: result.error };
    },
    removeProjectMcpEntry: (id, projectDir, projectPath) =>
      removeOwnMcpEntry(EDITOR_TARGETS[id], projectDir, undefined, projectPath),
    isProjectSkillInstalled: (projectDir) => {
      const skillPath = canonicalSkillTarget.projectSkillPath?.(projectDir);
      return skillPath !== undefined && existsSync(skillPath);
    },
    recordProjectSkillDecision: (projectDir, enabled) => {
      void writeBundleDecision(osHomedir(), projectSkillDecisionKey(projectDir), enabled).catch(
        (err: unknown) => {
          console.warn('[main] project-skill decision not recorded', {
            err: err instanceof Error ? err.message : String(err),
          });
        },
      );
    },
    reportProjectSkillInstalled: (projectDir) => {
      const home = osHomedir();
      void reportSkillInstall(
        {
          source: OPENKNOWLEDGE_SKILLS_REPO,
          skills: [BUNDLE_SKILL_NAME.project],
          scope: projectDir,
        },
        { home, enabled: resolveSkillInstallReportSettings(home).enabled },
      );
    },
    writeProjectSkill: (id, projectDir) => {
      const result = writeProjectSkill(EDITOR_TARGETS[id], projectDir);
      return { action: result.action, ...(result.error ? { error: result.error } : {}) };
    },
    removeProjectSkill: (id, projectDir) => {
      const result = removeProjectSkill(EDITOR_TARGETS[id], projectDir);
      return { action: result.action, ...(result.error ? { error: result.error } : {}) };
    },
  };

  registerProjectIntegrationsSettings({
    available,
    ipcMain,
    cli,
    probeEditorPresence,
    resolveProjectDir: (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      return (
        wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike)?.projectPath ?? null
      );
    },
    tildify: tildifyHomePath,
    logger: {
      warn: (msg, ctx) => projectLogger.warn((ctx ?? {}) as Record<string, unknown>, msg),
      event: (payload) => projectLogger.info(payload, payload.event),
    },
  });
}

const ICON_PNG_PATH = join(__dirname, '..', '..', 'build', 'icon.png');

function installDockIcon(instanceLabel: string | null) {
  if (process.platform !== 'darwin') return;
  if (app.isPackaged) return;
  /*
   * UPSTREAM(electron/electron#3391): macOS reads the Dock tile name from the
   * running bundle's Info.plist — Electron's own for an unpackaged app — and
   * `app.setName()` does not reach it. A badge is the only runtime way to put
   * an instance label on the Dock icon.
   */
  if (instanceLabel) {
    try {
      app.dock?.setBadge(instanceLabel);
    } catch (err) {
      console.warn('[main] dock badge set failed', { err: (err as Error).message });
    }
  }
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
      { stream, code: (err as NodeJS.ErrnoException).code, err },
      'unexpected stdio stream error',
    );
  },
});

app.commandLine.appendSwitch('use-system-ca');
trustSystemCertificates();

if (!app.isPackaged) {
  const resolved = resolveEffectiveInstanceName(process.env, app.getAppPath(), {
    autoDeriveEnabled: process.env.OK_DESKTOP_E2E_SMOKE !== '1',
  });
  if (resolved) {
    const relocatedUserData = deriveInstanceUserDataDir(app.getPath('userData'), resolved.name);
    if (relocatedUserData) {
      mkdirSync(relocatedUserData, { recursive: true });
      app.setPath('userData', relocatedUserData);
      getRootDesktopLogger().info(
        {
          event: 'desktop.parallel-instance',
          instance: resolved.name,
          source: resolved.source,
          userData: relocatedUserData,
        },
        'relocated userData for parallel dev instance',
      );
    }
  }
}

const instanceLabel = resolveInstanceLabel(app.getPath('userData'));
if (instanceLabel) {
  app.setName(formatInstanceAppName(app.getName(), instanceLabel));
  setWindowInstanceLabel(instanceLabel);
}

const A11Y_FORCED_BY_ENV = process.env.OK_FORCE_A11Y === '1';
if (A11Y_FORCED_BY_ENV) {
  app.commandLine.appendSwitch('force-renderer-accessibility');
}

function logAccessibilityPosture(phase: 'boot' | 'changed', supportEnabled: boolean): void {
  const features = resolveAccessibilityFeatures(
    app.getAccessibilitySupportFeatures?.bind(app),
    (error) =>
      getRootDesktopLogger().warn(
        { event: 'desktop.accessibility.features-unreadable', phase, err: error },
        'could not read accessibility support features',
      ),
  );
  getRootDesktopLogger().info(
    accessibilityPostureFacts({
      phase,
      supportEnabled,
      features,
      forcedByEnv: A11Y_FORCED_BY_ENV,
    }),
    'renderer accessibility posture',
  );
}

function logBootAccessibilityPosture(): void {
  try {
    logAccessibilityPosture('boot', app.isAccessibilitySupportEnabled());
  } catch (error) {
    getRootDesktopLogger().warn(
      { event: 'desktop.accessibility.boot-posture-failed', err: error },
      'could not record boot accessibility posture',
    );
  }
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

  const bootStateSnapshot = loadAppState();

  rendererReadySink = createRendererReadySink(
    ipcMain,
    ['ok:mcp-wiring:renderer-ready', 'ok:onboarding:renderer-ready'],
    {
      debug: (msg, ctx) => getLogger('renderer-ready-sink').debug(ctx ?? {}, msg),
      warn: (msg, ctx) => getLogger('renderer-ready-sink').warn(ctx ?? {}, msg),
    },
  );

  startLocalCrashReporter(crashReporter);
  crashDetection = createCrashDetection({
    sentinelPath: join(app.getPath('userData'), 'bug-report-dirty-shutdown.json'),
    ackStorePath: join(app.getPath('userData'), 'bug-report-crash-acks.json'),
    crashDumpsDir: app.getPath('crashDumps'),
    appBundleRoot: appBundleRootFromExecutable(app.getPath('exe')),
    appVersion: app.getVersion(),
    emit: (event) => {
      const focused = BrowserWindow.getFocusedWindow();
      const candidates = focused
        ? [focused, ...BrowserWindow.getAllWindows()]
        : BrowserWindow.getAllWindows();
      for (const win of candidates) {
        const contents = win.webContents;
        if (contents.isDestroyed() || contents.isCrashed() || contents.isLoading()) continue;
        sendToRenderer(contents, 'ok:bug-report:crash-detected', event);
        return true;
      }
      return false;
    },
    now: () => new Date(),
    currentBootSessionUuid: readBootSessionUuid,
    installInFlight: (span) =>
      installWasInFlightDuring(
        bootStateSnapshot,
        span,
        bootStateSnapshot.versionPendingInstallStagedAt,
      ),
    logger: getLogger('crash-detection'),
  });
  crashDetection.detectBootCrash();
  rendererRecovery = createRendererRecovery({
    now: () => Date.now(),
    logger: getLogger('renderer-recovery'),
    defer: (fn) => {
      setImmediate(fn);
    },
    promptManualRecovery: (contents, info) => {
      const log = getLogger('renderer-recovery');
      const target = BrowserWindow.fromWebContents(contents as unknown as WebContents);
      const options: MessageBoxOptions = {
        type: 'warning',
        title: 'This window stopped responding',
        message: 'This window stopped responding',
        detail:
          'OpenKnowledge reloaded it once and it stopped again. Your documents and any running agents live in the OpenKnowledge server rather than in this window, so reloading restores the view without interrupting them.',
        buttons: ['Reload', 'Not Now'],
        defaultId: 0,
        cancelId: 1,
      };
      const reloadGuarded = (event: string) => {
        if (contents.isDestroyed()) return;
        try {
          contents.reload();
        } catch (err: unknown) {
          log.warn({ event, reason: info.reason, err }, 'renderer reload threw past the guard');
        }
      };
      return (target ? dialog.showMessageBox(target, options) : dialog.showMessageBox(options))
        .then(({ response }) => {
          if (response !== 0) return;
          reloadGuarded('renderer-recovery.reload-after-confirm-failed');
        })
        .catch((err: unknown) => {
          log.warn(
            { event: 'renderer-recovery.prompt-failed', reason: info.reason, err },
            'renderer recovery prompt failed — falling back to a direct reload',
          );
          reloadGuarded('renderer-recovery.fallback-reload-failed');
        });
    },
  });
  crashSentinelHeartbeat = setInterval(
    () => crashDetection?.noteAlive(),
    SENTINEL_HEARTBEAT_INTERVAL_MS,
  );
  crashSentinelHeartbeat.unref();
  powerMonitor.on('shutdown', () => crashDetection?.noteOsShutdown());
  powerMonitor.on('suspend', () => crashDetection?.noteSuspend());
  powerMonitor.on('resume', () => crashDetection?.noteResume());
  app.on('browser-window-created', (_event, win) => {
    win.on('session-end', (event) => {
      if (crashDetection === null || osShutdownNoted) return;
      osShutdownNoted = true;
      crashDetection.noteOsShutdown(event.reasons);
      getLogger('lifecycle').info(
        { event: 'lifecycle.session-end', reasons: event.reasons },
        'the OS is ending this session — marked the sentinel before termination',
      );
      flushDesktopLogger();
    });
  });
  installSignalCleanQuit({
    process,
    markCleanQuit: () => crashDetection?.markCleanQuit(),
    quit: () => app.quit(),
    logger: getLogger('signal-clean-quit'),
  });
  void bugReportSidecar.reconcileStaleUploading();
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'Utility') {
      getServerExitRecorder().noteGoneReason(details.reason);
    }
    crashDetection?.handleChildProcessGone(details);
  });

  app.on('web-contents-created', (_event, contents) => {
    attachRendererConsoleCapture(contents);
    contents.on('render-process-gone', (_e, details) => {
      crashDetection?.handleRenderProcessGone(details);
      rendererRecovery?.handleRenderProcessGone(contents, details);
    });
    contents.once('destroyed', () => {
      rendererRecovery?.dispose(contents);
    });
    const retryDelivery = () => crashDetection?.notifyRendererReady();
    contents.on('did-finish-load', retryDelivery);
    contents.on('did-stop-loading', retryDelivery);
  });

  app.on('accessibility-support-changed', (_event, screenReaderActive) => {
    logAccessibilityPosture('changed', screenReaderActive);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDestroyed()) continue;
      sendToRenderer(win.webContents, 'ok:accessibility:changed', { screenReaderActive });
    }
  });

  app.on('did-become-active', () => {
    appIsActive = true;
    appHasEverBeenActive = true;
  });
  app.on('did-resign-active', () => {
    appIsActive = false;
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
      yieldRestoreToDeepLink();
      return wm.focusWindowForProject(projectPath) as unknown as object | null;
    },
    openProject: async (projectPath, opts) => {
      yieldRestoreToDeepLink();
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
    openEphemeralFile: (filePath) => {
      yieldRestoreToDeepLink();
      return openEphemeralFile(filePath);
    },
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
    gateForeignShareHost: async (host, sharedUrl) => {
      let authenticated = false;
      try {
        const status = await runAuthStatusSubprocess({
          cliArgs: resolveLocalOpCliArgs(),
          host,
        });
        authenticated = status.authenticated;
      } catch {}
      if (authenticated) return 'proceed';

      app.focus({ steal: true });
      const parentWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      const messageBoxOptions = {
        type: 'warning' as const,
        buttons: [`Connect to ${host}…`, 'Open in browser', 'Cancel'],
        defaultId: 2,
        cancelId: 2,
        message: `This share points at ${host}`,
        detail:
          `You aren't connected to this GitHub Enterprise Server in OpenKnowledge. ` +
          `After connecting, open the share link again to receive it.`,
      };
      const { response } = parentWindow
        ? await dialog.showMessageBox(parentWindow, messageBoxOptions)
        : await dialog.showMessageBox(messageBoxOptions);
      if (response === 0) {
        if (parentWindow) {
          (parentWindow as BrowserWindowLike).webContents.executeJavaScript(
            "window.location.hash = '#settings/account'; undefined",
          );
        } else {
          openNavigator();
        }
        return 'connect';
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        openNavigator();
      }
      if (response === 1) {
        const check = checkOutboundUrl(sharedUrl);
        if (!check.ok) {
          getLogger('share-receive').warn(
            { host, reason: check.reason },
            '[receive] refused to open share URL with disallowed scheme',
          );
          return 'cancel';
        }
        await shell.openExternal(sharedUrl);
        return 'open-browser';
      }
      return 'cancel';
    },
    checkShareTargetExists: (projectPath, kind, path) =>
      checkTargetExistsImpl(projectPath, kind, path),
    routeShareToNavigator: (payload) => {
      yieldRestoreToDeepLink();
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
      warn: (obj, msg) => getLogger('url-scheme').warn(obj, msg),
      info: (obj, msg) => getLogger('url-scheme').info(obj, msg),
      error: (obj, msg) => getLogger('url-scheme').error(obj, msg),
    },
  });

  app
    .whenReady()
    .then(async () => {
      startupWaterfall.mark('appReady');
      startupWaterfall.otelEnabled = beginRoot();
      logBootAccessibilityPosture();
      const shellEnvLogger = {
        event: (payload: Record<string, unknown> & { event: string }) =>
          getLogger('shell-env').info(payload, payload.event),
      };
      const authSockHarvest = harvestShellAuthSock({ logger: shellEnvLogger });
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
        installDockIcon: () => installDockIcon(instanceLabel),
        log: { warn: (msg, obj) => console.warn(msg, obj) },
        appVersion: app.getVersion(),
        maxSupportedSchemaVersion: MAX_SUPPORTED_SCHEMA_VERSION,
      });
      appState = result.appState;

      if (process.platform !== 'darwin') {
        nativeTheme.on('updated', fanOutChromeColors);
      }

      void registerAppImageDeepLinks({
        platform: process.platform,
        isPackaged: app.isPackaged,
        env: process.env,
        homeDir: osHomedir(),
        log: {
          info: (obj, msg) => getLogger('lifecycle').info(obj as Record<string, unknown>, msg),
          warn: (obj, msg) => getLogger('lifecycle').warn(obj as Record<string, unknown>, msg),
        },
      }).then((result) => {
        if (result.status === 'failed') {
          getLogger('lifecycle').warn(result, '[appimage-integration] registration failed');
        }
      });
      pendingSchemaIncompatibility = result.pendingSchemaIncompatibility;
      firstLaunchAfterUpgrade = computeFirstLaunchAfterUpgrade(
        appState.lastSeenVersion,
        app.getVersion(),
      );
      startupWaterfall.mark('bootstrapDone');

      app.on('browser-window-created', (_event, win) => {
        win.webContents.once('did-finish-load', () => {
          if (!(app.isPackaged || process.env.OK_UPDATER_FORCE_DEV === '1')) return;
          const pending = appState.versionPendingInstall;
          if (pending && !autoUpdaterHandle?.isWithinPostUpdateQuietWindow()) {
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
        ensureCliOnPath(buildEnsureCliOnPathOpts()),
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

      applyHarvestedAuthSock(process.env, await authSockHarvest, shellEnvLogger);

      const decision = await resolveBootRestoreDecision({
        pendingRestore: appState.pendingWindowRestore,
        lastOpenedProject: appState.lastOpenedProject,
        optionHeld: process.argv.includes('--navigator'),
        pathExists: existsSync,
        urlLaunchOwnsWindow: protocolControl.urlLaunchOwnsWindow,
        waitForUrlLaunchSettled: protocolControl.waitForUrlLaunchSettled,
      });
      const snapshotWindowCount = appState.pendingWindowRestore?.length ?? 0;
      getLogger('startup').info(
        {
          urlLaunch: protocolControl.urlLaunchOwnsWindow(),
          action: decision.action,
          snapshotWindowCount,
        },
        'boot-restore decision',
      );
      if (decision.clearSnapshot) {
        appState = { ...appState, pendingWindowRestore: null };
        if (!saveAppState(appState)) {
          console.warn('[main] failed to persist cleared window-restore snapshot', {
            windowCount: snapshotWindowCount,
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
        const { orderedKeys, actionByKey } = resolveRestoreActions(decision.windows, (filePath) => {
          try {
            const plan = prepareSingleFileOpen(filePath);
            return plan.mode === 'project'
              ? { kind: 'project', projectPath: plan.projectRoot }
              : { kind: 'file', filePath };
          } catch {
            return null;
          }
        });

        restoreRevealInactive = true;

        const docActions = orderedKeys
          .map((key) => actionByKey.get(key))
          .filter((action) => action?.kind === 'doc');
        const opens = orderedKeys.map((key) => {
          const action = actionByKey.get(key);
          if (action === undefined || action.kind === 'doc') return Promise.resolve();
          return action.kind === 'project'
            ? openProjectOrFallbackToNavigator(action.projectPath, 'recents')
            : openEphemeralFile(action.filePath);
        });
        void Promise.allSettled(opens)
          .then(() => {
            for (const action of docActions) {
              try {
                restoreNoteWindow(action);
              } catch (err) {
                getLogger('note-window').warn(
                  { err },
                  'failed to restore a note window on relaunch',
                );
              }
            }
          })
          .then(() => {
            if (deepLinkClaimedWindowDuringRestore) return undefined;
            return raiseMostRecentlyFocusedAfterRestore({
              windowKeys: orderedKeys,
              getWindow: (key) => {
                const ctx = wm?.getWindowFor(key);
                return ctx ? (ctx.window as unknown as RevealableWindow) : undefined;
              },
              raise: (key, opts) => {
                wm?.focusWindowForProject(key, opts);
              },
              shouldActivate: () => appIsActive,
              deps: {
                setTimeout: (cb, ms) => setTimeout(cb, ms),
                clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
                timeoutMs: RESTORE_REVEAL_TIMEOUT_MS,
              },
            });
          })
          .catch((err: unknown) => {
            getLogger('startup').warn(
              {
                event: 'restore-raise-failed',
                targetKey: orderedKeys[orderedKeys.length - 1],
                windowCount: orderedKeys.length,
                err,
              },
              'post-restore raise threw — windows are up but foreground order may be wrong',
            );
          })
          .finally(endRestoreQuietReveal);
      } else if (decision.action === 'lastOpened') {
        void openProjectOrFallbackToNavigator(decision.project, 'recents');
      } else if (decision.action === 'navigator') {
        openNavigator();
      } else {
        protocolControl.drainQueuedUrls();
      }

      if (isTrueFirstRun && decision.action === 'navigator') {
        const shareReceiveLogger = getLogger('share-receive');
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
              shareReceiveLogger.warn(
                { errorKind: err instanceof Error ? err.name : typeof err },
                'deferred-share openExternal failed',
              );
            });
          },
          routeShareUrl: (url) => protocolControl.routeUrl(url),
          recordOutcome: (outcome) => recordFirstRunShareHandoff(outcome),
          log: {
            warn: (obj, msg) => shareReceiveLogger.warn({ ...obj }, msg),
            info: (obj, msg) => shareReceiveLogger.info({ ...obj }, msg),
          },
        });
      }

      void reclaimUserSkillsOnLaunch(buildReclaimUserSkillsOpts()).catch((err) => {
        console.warn('[main] user-skill reclaim failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });

      maybeRunDesktopUninstallUiPreview();

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
        ...(process.platform === 'linux'
          ? {
              linuxInstallSupport: {
                hasGraphicalAuth: () => detectGraphicalAuthCommand() !== null,
                stagedInstallerExists: (p) => {
                  try {
                    return existsSync(p);
                  } catch {
                    return false;
                  }
                },
                showManualInstallFallback: async (ctx) => {
                  await runManualInstallFallbackDialog(
                    {
                      showDialog: async (request) => {
                        const target =
                          BrowserWindow.getFocusedWindow() ??
                          BrowserWindow.getAllWindows()[0] ??
                          null;
                        const options = { type: 'info' as const, ...request };
                        return target
                          ? dialog.showMessageBox(target, options)
                          : dialog.showMessageBox(options);
                      },
                      copyCommandToClipboard: (command) => clipboard.writeText(command),
                      relaunchApp: () => {
                        app.relaunch();
                        app.quit();
                      },
                    },
                    ctx,
                  );
                },
              },
            }
          : {}),
        ...(app.isPackaged
          ? {
              reclaimStagedUpdateCache: () =>
                reclaimPendingUpdateCache({
                  appUpdateConfigPath: join(process.resourcesPath, 'app-update.yml'),
                  platform: process.platform,
                  env: process.env,
                  homeDir: osHomedir(),
                  logger: {
                    info: (msg, ctx) => getLogger('updater-cache').info(ctx ?? {}, msg),
                    warn: (msg, ctx) => getLogger('updater-cache').warn(ctx ?? {}, msg),
                    debug: (msg, ctx) => getLogger('updater-cache').debug(ctx ?? {}, msg),
                  },
                }),
            }
          : {}),
        prepareForRelaunch: async () => {
          freezeFocusTracking('prepare-for-relaunch');
          captureWindowRestoreSnapshot('prepare-for-relaunch');
          await terminalReaper?.killAll();
          await wm?.stopAllOwnedServers();
          flushDesktopLogger();
        },
        sweepUpdateSurvivors: sweepConsoleHostsBeforeUpdate,
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
          } else if (result.kind === 'ready-to-install') {
            void dialog.showMessageBox(target, {
              type: 'info',
              buttons: ['OK'],
              defaultId: 0,
              title: 'Update Ready',
              message: `OpenKnowledge ${result.stagedVersion} is downloaded and ready.`,
              detail: `It installs the next time you relaunch. Any newer build is offered after that.`,
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
    freezeFocusTracking('before-quit');
    captureWindowRestoreSnapshot('before-quit');
    autoUpdaterHandle?.recordInstallHandoffOnQuit();
    emitStartupWaterfall();
    endRoot();
    flushDesktopLogger();
  });
  electronAutoUpdater.on('before-quit-for-update', () => {
    getLogger('updater').info({}, 'before-quit-for-update — update install will relaunch the app');
    freezeFocusTracking('before-quit-for-update');
    captureWindowRestoreSnapshot('before-quit-for-update');
    void (terminalReaper?.killAll() ?? Promise.resolve()).then(() => {
      const result = sweepConsoleHostsBeforeUpdate();
      if (result.scanFailed || result.revalidationFailed || result.failedCount > 0) {
        getLogger('updater').warn(
          { result },
          'Silent update console-host sweep incomplete — continuing shutdown',
        );
      }
    });
    wm?.signalStopAllOwnedServers();
    flushDesktopLogger();
  });

  const runTerminalQuitDrain = createTerminalQuitDrain({
    defer: (callback) => setImmediate(callback),
    drain: async () => {
      const [terminalResult] = await Promise.allSettled([
        terminalReaper?.killAll() ?? Promise.resolve(),
        slidesDeckRegistry.reapAll(),
      ]);
      if (terminalResult.status === 'rejected') {
        getLogger('lifecycle').warn({ err: terminalResult.reason }, 'terminal quit drain failed');
      }
    },
    resumeQuit: () => app.quit(),
  });
  app.on('will-quit', (event) => {
    if (runTerminalQuitDrain(event)) return;
    getLogger('lifecycle').info({}, 'will-quit');
    crashDetection?.markCleanQuit();
    if (crashSentinelHeartbeat !== null) {
      clearInterval(crashSentinelHeartbeat);
      crashSentinelHeartbeat = null;
    }
    rendererRecovery = null;
    dockVisibleForWindow.clear();
    agentPanelVisibleForWindow.clear();
    dockOrderForWindow.clear();
    terminalSnapshotForWindow.clear();
    autoUpdaterHandle?.destroy();
    autoUpdaterHandle = null;
    bundleReplaceWatcherHandle?.stop();
    bundleReplaceWatcherHandle = null;
    mcpWiringHandle?.destroy();
    mcpWiringHandle = null;
    rendererReadySink?.destroy();
    rendererReadySink = null;
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
}

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
