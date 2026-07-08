/**
 * Main-process entry for `@inkeep/open-knowledge-desktop`.
 *
 * Boot sequence (the prefix of `app.whenReady()` is owned by `runBootstrap`
 * in `./bootstrap.ts`):
 *   1. app.whenReady()
 *   2. runBootstrap(deps)
 *      a. loadAppState + evaluateSchemaCompatibility
 *      b. installLocalhostCorsInjector
      b'. installEmbedRefererRewriter (Referer fix for YouTube embeds under file://)
 *      c. registerIpcHandlers — must precede (d) so the renderer's
 *         `ok:theme:set-source` / `ok:theme:applied` channels are reachable
 *         when the renderer mounts
 *      d. nativeTheme.themeSource = 'system' — must precede any window
 *         construction so the cold-launch chrome correctness contract holds
 *      e. refreshApplicationMenu + installDockIcon
 *   3. armMcpWiring (first-launch MCP consent flow)
 *   4. If lastOpenedProject set AND not Option-held → open editor for that project
 *      Else → open Navigator window
 *   5. installUserSkill (idempotent global skill install)
 *   6. bootAutoUpdater (wired last so update toasts find a real window)
 *   7. macOS Dock icon click → re-open Navigator
 *
 * Process model: one BrowserWindow ↔ one utilityProcess ↔ one Hocuspocus
 * server ↔ one contentDir. The window manager owns spawn/teardown; this
 * entry wires it into Electron lifecycle + IPC handlers.
 */

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
  HOSTS_WITH_USER_SKILL_DIR,
  isEntryUpToDate,
  isOwnManagedEntry,
  type McpInstallOptions,
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
  CLIENT_VERSION_HEADER,
  PROTOCOL_VERSION,
  ServerInfoSuccessSchema,
  SPAWN_ERROR_LOG,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import {
  assertGitAvailable,
  BUNDLE_SKILL_NAME,
  classifyFsPath,
  createEphemeralProjectDir,
  discoverLockDirs,
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
  readBundleDecision,
  readServerLock,
  readServerPackageVersion,
  recordSkillInstallEvent,
  resolveBundledSkillDir,
  resolveLockDir,
  USER_GLOBAL_BUNDLE_IDS,
  withSpan,
  writeBundleDecision,
  writeTargetVersion,
} from '@inkeep/open-knowledge-server';
import type { BrowserWindowConstructorOptions, MessageBoxOptions } from 'electron';
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
import { resolveBootRestoreDecision } from './boot-restore-decision.ts';
import { runBootstrap } from './bootstrap.ts';
import {
  type BranchInfoProxyDeps,
  proxyAwaitBranchSwitched,
  proxyFetchBranchInfo,
  proxyRunCheckout,
  proxyShareTargetStatus,
} from './branch-info-proxy.ts';
import { wrapperPathInBundle } from './bundle-paths.ts';
import {
  type BundleReplaceWatcherHandle,
  startBundleReplaceWatcher,
} from './bundle-replace-detector.ts';
import { cascadePosition } from './cascade-position.ts';
import {
  checkTargetExists as checkTargetExistsImpl,
  computeShareTargetMissing,
} from './check-target-exists.ts';
import {
  cliProbeArgs,
  resolveClaudeReadiness,
  resolveCliInstalledMap,
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
import {
  buildDesktopUninstallNoticeHtml,
  buildDesktopUninstallProgressHtml,
  buildDesktopUninstallProjectPickerHtml,
  collectDesktopUninstallProjectCandidates,
  type DesktopUninstallNoticeSpec,
  type DesktopUninstallProjectCandidate,
  defaultDesktopUninstallLogPath,
  desktopUninstallCompletionNotice,
  desktopUninstallConfirmNotice,
  desktopUninstallFailureNotice,
  desktopUninstallFinalStepNotice,
  isSupportedApplicationsBundle,
  parseDesktopUninstallNoticeUrl,
  parseDesktopUninstallProjectPickerUrl,
  readDesktopUninstallLogForDisplay,
  resolveAppBundleFromExecPath,
  resolveDesktopUninstallProjectSelection,
  runDesktopUninstallCleanup,
} from './desktop-uninstall.ts';
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
import { registerIntegrationsSettings } from './integrations-settings.ts';
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
import { createDesktopKeepaliveFactory, toKeepaliveLogger } from './keepalive.ts';
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
import {
  computePathInstallDescriptor,
  computePathLeg,
  type EnsureCliOnPathResult,
  ensureCliOnPath,
  isPathShimInstalled,
  removePathShimFromRcFiles,
} from './path-install.ts';
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
import { beginRoot, childSpan, endRoot, injectTraceparent } from './startup-trace.ts';
import { type RendererMarks, StartupWaterfall } from './startup-waterfall.ts';
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
import {
  classifyRecentGit,
  classifyRecentGitAsync,
  readWorktreeBranchAsync,
} from './worktree-recents.ts';
import { createWorktree, listWorktreeSelector } from './worktree-service.ts';

// Modern macOS chrome treatment. Three architectural facts the field set
// encodes:
//   - `show: false` defers OS-level visibility to the show-gate registry
//     (`./show-gate.ts`), which AND-gates `BrowserWindow.show()` on both
//     `ready-to-show` and the renderer's `ok:theme:applied` IPC event.
//     Removing it lets the OS surface the window before chrome is theme-
//     correct on cold launch.
//   - `titleBarStyle: 'hiddenInset'` removes the OS-drawn title bar so
//     `EditorHeader` is the chrome row directly. Traffic lights stay native
//     and inset-positioned to match VS Code / Cursor / Linear.
//   - `vibrancy: 'sidebar'` + `visualEffectState: 'followWindow'` paints an
//     `NSVisualEffectView` material under the whole window. Electron auto-
//     tracks `nativeTheme.themeSource`, so the chrome flips theme atomically
//     with the renderer body — no `setBackgroundColor` fan-out is needed
//     (under `transparent: true` it's a no-op anyway).
//   - `transparent: true` lets the vibrancy material extend to window edges
//     without an opaque sub-frame, eliminating trailing-edge artifacts during
//     resize. First-paint pixel correctness lives in `packages/app/index.html`'s
//     inline `<style>`, whose `__OK_CHROME_BG_*__` placeholders are
//     build-substituted by `chrome-tokens-vite-plugin.ts` from the resolved
//     `--sidebar` Tailwind token.
// Default vibrancy material — `VibrancyMaterial` is the canonical narrow
// union from `reduced-transparency-handler.ts`. Pinning here lets the
// prefers-reduced-transparency restore path re-enable to the same material
// without a wider cast. `'sidebar'` is the chosen material; `'window'` is
// the documented fallback if the Electron #27882 border quirk recurs on a
// future Electron upgrade.
const VIBRANCY_DEFAULT: VibrancyMaterial = 'sidebar';

// Chrome stack scoped to darwin; other platforms deferred. Electron applies
// `titleBarStyle: 'hiddenInset'` / `vibrancy` / `visualEffectState` /
// `transparent` / `trafficLightPosition` on every platform that supports
// them — un-gated, a Linux/Windows developer running the desktop dev
// command today gets a frameless transparent window with no usable chrome.
// Conditional spread keeps the fields off non-darwin runners. `resizable`
// stays at Electron's default true: the editor needs drag-resize, and the
// transparent-windows-not-resizable note in Electron's
// custom-window-styles tutorial has not surfaced on Electron 41.x macOS in
// dogfooding (verified via the smoke matrix). If a future Electron upgrade
// regresses this, the smoke job will catch it before users do.
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

// Editor windows in creation order, for cascade placement. `DEFAULT_WIN_OPTS`
// carries no x/y, so Electron centers every window — N windows opened in a
// burst (the post-update relaunch restore) land in one indistinguishable
// stack. Each new editor window instead offsets down-right from the focused
// window (or, while restored windows are still hidden behind the show gate
// and nothing is focused, the most recently created one).
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

/**
 * Production WS-upgrade probe — opens a fresh `WebSocket(url)`, resolves
 * `true` on `open`, `false` on `close` / `error` / timeout. Used by the
 * window-manager attach gate to refuse servers that lie about WS readiness
 * (HTTP responding but `/collab` upgrade hung). The deadline must comfortably
 * exceed loopback handshake latency (sub-millisecond on healthy local stacks)
 * but stay well under the 30 s `SyncTimeoutError` we're defending against.
 */
function probeWsUpgrade(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // Best-effort — close on a not-yet-connected socket throws on some
        // platforms; we already have our verdict.
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

/**
 * Quarantine a corrupt `state.json` to a timestamped sibling and log so
 * operations can correlate "recents disappeared" reports to the corruption
 * event. Pure I/O — the return value is `emptyState()` either way; the
 * side effects are the log line and the `state.json.corrupt-<ts>` file.
 * Extracted so both the JSON-parse-failure branch and the schema-invalid
 * branch route through the same treatment.
 */
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
    // Unparseable JSON (truncated write, manual hand-edit gone wrong).
    quarantineCorruptState(statePath, 'unparseable-json', err);
    return emptyState();
  }
  // Schema-invalid (parseable JSON but wrong root type / missing required
  // fields): route through the same quarantine treatment as the unparseable
  // branch so silent-fallback-on-corrupt-state doesn't lose recents + auto-
  // update gates without a trace. Left unquarantined would re-arm Toast B on
  // the next update for a version the user has been running for months.
  const parsed = parseAppState(raw);
  if (!parsed) {
    quarantineCorruptState(statePath, 'schema-invalid');
    return emptyState();
  }
  return parsed;
}

/**
 * Persist app state atomically via the pure helper in `state-store.ts` —
 * separation so the atomic-write behavior can be unit-tested without
 * Electron's `app` module (`app.getPath('userData')` is the sole Electron
 * dependency). Returns the disk-persist success boolean so callers that
 * need rollback semantics can distinguish in-memory-only updates from
 * fully-persisted ones; callers that don't care get the same silent
 * behavior by ignoring the return.
 */
function saveAppState(state: AppState): boolean {
  return saveAppStateToDir(app.getPath('userData'), state);
}

let appState: AppState = emptyState();
/**
 * Set at boot when the persisted state's `schemaVersion` exceeds
 * `MAX_SUPPORTED_SCHEMA_VERSION` — the running build was rolled back to from
 * a future build (typically a beta) that wrote a state shape this build
 * cannot safely parse. Renderer surfaces (refuse-downgrade Toast / dialog)
 * read via `getPendingSchemaIncompatibility()` on mount.
 */
let pendingSchemaIncompatibility: SchemaIncompatibilityDiagnostic | null = null;
export function getPendingSchemaIncompatibility(): SchemaIncompatibilityDiagnostic | null {
  return pendingSchemaIncompatibility;
}
/**
 * Drop the pending diagnostic so subsequent `ok:state:query` calls return
 * `null` for `schemaIncompatibility`. Called from the refuse-downgrade UX's
 * explicit reset (`ok:state:reset-incompatible`). Silent no-op if no
 * diagnostic was set.
 */
export function clearPendingSchemaIncompatibility(): void {
  pendingSchemaIncompatibility = null;
}

/**
 * Toggle app-wide spell checking from either surface (the in-editor context
 * menu or the Edit-menu checkbox). Updates the live session, persists the flag,
 * and rebuilds the application menu so the menu-bar checkmark tracks the new
 * state. Single source so both surfaces stay consistent.
 */
function setSpellCheckEnabledAppWide(enabled: boolean): void {
  session.defaultSession.setSpellCheckerEnabled(enabled);
  appState = setSpellCheckEnabledState(appState, enabled);
  saveAppState(appState);
  refreshApplicationMenu();
}

/**
 * Apply the persisted spell-check flag to the shared session and attach the
 * native editor context menu to a window. Called at each window-creation site.
 * The flag is read fresh per right-click via the `appState` closure. Why one
 * app-wide flag: see `AppState.spellCheckEnabled` in state-store.ts.
 */
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
/**
 * Module-scoped reap surface of the docked-terminal PTY mediator, published by
 * `registerIpcHandlers` (which runs before any window is created). Lifted out
 * of that function so the editor-window factory can wire each window's
 * `'closed'` → per-window reap and the `will-quit` handler can reap them all.
 * Null only before `registerIpcHandlers` runs, which precedes any window or
 * quit — callers guard with `?.` / a truthiness check.
 */
let terminalReaper: TerminalReaper | null = null;
/**
 * Per-window docked-terminal visibility, recorded from the renderer's view-menu
 * push so a reloaded renderer can restore an expanded dock. Keyed by windowId
 * (multi-window safe) with the same lifetime as the window's PTY sessions —
 * cleared on window-close and app-quit, so a fresh launch with no surviving
 * sessions restores nothing and the dock correctly stays hidden.
 */
const dockVisibleForWindow = new Map<number, boolean>();
/**
 * Singleton show-gate registry — coordinates window.show() against the
 * dual-signal contract (`ready-to-show` + `ok:theme:applied`). Module-level
 * so the IPC handler at registerIpcHandlers (registered before any window
 * exists) and the editor + Navigator factories all share the same instance.
 * Pure state + a setTimeout closure; no Electron import.
 */
/**
 * Module-level launch-waterfall aggregator. Always on (cost is a Map of
 * numbers + one log line). `otelEnabled` is filled in at `app.whenReady()` once
 * `beginRoot()` reports whether the main-process OTel root stood up (Plan A) or
 * degraded (Plan B); until then it reads false. Only the FIRST project window
 * of the launch stamps `windowShown` + emits — see `firstWindowShown`.
 */
const startupWaterfall = new StartupWaterfall({ otelEnabled: false });
let firstWindowShown = false;
let waterfallDeadlineTimer: ReturnType<typeof setTimeout> | undefined;

/** Emit the timeline once (idempotent) and end the OTel root. */
function emitStartupWaterfall(): void {
  if (waterfallDeadlineTimer !== undefined) {
    clearTimeout(waterfallDeadlineTimer);
    waterfallDeadlineTimer = undefined;
  }
  const payload = startupWaterfall.emit({
    info: (obj, msg) => getLogger('startup').info(obj, msg),
  });
  // `emit` returns a payload only on the first successful call, so this closes
  // the trace exactly once.
  if (payload !== undefined) {
    // Replay the main-process phases as child spans under the launch root, so
    // the trace shows the main-side launch (app-ready → bootstrap → spawn →
    // shown) and not just the server `ok.boot` child. No-op when Plan A
    // degraded. Children first — `endRoot` clears the context they parent into.
    if (startupWaterfall.otelEnabled) {
      for (const phase of startupWaterfall.mainPhaseIntervals()) {
        childSpan(phase.name, {}, phase.startMs, phase.endMs);
      }
    }
    // End the OTel root at the same logical point the timeline closes.
    endRoot();
  }
}

/**
 * Called from the show-gate the instant the first project window becomes
 * visible. Marks `windowShown`, then either emits now (best-effort inputs
 * already present) or arms a short deadline so a missing server-info fetch /
 * renderer report can't withhold the line indefinitely.
 */
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
/**
 * Fetch `GET /api/server-info` once at launch and fold the server boot timings
 * into the waterfall. Best-effort: a fetch failure / missing `boot` (dev-server
 * path) just leaves the server fields absent. If the window is already shown
 * (deadline path or fast launch), re-check the emit so the line can fire as
 * soon as the boot data lands.
 */
function maybeFetchServerBoot(apiOrigin: string): void {
  if (serverBootFetched) return;
  serverBootFetched = true;
  void (async () => {
    try {
      // Bind the fetch lifetime to the waterfall flush deadline: if the server
      // hangs after lock-ready but before responding, the deadline emits the
      // line without server data anyway, and this releases the socket at the
      // same wall-clock point rather than holding it open until process exit.
      const res = await fetch(`${apiOrigin}/api/server-info`, {
        signal: AbortSignal.timeout(startupWaterfall.flushDeadlineMs),
      });
      if (!res.ok) return;
      const parsed = ServerInfoSuccessSchema.safeParse(await res.json());
      if (!parsed.success || parsed.data.boot === undefined) return;
      // No cast: `parsed.data.boot` (core's `ServerInfoBoot`) must stay
      // structurally assignable to the waterfall's `ServerBootTimings`; if the
      // two ever drift, tsc fails here rather than silently coercing.
      startupWaterfall.ingestServerBoot(parsed.data.boot);
      if (firstWindowShown && startupWaterfall.canEmit) emitStartupWaterfall();
    } catch {
      // Server-info fetch is best-effort instrumentation — never surface.
    }
  })();
}

/** Fold renderer launch marks into the waterfall, re-checking emit. */
function ingestRendererStartupMarks(marks: RendererMarks): void {
  startupWaterfall.ingestRendererMarks(marks);
  if (firstWindowShown && startupWaterfall.canEmit) emitStartupWaterfall();
}

const showGate: ShowGateRegistry = createShowGateRegistry({
  log: {
    warn: (obj, msg) => {
      console.warn(JSON.stringify({ ...obj, msg }));
    },
  },
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // Startup waterfall: first shown window stamps `windowShown` + emits.
  onShown: () => onFirstWindowShown(),
});

/**
 * Deps for the prefers-reduced-transparency runtime path. The renderer's
 * matchMedia listener pushes `reducedTransparency` via the existing
 * `ok:theme:applied` channel; the handler iterates BrowserWindow instances
 * and toggles vibrancy material — `null` to disable, the cold-launch
 * material (`VIBRANCY_DEFAULT`) to re-enable.
 *
 * `getAllWindows` casts through `unknown` so the structural
 * `BrowserWindowVibrancyTarget` shape doesn't depend on Electron's type;
 * tests inject a captured-array stub instead. Same precedent as the
 * `BrowserWindowLike` cast pattern in window-manager + show-gate.
 */
const reducedTransparencyDeps: ReducedTransparencyDeps = {
  getAllWindows: () =>
    BrowserWindow.getAllWindows() as unknown as readonly BrowserWindowVibrancyTarget[],
  defaultVibrancy: VIBRANCY_DEFAULT,
  warn: (line) => {
    console.warn(line);
  },
};
/**
 * Auto-updater handle — single instance per app launch. Wired at the end of
 * `app.whenReady()` and torn down on `app.on('will-quit')` per the canonical
 * shutdown ordering. Null before whenReady and after destroy.
 */
let autoUpdaterHandle: StartAutoUpdaterHandle | null = null;
/**
 * Mid-session drag-replace detector. macOS-only (the bug is AppKit-specific).
 * Periodically compares the on-disk Info.plist version against
 * `app.getVersion()`; surfaces a "Restart to finish" prompt when they diverge.
 * Null in dev, on non-macOS, or before whenReady.
 */
let bundleReplaceWatcherHandle: BundleReplaceWatcherHandle | null = null;
let debugIpc: DebugIpcHandle | null = null;
/**
 * First-launch MCP consent handle. Armed by `runMcpWiringOnFirstLaunch`
 * inside `app.whenReady()` when the user-scoped marker is absent; torn down
 * on `app.on('will-quit')` so IPC handlers don't outlive the app. Null
 * when the wiring no-ops (marker present, dev mode, non-macOS, etc.).
 */
let mcpWiringHandle: RunMcpWiringHandle | null = null;

/**
 * Active-editor target snapshot pushed by the renderer via
 * `ok:editor:active-target-changed`. Drives the macOS File menu's state-aware
 * item-management section — when the renderer navigates to a new doc /
 * folder / asset / null state, main rebuilds the menu so Rename /
 * Duplicate / Move to Trash flip enabled/disabled per scope.
 *
 * Module-scope rather than per-window because the menu is a singleton
 * (`Menu.setApplicationMenu` replaces the global menu). Last-write-wins
 * across multiple project windows — matches the existing recent-projects
 * pattern at `appState.recentProjects`.
 */
let editorActiveTarget: EditorActiveTargetSnapshot = { kind: null };

/**
 * View-menu state pushed by the renderer via
 * `ok:editor:view-menu-state-changed`. Drives the View menu's checkbox
 * reflection for the visibility toggles and the smart-hide on Expand All /
 * Collapse All. Module-scope rather than per-window for the same reason
 * `editorActiveTarget` is — the menu is a singleton. Defaults match the
 * renderer's resolved defaults so the View menu reflects the right state
 * before the first renderer push lands: Show hidden files off, and both
 * Expand/Collapse rendered (no smart-hide) so the items are reachable.
 */
let editorViewMenuState: EditorViewMenuStateSnapshot = {
  showHiddenFiles: false,
  canExpandAll: true,
  canCollapseAll: true,
  // Initial menu-label assumption before the first renderer push lands.
  // FileSidebar / EditorArea push the actual resolved state on mount (the
  // renderer computes it synchronously from the partition resolver), but
  // until then the View-menu items default to "Hide …" — matching the
  // common wide-window startup where both sidebars resolve to expanded.
  sidebarVisible: true,
  docPanelVisible: true,
  // Terminal starts hidden — the View menu reads "Show Terminal" until the
  // renderer pushes its first terminal-visibility snapshot.
  terminalVisible: false,
  // No session is mounted until the user first opens the dock, so the Terminal
  // menu's "Kill Terminal" item stays disabled until the renderer reports live.
  terminalLive: false,
};

/**
 * electron-vite dev-server URL. Set by `electron-vite dev` at launch time.
 * When present, `loadURL(rendererDevUrl)` → live HMR via the Vite dev server
 * (configured in `electron.vite.config.ts` to serve `packages/app/`). When
 * absent (packaged / prod), fall back to `loadFile(rendererEntryPath)`.
 */
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL ?? null;

/**
 * Runtime gate for the debug keyring-smoke channel. Returns true when the
 * app is not packaged (dev mode) OR the opt-in env var is set.
 */
function isDebugKeyringSmokeAllowed(): boolean {
  return !app.isPackaged || process.env.OK_DEBUG_KEYRING_SMOKE === '1';
}

/**
 * Derive the `cliArgs` for spawning the local-op CLI subprocess. Both
 * desktop spawn paths — the Navigator IPC handlers (`LocalOpDeps.resolveCliArgs`)
 * and the editor window's utility-process API server (threaded via
 * `UtilityInitMessage.opts.localOpCliArgs`) — call this so they stay in
 * lockstep. Packaged: bundled wrapper at
 * `<bundle>/Contents/Resources/cli/bin/ok.sh`. Dev: `open-knowledge` from
 * PATH, matching `createApiExtension`'s default.
 */
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
        // already quitting
      }
    },
    setTimeout: (fn, ms) => {
      setTimeout(fn, ms);
    },
    utilityEntryPath: join(__dirname, 'utility/server-entry.js'),
  });
}

/**
 * Appends the `--ok-debug-keyring-smoke=1` argv flag when the gate allows it,
 * so the preload can populate `bridge.debug`. Preload reads the flag via
 * `parseArg` just like the other window-bound config fields.
 */
function withDebugFlagIfAllowed(args: readonly string[]): string[] {
  const withDebug = isDebugKeyringSmokeAllowed()
    ? [...args, '--ok-debug-keyring-smoke=1']
    : [...args];
  // Under the Electron smoke suite, force xterm's DOM renderer (not the WebGL
  // canvas) via this flag — the canvas can't be read by the DOM-based smoke
  // assertions and captures focus from synthetic keystrokes. Gating only xterm
  // (vs a blanket --disable-gpu) keeps Electron GPU acceleration on, so the
  // suite doesn't trigger whole-app software rendering that starves CPU on
  // constrained CI runners. See TerminalPanel's WebGL gate.
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
  // Renderer entry (prod path): electron-builder copies packages/cli/dist/public/ to
  // <Resources>/app/, so the renderer is at process.resourcesPath/app/index.html.
  // Dev path: we prefer rendererDevUrl (electron-vite's Vite dev server serving
  // packages/app/), falling back to the local shell only when dev-server URL is
  // unset (e.g., running out/main/index.js directly without `electron-vite dev`).
  const rendererEntryPath = app.isPackaged
    ? join(process.resourcesPath, 'app', 'index.html')
    : join(__dirname, '../renderer/index.html');
  // Utility entry: electron-vite piggybacks the utility build into main's
  // bundle (see electron.vite.config.ts main.build.rollupOptions comment),
  // so it lands at `out/main/utility/server-entry.js` — same folder tree as
  // `out/main/index.js`, nested one level deeper. Not `out/utility/...`.
  const utilityEntryPath = join(__dirname, 'utility/server-entry.js');

  // Detached-spawn wiring — packaged builds only (dev keeps the
  // utility-fork path for HMR / log-capture ergonomics). The bundled CLI
  // lives at `<.app>/Contents/Resources/app.asar.unpacked/node_modules/
  // @inkeep/open-knowledge/dist/cli.mjs`. We spawn it via the running
  // Electron binary with `ELECTRON_RUN_AS_NODE=1` so the helper runs as
  // pure Node — no separate Node binary to bundle. The child detaches
  // from Electron's process group (`detached: true`, `stdio: 'ignore'`,
  // `.unref()`) so it survives Electron parent exit; the invariant
  // (closing windows / quitting the app does not affect the server) is
  // produced by this single spawn shape.
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
      // Electron defaults to updating the window title from the renderer's
      // `<title>` tag after page load — that would clobber our per-project
      // title with `packages/app/index.html`'s static "OpenKnowledge" on
      // every navigation. `preventDefault()` in the event handler keeps our
      // title, while still letting the renderer read `document.title` for
      // its own purposes if it wants to.
      win.on('page-title-updated', (e) => {
        e.preventDefault();
      });
      applyCascadePosition(win);
      attachSpellcheckMenuToWindow(win);
      // Per-window PTY reap: closing the window kills its shell (no orphan).
      // Idempotent — the manager no-ops for a window that never opened one. The
      // onReap clears the window's retained dock-visibility so it can't restore
      // a stale "visible" for a future window that reuses the id.
      if (terminalReaper)
        wireWindowTerminalReap(win, terminalReaper, (windowId) =>
          dockVisibleForWindow.delete(windowId),
        );
      return win as unknown as BrowserWindowLike;
    },
    // App-level foreground activation for the bring-to-front recipe. macOS
    // separates window focus from app activation — a BrowserWindow.focus() on a
    // backgrounded app reorders within the app but doesn't pull it to the front
    // (electron/electron#19920). `app.focus({ steal: true })` is the macOS
    // primitive that does. Desktop is macOS-only, but the platform guard keeps
    // it inert anywhere else.
    activateApp: () => {
      if (process.platform === 'darwin') app.focus({ steal: true });
    },
    forkUtility: (entry, args, opts) => {
      // Inject OK_ELECTRON_PROTOCOL_HOST=1 so the `preview-url.ts` helper
      // running inside this utility emits `openknowledge://` URLs for MCP
      // consumers instead of `http://localhost:...`. CLI / bunx invocations
      // don't fork through here, so the flag never bleeds into those
      // consumers. Also carry the startup traceparent (Plan A) + the shared
      // OTLP endpoint so the spawned server joins the launch trace.
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
    // Production-only detached-spawn primitive. Omitted in dev (`null`)
    // so the WindowManager falls back to `forkUtility`. The shell path is
    // forwarded as `--react-shell-dist-dir` so the spawned CLI serves the
    // bundled React shell on its own HTTP port.
    ...(bundleCliMjsPath !== null
      ? {
          spawnDetachedServer: async ({
            contentDir,
            reactShellDistDir,
            singleFile,
            projectDir,
          }) => {
            // The lock + spawn-error log live under the PROJECT ROOT's `.ok/
            // local`, which in ephemeral single-file mode is the throwaway temp
            // `projectDir` (distinct from `contentDir`, the file's real parent),
            // and otherwise is `contentDir` itself.
            //
            // Capture the detached child's stderr at the kernel level to
            // `<projectRoot>/.ok/local/<SPAWN_ERROR_LOG>` so production
            // failure modes (port-bind error, dependency load failure,
            // bootServer init throw) are diagnosable. The MCP shim
            // (`packages/cli/src/mcp/shim.ts`) and `spawnOkUi`
            // (`packages/cli/src/commands/start.ts`) write to the same
            // filename — one tail target for operators. `stdio: 'ignore'`
            // would route everything to /dev/null and leave the user
            // staring at a 15-second `spawn-lock-timeout` with no
            // breadcrumb. The fd is opened in 'w' mode (truncate-on-spawn)
            // so each boot starts with a fresh log; rotation lives at the
            // OS level if it ever matters.
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
            // Resolve the spawn shape via the pure helper so the file argument
            // for the child stays out of the parent .app's MacOS dir on darwin
            // packaged builds — see resolve-detached-spawn-args.ts. stdin +
            // stdout route to /dev/null and stderr to the SPAWN_ERROR_LOG fd
            // (matches MCP shim + spawnOkUi convention). The child inherits
            // the open fd; we close our copy once 'spawn' fires (in the
            // finally below) so the parent doesn't keep the file open.
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
              // Ephemeral single-file mode: append `--single-file <file>
              // --project-dir <temp>` and run cwd at the temp project root.
              // Absent fields collapse to the normal project-open spawn shape.
              ...(singleFile !== undefined ? { singleFile, projectDir } : {}),
            });
            let childRef: ReturnType<typeof spawn>;
            startupWaterfall.mark('serverSpawned');
            try {
              childRef = spawn(spawnArgs.file, spawnArgs.args, spawnArgs.opts);
            } catch (spawnErr) {
              // Synchronous spawn failure — close fd before rethrowing.
              // Re-throw with the same `kind: 'spawn-error'` discriminant the
              // async `'error'` handler below uses, so callers inspecting
              // `err.kind` see a uniform error shape regardless of which
              // failure path fired.
              try {
                closeSync(spawnErrorLogFd);
              } catch {
                // Best-effort.
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
            // Race the async `'spawn'` / `'error'` events. With
            // `stdio: ['ignore', 'ignore', spawnErrorLogFd]` an asynchronous
            // fork failure (ENOENT for a missing CLI binary, EPERM, EMFILE)
            // emits `'error'` after `child_process.spawn` returns —
            // without a listener it either crashes Electron's main
            // process or leaves a dead pid that stalls the caller's
            // lock-poll for the full 15s. Node guarantees exactly one of
            // `'spawn'` / `'error'` fires, so awaiting the race confirms
            // the OS-level fork before any caller starts polling.
            // `.unref()` is deferred until after `'spawn'` so an early
            // teardown doesn't leak an orphan that the parent can't reap.
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
              // The child now owns the fd — close our parent copy so
              // the parent process doesn't keep the log file open
              // beyond the spawn handshake. macOS treats unclosed fds
              // as leaks under FD pressure (`EMFILE` storms in dev).
              try {
                closeSync(spawnErrorLogFd);
              } catch {
                // Best-effort.
              }
            }
            childRef.unref();
            const pid = childRef.pid;
            if (pid === undefined) {
              // Defensive — Node guarantees `pid` is set after `'spawn'`.
              throw new Error(
                'spawnDetachedServer: child_process.spawn did not return a pid after spawn-event resolution.',
              );
            }
            return { pid };
          },
        }
      : {}),
    // Ephemeral single-file session deps (`ok <file>` no-project path). Wired
    // unconditionally — `createEphemeralWindow` guards on all three being present
    // and the dev utility-fork path simply never calls it. `createEphemeralProjectDir`
    // synthesizes the throwaway temp projectDir; `removeDir` reaps it on teardown.
    createEphemeralProjectDir,
    removeDir: (dir: string) => fsPromises.rm(dir, { recursive: true, force: true }),
    rendererEntryPath,
    rendererDevUrl,
    appVersion: app.getVersion(),
    // The desktop's own server identity — what its bundled server would write
    // to a lock. Equal to `app.getVersion()` under the fixed-group lockstep,
    // but sourced from the server package so the attach-path comparison is
    // against the exact value a freshly-spawned server reports.
    selfProtocolVersion: PROTOCOL_VERSION,
    selfRuntimeVersion: RUNTIME_VERSION,
    // Dev-only: auto-reclaim a foreign server on the project's contentDir (a
    // leftover from a prior packaged run / CLI / another instance) so this
    // `electron-vite dev` session runs against its own working-tree build
    // rather than silently attaching to the stale one. Off in packaged builds,
    // where attaching to a live server is the intended shared-server behavior.
    reclaimForeignServerInDev: !app.isPackaged,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    killProbe: (pid, signal) => {
      process.kill(pid, signal as NodeJS.Signals | 0);
    },
    // Attach-mode wiring — when a same-host `ok start` CLI (or any other
    // bootServer caller) is already holding the server.lock for this
    // contentDir, window-manager reads the lock + verifies liveness and
    // connects the renderer directly instead of trying to spawn a duplicate.
    readServerLock: (lockDir) => readServerLock(lockDir),
    isProcessAlive: (pid) => isProcessAlive(pid),
    hostname: () => osHostname(),
    probeWsUpgrade: (url, timeoutMs) => probeWsUpgrade(url, timeoutMs),
    // Canonicalize `windowsByPath` keys via realpath so a deep-link URL
    // carrying `realpathSync(contentDir)` (emitted by preview-url.ts) matches
    // a window opened via a symlinked project path. See window-manager.ts's
    // `canonicalizeKey` + `ProjectContext.canonicalKey` for the rationale.
    realpathSync: (p) => realpathSync(p),
    onUtilityMessage: (msg) => {
      ensureDebugIpc().handleUtilityMessage(msg);
    },
    onUtilityExit: (utility) => {
      ensureDebugIpc().cancelPendingForUtility(utility);
    },
    // Presence-invisible keepalive WS — registers the desktop as an active
    // `/collab*` upgrade for as long as a project window is open, so a brief
    // MCP disconnect does not trip the server's idle-shutdown timer. The
    // factory captures `readServerLock` (same one the attach-mode probe
    // uses) so a server restart on a new port is picked up transparently
    // on the next exponential-backoff retry.
    createKeepalive: createDesktopKeepaliveFactory({
      readServerLock: (lockDir) => readServerLock(lockDir),
      // Route the keepalive's connect / disconnect / backoff lifecycle to the
      // 'keepalive' logger. Previously omitted, which left the sole mechanism
      // that keeps a detached server alive while a window is open completely
      // silent — so an idle-shutdown that fired because the keepalive wasn't
      // holding had no trace explaining why.
      logger: toKeepaliveLogger(getLogger('keepalive')),
    }),
    showGate,
    // Startup-instrumentation hooks. The traceparent + mark callbacks are
    // always wired; the waterfall's per-phase `mark` is first-write-wins, so
    // only the launch's first project window populates the timeline. Later
    // windows re-call these harmlessly (no-ops on an already-stamped phase).
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
  });
}

function openNavigator(pendingPayload?: ShareNavigatorPayload) {
  if (navigatorWindow) {
    getLogger('navigator').debug({}, 'already open, focusing');
    (navigatorWindow as unknown as { focus: () => void }).focus();
    // Warm path — Navigator already mounted. Deliver the launcher-scoped
    // share payload now: immediate send when the page has finished loading,
    // gated on `did-finish-load` when a load is still in flight (the rare
    // race where a second share fires while the Navigator is still in its
    // cold-launch dom-ready window). The still-loading branch routes through
    // `registerPendingDelivery` so the register-before-fire ordering matches
    // the other readiness-gate sites; the immediate-send branch stays local
    // because once the page is loaded there is no listener to register —
    // a dom-ready/did-finish-load gate would hang (already past it).
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
  // Fixed-size launcher window at the 920×680 target. Sized so the first-run
  // packs-forward view (header + full starter-pack grid + secondary row) fits
  // without the grid scrolling. NavigatorApp.tsx vertically centers the visible
  // content within this frame and leaves the top ~36 px chrome strip as the
  // drag region for the macOS title-bar zone.
  navigatorWindow = createNavigatorWindow({
    createWindow: (opts) => {
      const win = new BrowserWindow({
        ...DEFAULT_WIN_OPTS,
        width: 920,
        height: 680,
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

/**
 * Surface non-success outcomes from `writeProjectAiIntegrations` to ops via
 * a structured `console.warn` event, and return the count of `failed`
 * outcomes for the OTel span. `'skipped-unsupported'` is the normal shape for
 * an (editor × integration) pair the editor has no surface for (e.g. Claude
 * Desktop has no project-local MCP config or skill path) — not a failure —
 * so it is excluded from the log payload alongside the success actions.
 */
function logAiIntegrationOutcomes(result: ProjectAiIntegrationsResult): number {
  // "Interesting" = anything that isn't a plain success: failures AND a
  // non-destructive `declined` (a present config OK couldn't safely edit). Both
  // are surfaced to ops; only `failed` is counted toward the span metric below.
  // Success actions (written, overwritten, skipped-unsupported) are excluded.
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

// Threshold above which an ancestor-promote target is considered too large to
// boot inside the utility's 15s init budget (window-manager.ts),
// and therefore must be confirmed before fork. Tuned ~5x the smallest
// problematic ancestor seen in the field; well below the 92k+ entry trees
// that actually trip the timeout. `walkExceedsCap` short-circuits as soon as
// the cap is exceeded, so the probe stays cheap on typical vault-sized trees.
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

  // Admission funnel. Resolve the pick BEFORE any window/utility spawn so we
  // know whether to ancestor-promote, silent-onboard, dialog, or refuse.
  const validation = validateFolderPick(projectPath);
  const discovery = await discoverProject(projectPath, {
    // Probe consulted only when the ancestor walk strictly promotes — gates
    // silent fork against an ancestor too large to boot in 15s (the dragon-wiki
    // regression: a small pick under `~/Documents/.ok/` silently forked the
    // utility against `~/Documents` and timed out). Failsafe to "show the
    // dialog" on any throw so a probe failure can't reintroduce silent fork.
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
    // Route the reclaim's structured events into the pino file logger — the
    // default console sink is discarded in the packaged main process.
    logger: { event: (payload) => getLogger('mcp-wiring').info(payload, payload.event) },
  }).catch((err) => {
    console.warn('[main] project-mcp reclaim failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  });
  // The project-skill reclaim is NOT in this unconditional cluster. It can now
  // CREATE a skill (for OK-wired editors in a managed project), so it must fire
  // only for committed managed opens — never for a non-OK folder the user opens
  // then cancels, nor before a managed-requires-confirmation prompt is answered.
  // It runs after the fresh/managed branch resolves.
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
    // Ancestor `.ok/config.yml` resolved a tree too large for the utility's
    // 15s init budget. Surface a native two-button confirmation dialog
    // BEFORE the fork instead of silently routing into a timeout. Cancel
    // returns to Navigator with no fs writes; Confirm falls through to the
    // existing managed-promote silent flow. This is the only path that can
    // reach this branch (cursor !== realPicked), so ancestorPromoted is
    // guaranteed true.
    const ancestorName = basename(discovery.projectDir);
    const pickedName = basename(discovery.pickedPath);
    // Async dialog matches the codebase convention (every other dialog in
    // packages/desktop/src/main/ uses await dialog.showMessageBox); sync would
    // freeze IPC, the auto-updater pipeline, and the cc1-broadcast debouncer
    // until the user clicks. Button order [Cancel, Open <ancestor>] with
    // cancelId:0 / defaultId:0: Enter and Escape both land on the safe path.
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
    // Ancestor-promote: open the ancestor regardless of entry point; toast
    // only when the user picked a sub-path (`ancestorPromoted`) AND the user
    // didn't explicitly choose the project (Recents, or the BLOCK NESTED
    // redirect from CreateProjectDialog where the user just acknowledged the
    // existing project's path).
    flowKind = discovery.ancestorPromoted ? 'managed-promote' : 'managed-direct';
    if (
      discovery.ancestorPromoted &&
      entryPoint !== 'recents' &&
      entryPoint !== 'create-new-nested-redirect'
    ) {
      toastPayload = { kind: 'ancestor-promote', ancestorPath: discovery.projectDir };
    }
  } else {
    // kind === 'fresh'. Spin the consent dialog up against the Navigator,
    // then dispatch user choices. Cancel returns to Navigator with no fs
    // writes. The new create-new-project flow scaffolds .ok/config.yml in
    // the ok:project:create-new handler BEFORE calling openProject, so by
    // the time we land here discovery.kind is never 'fresh' for a
    // 'create-new' entry point.
    let navigator = navigatorWindow;
    if (!navigator) {
      // No Navigator hosts the dialog yet. This is the cold-boot path
      // when `lastOpenedProject` points at a folder whose `.ok/` was
      // deleted out from under it — or any deep-link / Recents entry
      // point that fires before the Navigator has been opened. Open
      // the Navigator now and wait for its renderer to finish loading
      // before dispatching the consent dialog. The mount-ack handshake
      // inside `requestUserConsent` handles the renderer-not-yet-bound
      // race past `did-finish-load`.
      openNavigator();
      navigator = navigatorWindow;
      if (!navigator) {
        // openNavigator failed to mount a window — surface and bail.
        // Should be unreachable in practice (createNavigatorWindow is
        // synchronous and only fails on Electron-internal errors), but
        // a defensive bail beats a stuck cold-boot.
        dialog.showErrorBox(
          'Cannot open this folder',
          `${projectPath}\n\nFailed to open the Project Navigator.`,
        );
        return;
      }
      const navigatorWebContents = (navigator as unknown as { webContents: Electron.WebContents })
        .webContents;
      if (navigatorWebContents.isLoading()) {
        // Promise.race the load against the renderer being destroyed —
        // a closed Navigator window or a crashed renderer mid-load would
        // otherwise leave openProject stuck on a Promise that never
        // resolves. The outer try/catch around the dialog path routes
        // the rejection to the error-dialog branch.
        //
        // The loser of the race must be unregistered on settle; otherwise
        // its `once`-bound closure holds references to the `resolve`/
        // `reject` pair until the WebContents is GC'd. (Behaviorally a
        // no-op — re-settling an already-settled Promise is ignored —
        // but a future maintainer who swaps `once` for `on` would
        // re-introduce a real fire-after-settle bug.)
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
        // Pi is the first project-scope-only editor; without the user-side
        // signal the badge would misread as "(project + user)".
        hasUserConfig: EDITOR_TARGETS[id].scope === 'global',
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
      // Return to Navigator with no fs changes, no Recents add.
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
    // Customized vs default — telemetry attribute distinguishes the two
    // so the team can answer "how often do users tweak the dialog?"
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
    // Sharing-mode transition. Runs AFTER every artifact-
    // writing step so the tracked-files probe inside
    // `addOkPathsToGitExclude` sees the latest on-disk shape. On a tracked-
    // files refusal we surface a non-blocking toast to the navigator (same
    // posture as the legacy ai-integration failure toast); the project
    // window still opens. disables the radio when `gitState === 'absent'`,
    // but the user can still pick `local-only` if `initGit` was true (we
    // just scaffolded a fresh `.git`) — by then the gitdir resolves.
    if (request.sharing === 'local-only') {
      const paths = getOkArtifactPaths(discovery.projectDir);
      const result = addOkPathsToGitExclude(discovery.projectDir, paths);
      if (result.kind === 'refused-tracked') {
        // Re-use the existing toast channel — `ok:onboarding:toast` is the
        // canonical surface for post-confirm advisory messages.
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
      // A sharing refusal / no-git advisory (set just above) carries
      // action-required `git rm --cached` remediation and must win over the
      // git-root-promote notice, which is purely informational. Only surface
      // the promote toast when no higher-priority sharing toast was set.
      toastPayload = {
        kind: 'git-root-promote',
        gitRoot: discovery.projectDir,
        pickedPath: discovery.pickedPath,
      };
    }
  }

  // Project-skill reclaim — gated to committed managed opens. Reaching here
  // means the open is committed (every cancel path returned earlier), so for a
  // `managed` / confirmed `managed-requires-confirmation` open we pass
  // `createIfWired: true`: any editor already wired for this OK project gets its
  // SKILL.md created if missing (and refreshed if present), healing the
  // MCP-but-no-skill cohort. A `fresh` open is handled by
  // `writeProjectAiIntegrations` above (it writes skills for the editors the
  // user consented to), so the reclaim doesn't run for it — no redundant
  // double-write, and no seeding a folder the consent dialog just configured a
  // different way.
  if (discovery.kind === 'managed' || discovery.kind === 'managed-requires-confirmation') {
    void reclaimProjectSkillsOnProjectOpen({
      projectDir: resolvedProjectDir,
      executablePath: app.getPath('exe'),
      isPackaged: app.isPackaged,
      platform: process.platform,
      forceEnv: process.env.OK_M6B_FORCE ?? null,
      reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
      createIfWired: true,
      // Project-local reclaim installs the rich `project` bundle.
      // checkDesktop:false — the desktop resolves its own bundled assets.
      deps: {
        resolveBundledSkillDir: () => resolveBundledSkillDir('project', { checkDesktop: false }),
      },
    }).catch((err) => {
      console.warn('[main] project-skill reclaim failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Emit one onboarding-consent span per completed flow. SDK disabled → no-op.
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
  // Toast dispatch on did-finish-load so the renderer's sonner subscriber is
  // mounted. `prefers-reduced-motion: reduce` is honored sonner-side.
  if (toastPayload !== null) {
    const payload = toastPayload;
    ctx.window.webContents.once('did-finish-load', () => {
      sendToRenderer(ctx.window.webContents, 'ok:onboarding:toast', payload);
    });
  }

  tryCloseNavigator(navigatorWindow, { projectPath });
  // Backfill the canonical GitHub remote URL so the share-receive lookup
  // hits on subsequent shares for this repo. Best-effort and silent — a
  // project with no `.git/config`, no `origin`, or a non-GitHub remote
  // leaves the field undefined; the receiver pays a one-time cost.
  const gitRemoteUrl = readCanonicalGitHubRemoteUrl(resolvedProjectDir) ?? undefined;
  appState = addRecentProject(appState, resolvedProjectDir, ctx.projectName, gitRemoteUrl);
  // Opening a worktree records it in recents (so it nests under its project),
  // but the launch default stays the PROJECT, not the worktree — next launch
  // reopens the main repo rather than a specific branch's window.
  if (entryPoint === 'worktree') {
    const mainRoot = classifyRecentGit(resolvedProjectDir).mainRoot;
    if (mainRoot !== null) appState = { ...appState, lastOpenedProject: mainRoot };
  }
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
    // Pick a dialog title + body based on the error's structured kind.
    // Default ("Unable to open project") matches the existing pre-spec
    // path so plain failures (generic boot crashes) continue to read the
    // same way; specific kinds get specific copy.
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
    // A spawn that timed out because a holder is in the way (fail-closed
    // collision — visible in the child's stderr tail), or a direct lock
    // collision, has a one-click remedy: stop the conflicting holder and
    // retry. Everything else keeps the plain error box.
    const holderInTheWay =
      kind === 'lock-collision' ||
      (kind === 'spawn-lock-timeout' && errorMessage.includes('already running'));
    if (holderInTheWay) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: dialogTitle,
        message: dialogTitle,
        detail:
          `${dialogBody}\n\n` +
          `OpenKnowledge can stop the conflicting server process and retry opening the project.`,
        buttons: ['Stop Server & Retry', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        ensureWindowManager();
        const stop = await wm.forceStopConflictingServer(projectPath);
        if (stop.ok) {
          try {
            // Single retry — a second failure falls through to the plain
            // error box rather than looping the dialog.
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
      }
      openNavigator();
      return;
    }
    dialog.showErrorBox(dialogTitle, dialogBody);
    openNavigator();
  }
}

/**
 * Open a no-project file in an ephemeral single-file editing session (the
 * desktop side of `ok <file>`, reached via the `openknowledge://open?file=`
 * deep-link). Re-runs the shared `prepareSingleFileOpen` main-side — the
 * safety net: a `file=` whose realpath sits inside a project (a symlink, a
 * hand-crafted URL) routes to the normal project-open flow rather than spinning
 * an ephemeral server that would clobber the project's file.
 *
 * Ephemeral sessions are deliberately NOT added to recents — the user
 * opened a loose file, not a project. Teardown of the server + temp dir is owned
 * by `createEphemeralWindow`'s per-window `'closed'` handler.
 */
async function openEphemeralFile(filePath: string): Promise<void> {
  ensureWindowManager();

  let plan: ReturnType<typeof prepareSingleFileOpen>;
  try {
    plan = prepareSingleFileOpen(filePath);
  } catch (err) {
    // Typed user-facing errors (missing / not-a-file / not-markdown) render a
    // native dialog rather than a stack trace.
    dialog.showErrorBox(
      'Cannot open this file',
      `${filePath}\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // the file's realpath is inside a project → open the project focused on
  // the file, not an ephemeral session.
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
    // The asset-safety-net root is the file's REAL parent (`ctx.projectPath` ===
    // `plan.contentDir`), NOT the throwaway temp projectDir — so `![[sibling]]`
    // `![](path)` assets are allowlisted against the directory they
    // actually live in.
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
    // Fall back to the Navigator only when the failed open would otherwise leave
    // the app with no window (a cold `ok <file>` that errored) — a warm session
    // with windows already open shouldn't get a surprise Navigator on top of the
    // error dialog. (createEphemeralWindow already reaped the server + temp dir.)
    if (BrowserWindow.getAllWindows().length === 0) {
      openNavigator();
    }
  }
}

/**
 * Single in-flight `installApplicationMenu` promise. Rapid renderer pushes
 * (e.g. `notifyActiveTargetChanged` firing on every navigation) would
 * otherwise interleave two parallel `installApplicationMenu` invocations;
 * Electron's `Menu.setApplicationMenu` is last-write-wins, so the slower
 * call could clobber the newer state. Serialize: a refresh call that lands
 * while one is in flight marks `pendingRefresh = true`; when the current
 * call resolves, we kick off one more refresh to absorb whatever pushes
 * landed during the prior cycle. Coalesces N rapid pushes to at most 2
 * sequential refreshes (current + one queued).
 */
let refreshInFlight: Promise<void> | null = null;
let pendingRefresh = false;

/**
 * Rebuild the application menu. Called on app boot AND whenever the recent-
 * projects list changes, so File → Open Recent stays current.
 */
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
  // installApplicationMenu is async because it dynamically imports
  // `electron.Menu` (see menu.ts header — keeps `buildMenuTemplate`
  // unit-testable under Bun). Failures are logged; an uninstallable menu
  // shouldn't crash the app.
  await installApplicationMenu({
    appName: app.name,
    // Dev + any prerelease keep DevTools; only stable hides it. `app.isPackaged`
    // alone is the wrong gate (true for both channels); the version's channel
    // is the discriminator — stable promotion overrides the legacy commit's
    // `-beta.N` via `--config.extraMetadata.version=X.Y.Z`. Reuses
    // `channelFromVersion` so this stays aligned with the auto-updater channel.
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
    // The scheme allowlist is enforced in the renderer IPC path (shell-allowlist.ts).
    // Help-menu URLs are hardcoded in menu.ts (always `https://github.com/inkeep/…`),
    // so they're trusted at build time — direct shell.openExternal is fine here.
    openExternalUrl: (url: string) => {
      void shell.openExternal(url);
    },
    // File → "Set up OpenKnowledge integrations…" re-trigger for the
    // first-launch consent dialog (MCP wiring + shell-PATH install). Only
    // plumb the dep on darwin + packaged builds; non-macOS has no MCP
    // wiring, and dev-mode explicitly contaminates the developer's real
    // configs — both should hide the row. The handler
    // tears down any prior mcpWiringHandle then arms a fresh one with
    // `forceShow: true` so the marker-present gate is bypassed, and hands
    // it an already-loaded window so the dialog opens immediately. The
    // wiring is user-global (the MCP entry resolves the project at tool-call
    // time), so any window works — editor or Navigator. With zero loaded
    // windows the armed mount-ack fallback delivers the dialog to the next
    // window that opens.
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
                'Set up OpenKnowledge integrations failed',
                `OpenKnowledge couldn't re-arm the MCP consent dialog:\n\n${message}`,
              );
            }
          }
        : undefined,
    // Help → Install in Claude Desktop… opens the skill install dialog in
    // the focused window via the same URL-hash trigger the command palette
    // + docs link use. Falls back to iterating all BrowserWindows when no
    // window is focused (e.g. menu clicked from the Dock).
    openInstallSkillDialog: () => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!target) return;
      target.webContents.executeJavaScript(
        "window.location.hash = '#install-claude-desktop'; undefined",
      );
    },
    // App menu (macOS) / File menu (Windows/Linux) Settings… navigates the
    // focused window's URL hash to `#settings` so the renderer's
    // `useSettingsRoute` hook renders the Settings pane in the editor area.
    // Same hash-routed pattern as `openInstallSkillDialog` so
    // every entry point (menu / Cmd-, / HelpPopover / CommandPalette)
    // funnels through the same client-side mount path. Silent no-op when
    // the focused window is the Navigator (renderer is NavigatorApp, not
    // App, and does not mount `useSettingsRoute`).
    openSettings: () => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!target) return;
      target.webContents.executeJavaScript("window.location.hash = '#settings'; undefined");
    },
    // App-menu / Help-menu "Check for Updates…" entries fire this. Returns
    // void: the menu doesn't surface in-flight progress; the existing
    // `update-available` / `update-not-available` electron-updater events
    // are what drive the user-facing toast UX. Returns undefined when the
    // updater handle hasn't booted yet (dev mode, or boot failure logged at
    // error level) so the menu items short-circuit silently rather than
    // throw on `undefined?.()`.
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
            getLogger('lifecycle').error(
              { err: err instanceof Error ? err.message : String(err) },
              'desktop self-uninstall flow failed',
            );
          })
      : undefined,
    // File menu state-aware items. activeTarget drives enable/disable;
    // per-item handlers fire `ok:menu-action` to the focused renderer which
    // already knows the current scope (sidebar selection + editor
    // activeTarget) and dispatches the corresponding primitive (the same
    // primitives the sidebar context menus invoke). Routes through the
    // existing `onMenuAction` channel so there's no new IPC surface for the
    // renderer to subscribe to.
    activeTarget: editorActiveTarget,
    onNewFile: () => sendMenuActionToFocused('new-doc'),
    onNewFolder: () => sendMenuActionToFocused('new-folder'),
    onNewFromTemplate: () => sendMenuActionToFocused('new-from-template'),
    // New project… — opens the create-new-project dialog in the
    // focused window. Both window kinds (editor App, NavigatorApp) subscribe
    // to this action and mount CreateProjectDialog.
    onNewProject: () => sendMenuActionToFocused('new-project'),
    // Worktree selector (worktree = window). Both delegate to the
    // focused renderer's ProjectSwitcher surface: `new-worktree` opens the
    // create dialog, `switch-worktree` opens the sidebar switcher.
    onNewWorktree: () => sendMenuActionToFocused('new-worktree'),
    onSwitchWorktree: () => sendMenuActionToFocused('switch-worktree'),
    onRename: () => sendMenuActionToFocused('rename'),
    onDuplicate: () => sendMenuActionToFocused('duplicate'),
    onMoveToTrash: () => sendMenuActionToFocused('move-to-trash'),
    onCloseActiveTabOrWindow: () => sendMenuActionToFocused('close-active-tab-or-window'),
    onRevealInFinder: () => sendMenuActionToFocused('reveal-in-finder'),
    onSendToAi: () => sendMenuActionToFocused('send-to-ai'),
    onCopyFullPath: () => sendMenuActionToFocused('copy-full-path'),
    onCopyRelativePath: () => sendMenuActionToFocused('copy-relative-path'),
    // View menu items reflect the latest renderer-pushed snapshot via
    // `ok:editor:view-menu-state-changed`. Defaults at the snapshot
    // declaration site keep the menu reachable before the first push lands.
    // Toggling still fires `ok:menu-action` which the renderer routes
    // through `projectLocalBinding.patch(...)`; the resulting CRDT
    // mutation triggers a sibling push back so the checkmark snaps.
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
    onNewTerminalWindow: () => openTerminalWindow(),
    onExpandAll: () => sendMenuActionToFocused('expand-all-tree'),
    onCollapseAll: () => sendMenuActionToFocused('collapse-all-tree'),
    // Edit -> "Check Spelling While Typing": the checkbox reflects the
    // persisted app-wide flag; the click flips it through the shared toggle
    // (session + persist + menu rebuild) so this and the in-editor
    // Disable/Enable rows stay consistent.
    spellCheckEnabled: appState.spellCheckEnabled,
    onToggleSpellCheck: () => setSpellCheckEnabledAppWide(!appState.spellCheckEnabled),
  });
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

/**
 * Show a `DesktopUninstallNoticeSpec` in a styled utility window and resolve
 * true on confirm. Closing the window without a button press means Cancel for
 * a two-button notice; a single-button notice proceeds either way (there is
 * nothing else to choose, and the flow must still quit).
 */
async function showDesktopUninstallNotice(
  spec: DesktopUninstallNoticeSpec,
  options: { width?: number; height?: number; resizable?: boolean } = {},
): Promise<boolean> {
  const parent = BrowserWindow.getFocusedWindow();
  const closeMeansConfirm = spec.cancelLabel === undefined;
  return new Promise((resolveNotice) => {
    const win = createDesktopUninstallUtilityWindow({
      parent,
      width: options.width ?? 480,
      height: options.height ?? 300,
      title: spec.title,
      modal: parent != null,
      resizable: options.resizable ?? false,
    });

    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolveNotice(confirmed);
      if (!win.isDestroyed()) win.destroy();
    };

    win.webContents.on('will-navigate', (event, url) => {
      const action = parseDesktopUninstallNoticeUrl(url);
      if (action !== null) {
        event.preventDefault();
        finish(action === 'confirm');
        return;
      }
      if (!url.startsWith('data:text/html')) event.preventDefault();
    });

    win.on('close', (event) => {
      if (settled) return;
      event.preventDefault();
      finish(closeMeansConfirm);
    });
    win.on('closed', () => {
      if (settled) return;
      settled = true;
      resolveNotice(closeMeansConfirm);
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });

    void win
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(buildDesktopUninstallNoticeHtml(spec))}`,
      )
      .catch((err) => {
        getLogger('lifecycle').warn(
          { err: err instanceof Error ? err.message : String(err) },
          'desktop uninstall notice failed to load',
        );
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
    },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
    const win = createDesktopUninstallUtilityWindow({
      parent,
      width,
      height,
      minWidth: 560,
      minHeight: 420,
      title: 'Uninstall OpenKnowledge',
    });

    let settled = false;
    const finish = (raw: unknown) => {
      if (settled) return;
      settled = true;
      resolveSelection(resolveDesktopUninstallProjectSelection(candidates, raw));
      if (!win.isDestroyed()) win.destroy();
    };

    win.webContents.on('will-navigate', (event, url) => {
      const pickerResult = parseDesktopUninstallProjectPickerUrl(url);
      if (pickerResult !== null) {
        event.preventDefault();
        finish(pickerResult);
        return;
      }
      if (!url.startsWith('data:text/html')) event.preventDefault();
    });

    win.on('close', (event) => {
      if (settled) return;
      event.preventDefault();
      finish({ action: 'cancel' });
    });
    win.on('closed', () => {
      if (settled) return;
      settled = true;
      resolveSelection(null);
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });

    void win
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          buildDesktopUninstallProjectPickerHtml(candidates),
        )}`,
      )
      .catch((err) => {
        getLogger('lifecycle').warn(
          { err: err instanceof Error ? err.message : String(err) },
          'desktop uninstall project picker failed to load',
        );
        finish({ action: 'cancel' });
      });
  });
}

async function withDesktopUninstallProgress<T>(work: () => Promise<T>): Promise<T> {
  const parent = BrowserWindow.getFocusedWindow();
  const win = createDesktopUninstallUtilityWindow({
    parent,
    width: 420,
    height: 220,
    title: 'Uninstalling OpenKnowledge',
    modal: parent != null,
    resizable: false,
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('data:text/html')) event.preventDefault();
  });
  const preventClose = (event: { preventDefault(): void }) => event.preventDefault();
  win.on('close', preventClose);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  try {
    // The progress window is cosmetic — a failed load must neither skip the
    // cleanup nor (being outside the finally) leak the close-prevented window.
    try {
      await win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(buildDesktopUninstallProgressHtml())}`,
      );
    } catch (err) {
      getLogger('lifecycle').warn(
        { err: err instanceof Error ? err.message : String(err) },
        'desktop uninstall progress window failed to load',
      );
    }
    return await work();
  } finally {
    if (!win.isDestroyed()) {
      win.removeListener('close', preventClose);
      win.destroy();
    }
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
      { err: err instanceof Error ? err.message : String(err) },
      'desktop self-uninstall could not discover running project locks',
    );
  }

  const projectCandidates = collectDesktopUninstallProjectCandidates({
    recentProjects: appState.recentProjects,
    openProjectPaths: wm?.getOpenProjectPaths() ?? [],
    lockDirs,
  });
  let projectPaths: string[] = [];
  if (projectCandidates.length > 0) {
    const selectedProjects = await showDesktopUninstallProjectPicker(projectCandidates);
    if (selectedProjects === null) return;
    projectPaths = selectedProjects.map((candidate) => candidate.path);
  } else {
    const confirmed = await showDesktopUninstallNotice(desktopUninstallConfirmNotice(), {
      height: 280,
    });
    if (!confirmed) return;
  }

  const includeProjects = projectPaths.length > 0;
  const logPath = defaultDesktopUninstallLogPath(osHomedir());
  const cleanup = await withDesktopUninstallProgress(() =>
    runDesktopUninstallCleanup({
      cliPath: wrapperPathInBundle(process.execPath),
      projectPaths,
      logPath,
    }),
  );
  if (!cleanup.ok) {
    // Cleanup ran but reported problems (a refused path, a failed deinit…).
    // Surface the log inline so the user doesn't have to hunt for the file,
    // then continue to the remove-the-app step — the user asked to uninstall,
    // and the log spells out anything that needs manual follow-up.
    getLogger('lifecycle').warn(
      { includeProjects, projectCount: projectPaths.length, logPath, error: cleanup.error },
      'desktop self-uninstall cleanup reported failures',
    );
    await showDesktopUninstallNotice(
      desktopUninstallFailureNotice({
        error: cleanup.error,
        logPath,
        logText: readDesktopUninstallLogForDisplay(logPath),
      }),
      { width: 560, height: 520, resizable: true },
    );
    await showDesktopUninstallNotice(desktopUninstallFinalStepNotice(), { height: 240 });
  } else {
    getLogger('lifecycle').info(
      { includeProjects, projectCount: projectPaths.length, logPath },
      'desktop self-uninstall cleanup finished',
    );
    await showDesktopUninstallNotice(
      desktopUninstallCompletionNotice({ projectCount: projectPaths.length, logPath }),
      { height: 320 },
    );
  }

  shell.showItemInFolder(appBundlePath);
  autoUpdaterHandle?.suppressAutoInstallOnQuit();
  app.quit();
}

/**
 * Dispatch an `OkMenuAction` to the focused renderer window. Mirrors the
 * `openInstallSkillDialog` / `openSettings` pattern — falls back to the first
 * BrowserWindow when no window is focused (menu clicked from the Dock).
 * Silent no-op when no windows are open (e.g. last project closed but app
 * still running on macOS via the Dock).
 */

function sendMenuActionToFocused(action: OkMenuAction): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!target) return;
  sendToRenderer(target.webContents, 'ok:menu-action', action);
}

/**
 * Terminal → "New Terminal Window": open a dedicated terminal window inheriting
 * the focused window's project (the editor window's `windowsByPath` context, or
 * a focused terminal window's registry context for chaining; project-less from
 * the Navigator or with no focused project). Opens directly in main — like
 * `openNavigator` — rather than round-tripping the renderer.
 */
function openTerminalWindow(): void {
  if (terminalReaper == null) return; // PTY manager not yet wired (pre-boot) — unreachable from a menu click.
  const focused = BrowserWindow.getFocusedWindow();
  const editorCtx =
    focused && wm ? wm.getContextForBrowserWindow(focused as unknown as BrowserWindowLike) : null;
  const project = resolveTerminalWindowProject({
    editor: editorCtx ?? null,
    terminal: focused ? getTerminalWindowContext(focused.id) : undefined,
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
          additionalArguments: withDebugFlagIfAllowed(opts.additionalArguments),
          preload: join(__dirname, '../preload/index.js'),
        },
      });
      // Keep our per-window title against the renderer's static <title> (same as
      // editor windows). The per-window PTY reap is wired by the factory.
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

/**
 * Arm first-launch MCP consent. Extracted as a helper so both the
 * `app.whenReady()` path (once-per-boot marker-respecting) AND the
 * "Set up OpenKnowledge integrations…" File menu path (forceShow, ignores
 * prior marker) share one wiring definition. The cli surface is
 * imported via the published-package name `@inkeep/open-knowledge` so
 * turbo's `^build` topology correctly invalidates desktop's cache when
 * CLI internals change.
 */
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
      // Preserve a `declined` outcome instead of collapsing it to `overwritten`,
      // so the reclaim sweep records a decline (byte-untouched) rather than
      // emitting a false `reclaimed` event for a file it never wrote.
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

/**
 * Shared `ensureCliOnPath` options — one builder so the startup reclaim leg
 * and the consent-dialog confirm leg run the identical gate set (darwin,
 * packaged, executable shape, OK_RECLAIM_DISABLE) against the same marker.
 */
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

/**
 * Shared opts for `reclaimUserSkillsOnLaunch` — one builder so the launch
 * fire-and-forget leg and the consent-dialog confirm leg run the identical
 * gate set (env gates, per-bundle opt-in, install/teardown) against the same
 * marker. The reclaim itself honors the recorded per-bundle decisions.
 */
function buildReclaimUserSkillsOpts(): Parameters<typeof reclaimUserSkillsOnLaunch>[0] {
  return {
    home: osHomedir(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    executablePath: app.getPath('exe'),
    forceEnv: process.env.OK_M6B_FORCE ?? null,
    reclaimDisableEnv: process.env.OK_RECLAIM_DISABLE ?? null,
    deps: {
      // checkDesktop:false — the desktop resolves its own assets.
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
      // `bundleId` originates from `USER_GLOBAL_BUNDLE_IDS`, so the cast to the
      // CLI's `BundleId` is sound.
      removeBundleFromDisk: (bundleId) =>
        removeUserGlobalSkillBundle(
          osHomedir(),
          bundleId as (typeof USER_GLOBAL_BUNDLE_IDS)[number],
        ),
      // The reclaim module types `bundle` as `string` to stay import-free; the
      // values come from `USER_GLOBAL_BUNDLE_IDS` so they're real ids.
      recordSkillInstallEvent: (event) =>
        recordSkillInstallEvent(event as Parameters<typeof recordSkillInstallEvent>[0]),
    },
  };
}

function createMcpWiringOpts(opts: ArmMcpWiringOpts = {}) {
  return {
    isPackaged: app.isPackaged,
    executablePath: app.getPath('exe'),
    home: osHomedir(),
    platform: process.platform,
    ipcMain,
    cli: createMcpWiringCliSurface(),
    // PATH leg of the first-launch consent dialog: descriptor for the show
    // payload + the confirm-path finalizer. `applyConsent` reuses the exact
    // startup install pipeline so idempotence, opt-outs, and the marker
    // stay single-sourced in path-install.ts; the confirm path is the sole
    // writer of a dialog-driven consent decision (startup only ever
    // grandfathers).
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
        // No success toast here: the dialog named the exact files before
        // the user consented, so re-announcing the write is noise. The
        // disclosure toast stays reserved for BACKGROUND rc writes (startup
        // self-heal under recorded consent), where it is the only signal.
        return { ok: true as const };
      },
    },
    // Skills leg of the first-launch consent dialog: per-bundle rows for the
    // show payload + the confirm finalizer. `applyConsent` records every
    // bundle's decision, then reuses the launch reclaim (now decision-gated)
    // to install the enabled set and tear down any declined-but-present
    // bundle — one code path for install + removal.
    skills: {
      computeDescriptors: () =>
        USER_GLOBAL_BUNDLE_IDS.map((id) => ({
          id,
          name: BUNDLE_SKILL_NAME[id],
          alreadyInstalled: existsSync(
            join(osHomedir(), '.agents', 'skills', BUNDLE_SKILL_NAME[id]),
          ),
        })),
      applyConsent: async (enabledIds: readonly string[]) => {
        const home = osHomedir();
        // The consent dialog is the trust boundary: a failed decision write
        // must NOT be swallowed. If it were, the reclaim below would re-read a
        // null decision, grandfather an already-installed declined bundle back
        // to enabled, and still return ok — silently losing the user's
        // decline. Surface {ok:false} so mcp-wiring defers the marker and the
        // dialog re-fires for a retry (same as a failed PATH/editor write).
        for (const id of USER_GLOBAL_BUNDLE_IDS) {
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
    // Route the wiring's structured events (mcp-config-decline / -migrate /
    // -repair-*) into the pino file logger. The default console sink is
    // discarded in a packaged Electron main process with no attached terminal,
    // which is exactly where these operability signals need to land.
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

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a login-shell `command -v <bin>` probe in the real shell (the same
 * `resolveShell` the PTY spawns), with `spawn` + timers wired to the OS. Shared
 * by the Claude readiness path and the generic non-Claude CLI path; the
 * timeout/exit-code routing is unit-tested in claude-readiness.test.ts via an
 * injected spawn. `args` selects the binary (`cliProbeArgs(bin)`); it defaults
 * to the `claude` probe.
 */
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

/**
 * Whether the project's OWN `open-knowledge` `.mcp.json` entry is OK's canonical
 * managed server. The trust gate for the docked-terminal Claude MCP pre-approval
 * (see core `terminal-launch.ts` + cli `isOwnManagedEntry`): a foreign,
 * tampered, or missing same-named entry — the supply-chain risk in a
 * shared/cloned project whose committed `.mcp.json` travels with it — returns
 * false, so the launch stays bare and Claude shows its own "trust this server?"
 * prompt. `classifyExistingMcpEntry` honors its never-throws contract; no bound
 * project, or an editor with no project config path, → false.
 */
function isProjectClaudeMcpOwn(projectRoot: string | undefined): boolean {
  if (projectRoot === undefined) return false;
  const target = EDITOR_TARGETS.claude;
  const projectPath = target.projectConfigPath?.(projectRoot);
  if (projectPath === undefined) return false;
  const classified = classifyExistingMcpEntry(target, projectRoot, undefined, projectPath);
  return classified.kind === 'present' && isOwnManagedEntry(classified.entry);
}

/**
 * Resolve docked-terminal Claude Code readiness: probe `claude` on the
 * login-shell PATH, classify the user-global `open-knowledge` entry in
 * `~/.claude.json`, and verify the PROJECT's `.mcp.json` `open-knowledge` entry
 * is OK's own (gates MCP pre-approval). The real subprocess + config reads are
 * the runtime e2e rung (a built terminal).
 */
function resolveTerminalClaudeReadiness(projectRoot: string | undefined): Promise<ClaudeReadiness> {
  return resolveClaudeReadiness({
    probeClaude: () => probeLoginShellOnPath(),
    classifyMcpEntry: () =>
      createMcpWiringCliSurface().classifyExistingMcpEntry('claude', osHomedir()).kind,
    isProjectMcpPreApprovable: () => isProjectClaudeMcpOwn(projectRoot),
  });
}

/**
 * Resolve docked-terminal on-PATH readiness for a non-Claude agent CLI
 * (codex / cursor). `cli` maps to its fixed registry binary
 * (`TERMINAL_CLIS[cli].bin`), so the `command -v` probe is never
 * renderer-controlled. No MCP-wiring concept here — purely on-PATH.
 */
function resolveTerminalCliOnPath(cli: TerminalCli): Promise<CliReadiness> {
  return resolveCliOnPath({
    probe: () => probeLoginShellOnPath(cliProbeArgs(TERMINAL_CLIS[cli].bin)),
  });
}

/**
 * Time-to-live for the cached batched CLI installed-map. The New-chat default
 * auto-pick re-queries on each click; installs/uninstalls are rare, so a short
 * TTL spares four login-shell probes per click while staying fresh enough that a
 * just-installed CLI shows up within a minute.
 */
const CLI_INSTALLED_MAP_TTL_MS = 60_000;
let cliInstalledMapCache: { at: number; value: Promise<Record<TerminalCli, boolean>> } | null =
  null;

/**
 * Batched on-PATH readiness for all four CLIs, cached ~60s. Caches the in-flight
 * Promise (not the resolved value) so concurrent New-chat clicks share one probe
 * batch. `resolveCliInstalledMap` never rejects today (each entry degrades to
 * not-installed); the defensive `.catch` below evicts the cache if a future
 * change ever lets one through, so a transient failure becomes an immediate
 * retry rather than a 60s-cached rejection.
 */
function resolveTerminalCliInstalledMap(): Promise<Record<TerminalCli, boolean>> {
  const now = Date.now();
  if (cliInstalledMapCache && now - cliInstalledMapCache.at < CLI_INSTALLED_MAP_TTL_MS) {
    return cliInstalledMapCache.value;
  }
  const value = resolveCliInstalledMap({
    probe: (cli) => probeLoginShellOnPath(cliProbeArgs(TERMINAL_CLIS[cli].bin)),
  }).catch((err) => {
    // Don't let a rejected probe stay cached for the full TTL; the next call retries fresh.
    cliInstalledMapCache = null;
    throw err;
  });
  cliInstalledMapCache = { at: now, value };
  return value;
}

/**
 * Window to receive an immediate `ok:mcp-wiring:show` on the File-menu
 * re-trigger. Focused window preferred (the dialog appears where the user
 * just clicked the menu), any loaded window otherwise. Still-loading
 * windows are excluded — their renderer hasn't subscribed yet, but its
 * module-init `signalReady` will deliver the dialog via the armed
 * mount-ack fallback once it loads.
 */
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
  // After `did-finish-load` fires, the page has dispatched its `onload` event —
  // module-init listeners (like `installOnboardingToastListener`) are registered
  // and `webContents.send` is deliverable. Send directly without re-checking
  // `isLoading()`: Electron emits `did-finish-load` BEFORE `did-stop-loading`
  // flips `isLoading()` to false, so a same-navigation re-check returns true
  // and would re-arm a `once('did-finish-load')` listener that never fires
  // again on the same navigation. That race is what caused the empirically
  // observed 60s-watchdog-without-dispatch.
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

/**
 * Bound on the membership-set scoping for `ok:fs:remove-git-folder`.
 * Each `findEnclosingGitRoot` IPC return pushes its `gitRoot` here; the
 * destructive handler refuses anything not in the set. FIFO-evicted at
 * the cap so a long-lived session doesn't grow unbounded. The size is
 * generous enough that legitimate workflows (a user opening the Create
 * Project dialog repeatedly, switching parents, etc.) never evict a
 * candidate they're actively about to click on.
 */
const RECENT_GIT_ROOTS_CAP = 256;

function registerIpcHandlers() {
  const handle = createHandler(ipcMain);

  // Per-session membership set for `ok:fs:remove-git-folder`. Populated
  // by `ok:fs:find-enclosing-git-root` returns; read by the destructive
  // handler via the `allowedGitRoots` dep on `removeGitFolder`. Scope-
  // narrows the destructive surface so a compromised or fabricated
  // renderer payload can't target arbitrary `.git` directories.
  const recentGitRoots = new Set<string>();
  const recordRecentGitRoot = (gitRoot: string): void => {
    if (recentGitRoots.has(gitRoot)) {
      // Move-to-end for LRU-ish eviction: re-probe of an already-known
      // root keeps it from being evicted while the user is staring at
      // its banner.
      recentGitRoots.delete(gitRoot);
    }
    recentGitRoots.add(gitRoot);
    while (recentGitRoots.size > RECENT_GIT_ROOTS_CAP) {
      const oldest = recentGitRoots.values().next().value;
      if (oldest === undefined) break;
      recentGitRoots.delete(oldest);
    }
  };

  // Docked-terminal PTY mediator. Forks one `pty-host` utilityProcess per
  // window lazily on first create; coalesces + backpressures shell output.
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
  // Publish the reap surface so the window factory + will-quit can reach it.
  terminalReaper = terminalManager;

  handle('ok:pty:create', async (event, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const editorCtx =
      win && wm ? wm.getContextForBrowserWindow(win as unknown as BrowserWindowLike) : null;
    // A standalone terminal window is not in `windowsByPath` (one-per-project,
    // focus-existing), so `getContextForBrowserWindow` returns nothing for it.
    // Editor windows keep their existing per-project resolution; a terminal
    // window resolves its cwd from the windowId-keyed terminalWindows registry,
    // falling back to homedir() when project-less (never null — create() refuses
    // null). A window in neither map (e.g. the Navigator) resolves to null and
    // is refused below rather than spawning a shell at an arbitrary dir.
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
    // Trust-boundary backstop (fail-open): the terminal is allowed by default,
    // so refuse a real shell ONLY when the window's project-local
    // `terminal.enabled === false`. Absent/unreadable/malformed/null/true all
    // read as allowed. The renderer's TerminalGate is the UX enforcement; this
    // re-check means a renderer regression/compromise can't spawn a shell after
    // a human has explicitly opted the project out.
    //
    // A human opts out via a live CRDT config binding that reaches disk only
    // after the persistence debounce. The bounded re-read covers the inverse
    // race — re-enabling (false→absent) — so a shell-open immediately after
    // re-enable isn't refused on a stale `false`; never trusting the renderer.
    // The not-opted-out path stays instant and only a just-re-enabled open waits.
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
    if (req.action === 'rewire' && process.platform === 'darwin' && app.isPackaged) {
      // Re-arm MCP wiring: the same forceShow consent path as
      // File -> Set up OpenKnowledge integrations, so the user can wire
      // `open-knowledge` into Claude Code. Fires ONLY from the renderer's
      // re-wire button — agents have no ok:terminal:* surface, and the consent
      // dialog itself is human-only.
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
    // Scope the project-MCP pre-approval check to the caller window's project
    // (its `.mcp.json` is what `claude` reads in the PTY cwd). A window with no
    // bound project → undefined → not pre-approvable (Claude prompts).
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    const projectRoot =
      callerWin && wm
        ? wm.getContextForBrowserWindow(callerWin as unknown as BrowserWindowLike)?.projectPath
        : undefined;
    const readiness = await resolveTerminalClaudeReadiness(projectRoot);
    // Surface the rewire failure to the renderer so the button doesn't no-op
    // silently; readiness itself is still computed for the rest of the banner.
    return rewireError === undefined ? readiness : { ...readiness, rewireError };
  });

  handle('ok:terminal:cli-preflight', async (_event, req): Promise<CliReadiness> => {
    // `req.cli` crosses the IPC boundary as a compile-time `TerminalCli`, but
    // `createHandler` casts rawArgs without runtime enforcement — validate the
    // untrusted discriminant against the registry before it indexes
    // `TERMINAL_CLIS[...].bin`. An out-of-registry value yields a safe `unknown`
    // verdict (never a silent TypeError, never a `command -v <bad>` probe).
    if (!(req.cli in TERMINAL_CLIS)) {
      getLogger('terminal').warn({ cli: req.cli }, 'cli-preflight: unknown cli discriminant');
      return { onPath: 'unknown' };
    }
    return resolveTerminalCliOnPath(req.cli);
  });

  handle('ok:terminal:cli-installed-map', async (): Promise<Record<TerminalCli, boolean>> => {
    return resolveTerminalCliInstalledMap();
  });

  handle('ok:terminal:dock-state', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return { visible: win ? (dockVisibleForWindow.get(win.id) ?? false) : false };
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
    // Scope the spawn to the caller window's project directory. A
    // BrowserWindow without a ProjectContext (e.g. the Navigator, before it
    // spawns an editor) should never reach this handler, but we treat that
    // case as "no project scope" — a missing `projectPath` passes through to
    // `spawnCursorImpl` which gates on the presence of the field. The
    // validateSpawnPath + isPathWithinProject checks inside the impl refuse
    // any out-of-scope path when a project IS bound.
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
              // Drain stderr so a chatty child can't block on a full pipe buffer.
              child.stderr?.on('data', () => {});
              // `spawn` event fires once the process is successfully launched —
              // that's the success criterion (not a clean exit). The
              // macOS `/usr/bin/open` helper exits immediately after handing
              // off to Launch Services, but the `spawn` event still resolves
              // before exit, so this remains correct under the open-a routing.
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

  // Asset-open dispatch. Threads the caller window's
  // ProjectContext.projectPath so containment checks scope to the project
  // that owns the click — different windows (editor + navigator) don't see
  // each other's roots. Windows without a ProjectContext resolve as no-op
  // refusal (`path-escape`): a click from such a window has no legitimate
  // asset scope.
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

  // Native right-click context menu. Renderer plugin resolves the clicked
  // on-disk reference (asset chip, wiki-link chip, or image) and invokes
  // this with {relPath, title, kind}. Main builds the menu via
  // `Menu.buildFromTemplate` and pops it on the caller window —
  // gesture-attested because main observes the click directly (the
  // renderer plugin merely forwards the intent; the actual popup is
  // sourced in main). Actions route through the same `openAssetSafely` /
  // `revealAssetSafely` gates as the left-click flow.
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
    // Resolve caller window's project directory (undefined for Navigator).
    // Validation, refusal, and security rationale live in `showItemInFolderImpl`.
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
    // Channel result is `undefined` (silent-by-design — don't leak validation
    // signal back to a potentially-compromised renderer), but a refusal is
    // worth a main-side breadcrumb: a renderer bug constructing a wrong path
    // otherwise produces a "nothing happened" UX with no debug trail.
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
    // Path normalization happens at span-creation time using the renderer
    // input (pre-realpath). The post-realpath canonical path is what we'd
    // emit to logs/index — but it may include the user home prefix, so we
    // normalize-to-tail-two-segments to stay inside the cardinality budget
    // (`fs.*` span attribute STOP rule). Outcome attribute is set AFTER
    // dispatch so Tempo can filter ok-vs-failure span volume.
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
      // Main-side breadcrumb so a renderer-side toast failure-mode is
      // diagnosable from the desktop console — mirror of the
      // `show-item-in-folder refused` warn pattern above.
      console.warn('[main] trash-item refused', {
        reason: result.reason,
        detail: result.detail,
      });
    }
    return result;
  });

  handle('ok:editor:active-target-changed', async (_event, target) => {
    // Last-write-wins across windows — see `editorActiveTarget` declaration.
    // The renderer pushes after each navigation; main rebuilds the menu so
    // Rename / Duplicate / Move to Trash flip enabled/disabled per the new
    // scope. No attempt to dedupe identical successive pushes — the rebuild
    // is cheap and the renderer dedupes upstream where it matters.
    editorActiveTarget = target;
    refreshApplicationMenu();
    return undefined;
  });

  handle('ok:editor:view-menu-state-changed', async (event, state) => {
    // Sibling of the active-target push. Stored in module scope so the
    // next `refreshApplicationMenu` rebuild reads the latest snapshot.
    // Last-write-wins across windows matches the singleton menu model.
    editorViewMenuState = mergeViewMenuState(editorViewMenuState, state);
    // The menu snapshot is a singleton, but dock visibility must recover
    // per-window after a reload — record it keyed by the sender window so the
    // reloaded renderer reads back its own dock state, not another window's.
    if (state.terminalVisible !== undefined) {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) dockVisibleForWindow.set(win.id, state.terminalVisible);
    }
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
        // `nativeTheme.themeSource` crosses our trust boundary — it is owned
        // by Electron, not by our type system. The validator narrows the
        // value back to `OkThemeSource` at the read seam (symmetric with
        // the write-side guard `applyThemeSource` already runs on `source`)
        // and falls back to `'system'` if Electron ever widens the union.
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
    // Composition lives in `applyThemeApplied`. This handler resolves the
    // sender's BrowserWindow (Electron-specific surface) and threads the
    // structural collaborators in. See `theme-applied-handler.ts` for the
    // multiplexed-signal contract and the cross-window vibrancy fan-out +
    // per-window flicker memo.
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

  handle('ok:startup:renderer-marks', async (_event, marks) => {
    // Fold the renderer's two launch checkpoints into the waterfall. Fire-and-
    // forget from the renderer; we never reject (the renderer swallows anyway).
    // The payload crosses the IPC trust boundary untyped at runtime
    // (`createHandler` casts without enforcement), so validate that both marks
    // are finite before ingesting — a non-finite value would flow into
    // `round(NaN - appReady)` and JSON-serialize as `null` in the timeline log.
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
      collabUrl: `ws://localhost:${ctx.port}/collab`,
      apiOrigin: ctx.apiOrigin,
      projectPath: ctx.projectPath,
      projectName: ctx.projectName,
      mode: 'editor' as const,
      // Mirrors the preload's cold-start config: `true` under the Electron
      // smoke suite so the renderer uses xterm's DOM renderer (see TerminalPanel).
      e2eSmoke: process.env.OK_DESKTOP_E2E_SMOKE === '1',
      // Ephemeral single-file windows carry teardown state on `ctx.ephemeral`;
      // its presence IS the single-file signal for the renderer's chrome gate.
      singleFile: ctx.ephemeral !== undefined,
      // `initialDoc` is a cold-start-only hash seed (consumed once at renderer
      // boot from the preload-injected bridge config). A live window queried via
      // get-info has already navigated, so there is nothing to re-seed → null.
      initialDoc: null,
    };
  });

  // OK config sharing mode — read + toggle the sharing posture for
  // the active project window. Project scope flows from the WM context, so
  // the renderer cannot target a different project than the one its
  // window owns.
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
    // Enrich each present recent with its git-worktree relationship so the
    // renderer can nest linked worktrees under their main project. Each present
    // recent needs two git spawns (classify + branch); cold, that's up to ~40.
    // Run them concurrently via `Promise.all` of the async variants so the
    // response isn't gated on a serial chain of blocking spawns on the main
    // event loop — otherwise the switcher's first open renders visibly late.
    // `classifyRecentGitAsync` is memoized per path (repeat calls are cheap);
    // the branch label is read fresh since it changes on checkout. Missing
    // paths are left un-probed.
    return Promise.all(
      annotateMissing(appState).map(async (entry): Promise<RecentProject> => {
        if (entry.missing) return entry;
        const [git, branch] = await Promise.all([
          classifyRecentGitAsync(entry.path),
          // Resolve the branch via git (walks up), not a raw `.git/HEAD` read, so
          // a project opened at a git subdirectory (e.g. an OK subtree) still gets
          // its branch label.
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
    // Route through the wrapper so boot failures (lock collision, git-init
    // error, generic crash) surface as the standard Electron error dialog
    // + Navigator fall-back instead of escaping to the renderer as a raw
    // IPC error. Matches the menu / deep-link / last-opened-project paths.
    if (!isEntryPoint(request.entryPoint)) {
      throw new Error(
        `ok:project:open rejected: invalid entryPoint '${String(request.entryPoint)}'`,
      );
    }
    // Renderer-initiated share-receive opens (fresh clone, multi-worktree pivot)
    // reach window-open here instead of through the URL-scheme dispatcher, which
    // is where `dispatchResolvedShare` probes the target. Run the same probe so a
    // moved/deleted target flags `targetMissing` and the editor renders the
    // honest verdict panel instead of the create-mode editor. Synchronous native
    // probe — no new IPC — computed once for both the warm and cold branches.
    const targetMissing =
      request.pendingDeepLinkTarget !== undefined &&
      computeShareTargetMissing(checkTargetExistsImpl, request.path, request.pendingDeepLinkTarget);
    // Warm-focus path for share-receive: when an existing window holds the
    // requested project, focus it and dispatch the deep-link directly. Mirrors
    // the URL-scheme warm path in url-scheme.ts so the IPC and the deep-link
    // entry points stay equivalent.
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
          // Only carry the flag when set — keeps the common (present) case's
          // payload identical to the pre-gate shape.
          ...(targetMissing ? { targetMissing: true } : {}),
        });
        return undefined;
      }
    }
    // Warm-focus path for the share-receive branch-switch ("I have it
    // locally" on a mismatched branch). A branch-switch open carries no
    // `pendingDeepLinkTarget`, so the deep-link warm path above is skipped;
    // mirror it here so an already-open editor for this project gets the
    // `project-branch-switch` surface instead of being spawned cold. Mirrors
    // url-scheme.ts's warm `sendShareDeepLink` for the `fallback` case. For the
    // bug's hot path (repo not yet in recents) no window is open, so this falls
    // through to the cold spawn below.
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

  // Worktree selector (worktree = window). Git-only surface: enumerate
  // the sender window's project's branches + worktrees, or create/locate the
  // worktree for a branch under `<mainRoot>/.ok/worktrees/`. Opening the
  // resulting worktree window is the renderer's job (`ok:project:open` with
  // entryPoint `'worktree'`). A project-less window (Navigator) has no repo →
  // `no-git`. The window's `projectPath` is already realpath-canonicalized by
  // `discoverProject`, but we realpath defensively so the current-window flag
  // matches `listGitWorktrees`'s realpath-collapsed entry paths.
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
    return createWorktree({
      anchorPath: anchor,
      branch: request.branch,
      baseBranch: request.baseBranch,
      baseRef: request.baseRef,
      remoteRef: request.remoteRef,
      createBranch: request.createBranch,
    });
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

  handle('ok:project:restart-server', async (_event, projectPath) => {
    // Renderer-initiated from the version-drift notification. Terminates the
    // attached (not-owned) server and recreates the window against a fresh
    // own-version spawn. The returned outcome only reaches the renderer on
    // failure (a surviving window) — success recreates the originating window.
    // The try/catch makes the contract uniform: every path resolves with an
    // outcome rather than rejecting on a destroyed renderer.
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

  // ── Create-new-project dialog cascade IPC ─────────────────────────────────
  // Four read-only `ok:fs:*` probes + the `ok:project:create-new` writer.
  // Renderer-side cascade (`CreateProjectDialog`) calls the probes reactively
  // to render the inline banner; the writer re-runs every check server-side
  // as defense-in-depth (renderer is untrusted at the IPC boundary).

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
      // Membership-set scoping for `ok:fs:remove-git-folder`: the renderer
      // may only ask main to delete a `<gitRoot>/.git` that *main* surfaced
      // from a recent probe. Bounded FIFO so the set doesn't grow without
      // limit over a long-lived session. See `remove-git-folder.ts` and
      // `remove-git-folder.test.ts` for the full validation chain.
      recordRecentGitRoot(result.gitRoot);
    }
    return result;
  });

  // Destructive IPC scoped to a single shape: `<gitRoot>/.git`. Validation
  // chain lives in `remove-git-folder.ts` (testable pure function with
  // tmpdir-fixture coverage) — handler is a thin wrapper that owns only
  // the per-session `recentGitRoots` membership set.
  handle('ok:fs:remove-git-folder', async (_event, gitRoot) => {
    // Primary teardown: deterministically stop this worktree's OWN collab
    // server (+ ui sibling) BEFORE removing its `.git`, so a deleted worktree
    // doesn't leave an orphaned server holding a now-dangling lockDir. Reuses
    // the path-addressable `runStop` against the worktree's lockDir. Scoped to
    // the same `recentGitRoots` membership set that gates the delete itself, so
    // a fabricated path can't drive a stray SIGTERM. Best-effort: a worktree
    // with no running server is a no-op, and a stop failure must not block the
    // delete (idle-shutdown — 30min — is the backstop for anything missed).
    if (typeof gitRoot === 'string' && recentGitRoots.has(gitRoot)) {
      try {
        // Route runStop's own log through the structured logger (not stdout) so
        // the success path — which PIDs were SIGTERM'd before `.git` deletion —
        // is captured for incident forensics, not silently dropped.
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
        packId: args.packId,
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
        // Unexpected error type (TypeError, OOM, etc.) — still emit a
        // structured log line so triage has a main-side audit trail; the
        // renderer maps non-CreateNewProjectError shapes to `{reason:'unknown'}`.
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

    // Per-editor write outcomes → structured log line (count of failures
    // also feeds the OnboardingFlow span's ai_integrations_failed_count
    // attribute, same as the pick-existing dialog path).
    const aiFailedCount = logAiIntegrationOutcomes(result.aiIntegrations);

    // The user picked `args.parent`; persist that — NOT `result.target`'s
    // parent (which is the same here, but the contract is "remember where
    // the user wanted to put projects," not "remember where the last one
    // landed after sanitization").
    appState = setLastUsedProjectParent(appState, args.parent);
    saveAppState(appState);

    recordOnboardingFlow({
      flowKind: result.variant,
      entryPoint: 'create-new',
      gitInitRequested: !result.gitRootPromoted,
      // `result.defaultContentDir` is invariantly `'.'` (see the field's
      // JSDoc in `create-new-project.ts`). The create-new flow has no UI
      // for adjusting content scope at scaffold time, so this telemetry
      // attribute is always `false` here — emitted explicitly for parity
      // with the Pick-existing flow's payload shape.
      contentDirChanged: false,
      warningsCount: 0,
      failedCount: aiFailedCount,
    });

    // Paths logged verbatim: the bounded-cardinality STOP rule applies to
    // span/metric attributes, not pino log fields; the telemetry span emitted
    // just above stays bounded.
    getLogger('create-new').info(
      {
        projectDir: result.projectDir,
        target: result.target,
        variant: result.variant,
        gitRootPromoted: result.gitRootPromoted,
      },
      'created project',
    );

    // Open the editor window against the project root (the git root when
    // promoted, otherwise the user-facing folder). By now `projectDir`
    // carries `.ok/config.yml`, so `discoverProject`'s walk inside
    // `openProject` classifies it as `kind: 'managed'` and the silent
    // scaffold branch won't re-fire.
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

  // Schema-incompatibility IPC handlers. The pure handler bodies live in
  // `update-state-handlers.ts` so the unit tier can pin the composition
  // (persist → clear pending, including rollback on saveAppState failure).
  // The deps factory captures the live closures over `appState` /
  // `pendingSchemaIncompatibility`. `getBuildChannel` derives the channel
  // purely from the running binary's version string (no persisted
  // preference), so `ok:state:query` always matches the installed DMG.
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

  // `ok seed` — project-level scaffolder. Pure plan/apply handlers scoped to
  // the invoking window's ProjectContext (same pattern as `ok:shell:spawn-cursor`).
  // See packages/desktop/src/main/ipc/seed.ts.
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

  // Chat & Cowork skill install-dialog IPC.
  // Two channels: (1) detect Claude Desktop's presence, (2) build .skill
  // locally + invoke OS file association. No network, no GitHub Releases.
  // See packages/desktop/src/main/ipc/install-skill.ts.
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

  // Pre-project local-op flows for the Navigator window. The Navigator has
  // no backing API server (apiOrigin === ''), so the renderer's HTTP path
  // to `/api/local-op/auth/login` + `/api/local-op/clone` 404s on the
  // electron-vite dev server. These IPC handlers spawn the same CLI
  // subprocess directly from main and stream events back via webContents.
  // Editor windows continue to use the HTTP path — no regression.
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

/**
 * Settings → AI tools: persistent status/toggle IPC over the same install
 * actors as the first-launch consent dialog (`createMcpWiringOpts`) and the
 * startup reclaim — `writeUserMcpConfigs` + surgical removal for editors,
 * `ensureCliOnPath` / rc-block strip for the PATH shim, decision-gated
 * reclaim + teardown for the user-global skill bundles. `available` mirrors
 * the wiring gate set so the section renders read-only exactly where the
 * consent dialog would refuse to arm.
 */
function registerIntegrationsSettingsIpc(): void {
  const integrationsLogger = getLogger('integrations-settings');
  const available =
    process.env.OK_RECLAIM_DISABLE !== '1' &&
    process.platform === 'darwin' &&
    (app.isPackaged || process.env.OK_M6B_FORCE === '1') &&
    /\.app\/Contents\/MacOS\/[^/]+$/.test(app.getPath('exe'));
  const tildifyHomePath = (path: string): string => {
    const home = osHomedir();
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  };
  registerIntegrationsSettings({
    home: osHomedir(),
    available,
    ipcMain,
    cli: {
      // User-global surface only: `scope: 'project'` targets (Pi) have no
      // user-global MCP config to manage — their `configPath()` throws — so
      // they must not surface as a row here, mirroring the consent dialog's
      // and startup repair sweep's scope filter in `mcp-wiring.ts`.
      allEditorIds: ALL_EDITOR_IDS.filter((id) => EDITOR_TARGETS[id].scope === 'global'),
      editorLabel: (editorId) => EDITOR_TARGETS[editorId].label,
      detectInstalledEditors: (cwd, home) => detectInstalledEditors(cwd, home),
      classifyExistingMcpEntry: (editorId, home) =>
        classifyExistingMcpEntry(EDITOR_TARGETS[editorId], '', home),
      // The removal gate: `isEntryUpToDate` recognizes both the resolver-chain
      // and OpenCode shapes via the version sentinel; `isOwnManagedEntry` is
      // the exact canonical match. Same predicate `removeOwnMcpEntry` applies
      // internally, so a row shown as 'installed' is always removable.
      isOwnEntry: (entry) => isEntryUpToDate(entry) || isOwnManagedEntry(entry),
      editorConfigPath: (editorId) => {
        try {
          return tildifyHomePath(EDITOR_TARGETS[editorId].configPath('', osHomedir()));
        } catch {
          // Platform-mismatched resolver (e.g. Claude Desktop off-macOS).
          return null;
        }
      },
      editorEntryLocator: (editorId) => {
        const target = EDITOR_TARGETS[editorId];
        const server = target.serverName('');
        return target.format === 'toml'
          ? `[${target.topLevelKey}.${server}]`
          : [target.topLevelKey, target.serverMapSubKey, server].filter(Boolean).join('.');
      },
      writeUserMcpConfigs: (writeOpts) => writeUserMcpConfigs(writeOpts),
      removeUserMcpEntry: (editorId) =>
        removeOwnMcpEntry(EDITOR_TARGETS[editorId], '', osHomedir()),
    },
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
      computeStatuses: () =>
        USER_GLOBAL_BUNDLE_IDS.map((id) => {
          const home = osHomedir();
          const name = BUNDLE_SKILL_NAME[id];
          return {
            id,
            name,
            installed: existsSync(join(home, '.agents', 'skills', name)),
            // Central copy always; per-host copies only where the host root
            // exists (mirrors installUserBundleToHostDirs' skipped-host-absent).
            paths: [
              `~/.agents/skills/${name}`,
              ...HOSTS_WITH_USER_SKILL_DIR.filter((h) => existsSync(join(home, h.hostDir))).map(
                (h) => `~/${h.hostDir}/skills/${name}`,
              ),
            ],
          };
        }),
      setEnabled: async (bundleId, enabled) => {
        const home = osHomedir();
        const id = USER_GLOBAL_BUNDLE_IDS.find((b) => b === bundleId);
        if (!id) return { ok: false as const, error: 'Unknown skill.' };
        const name = BUNDLE_SKILL_NAME[id];
        // Decision first (the durable record every install actor gates on),
        // then the disk effect — same order as the consent-dialog leg.
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
        // Verify by effect — the reclaim reports per-target entries, but the
        // central-store dir is the definitive "installed" signal every other
        // surface reads.
        if (!existsSync(join(home, '.agents', 'skills', name))) {
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

/**
 * Settings → This project → AI tools: persistent status/toggle IPC over the
 * same PROJECT-LOCAL install actors as the per-project onboarding dialog and
 * the reclaim-on-open sweep — `writeEditorMcpConfig` / `removeOwnMcpEntry` with
 * a project config-path override for the per-editor MCP files, and
 * `writeProjectSkill` / `removeProjectSkill` for the project runtime skill.
 * Every request resolves the sender window's project (webContents →
 * ProjectContext) so the renderer can never target a foreign directory.
 * `available` mirrors the global surface's gate set.
 */
function registerProjectIntegrationsSettingsIpc(): void {
  const projectLogger = getLogger('project-integrations-settings');
  const available =
    process.env.OK_RECLAIM_DISABLE !== '1' &&
    process.platform === 'darwin' &&
    (app.isPackaged || process.env.OK_M6B_FORCE === '1') &&
    /\.app\/Contents\/MacOS\/[^/]+$/.test(app.getPath('exe'));
  const tildifyHomePath = (path: string): string => {
    const home = osHomedir();
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  };
  // The canonical project skill lives under Claude Code's `.claude/skills/`; its
  // presence is the single row's checked state (the write fans out to every
  // capable editor, but the `.claude` copy is the one the discovery skill and
  // CLAUDE.md reference).
  const canonicalSkillTarget = EDITOR_TARGETS.claude;
  const projectInstallOpts: McpInstallOptions = { mode: 'published', skipAvailabilityCheck: true };

  const cli: ProjectIntegrationsCliSurface = {
    allEditorIds: ALL_EDITOR_IDS,
    editorLabel: (id) => EDITOR_TARGETS[id].label,
    projectConfigPath: (id, projectDir) =>
      EDITOR_TARGETS[id].projectConfigPath?.(projectDir) ?? null,
    projectSkillPath: (id, projectDir) => EDITOR_TARGETS[id].projectSkillPath?.(projectDir) ?? null,
    entryLocator: (id) => {
      const target = EDITOR_TARGETS[id];
      // `format: 'file'` targets (Pi) own a whole managed file, not a keyed
      // entry — there is no dotted/table locator to show.
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

/**
 * Path to the Dock/app icon PNG. Hand-authored 1024² file committed to the
 * repo at build/icon.png. In packaged builds, electron-builder copies this
 * into the app bundle and generates .icns from it (electron-builder.yml
 * `icon:` key) — `app.dock.setIcon()` is a no-op for the packaged case
 * because Gatekeeper already knows the bundle's icon. In dev mode, we set
 * it at runtime so the Dock shows the real icon instead of the generic
 * Electron diamond.
 */
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

/**
 * Defensive CORS injector for localhost responses — bulletproofs the attach
 * path against older `ok start` CLI servers that predate the api-extension
 * CORS change. Background: the renderer origin (electron-vite dev server OR
 * `file://` in packaged builds) is cross-origin to the utility process's
 * `http://localhost:<port>`, so browser CORS policy applies to every `/api/*`
 * fetch. Our current server emits `Access-Control-Allow-Origin: *` natively,
 * but if an older CLI owns the `server.lock` (attach mode) it does NOT — every
 * sidebar load surfaces as "Could not reach server" even though `curl` shows
 * HTTP 200 + valid JSON.
 *
 * Two behaviors:
 *   1. Any localhost response missing `Access-Control-Allow-Origin` gets
 *      `*` + `Allow-Methods` + `Allow-Headers` injected. Safe because the
 *      server binds 127.0.0.1 only — no remote origin could ever reach it.
 *   2. A `405`/`404` to an `OPTIONS` preflight from such a server is rewritten
 *      to `204 No Content` with the CORS headers so POSTs with a JSON body
 *      (which trigger a preflight) don't fail before the real request fires.
 *
 * Both are gated on hostname (`localhost` / `127.0.0.1`) and on `hasAcao`
 * being false — we leave responses from CORS-aware servers (our current
 * api-extension + any future release) untouched.
 */
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

/**
 * Rewrite outbound `Referer` for YouTube embed-iframe requests so the
 * iframe player accepts the embed when the renderer is loaded via
 * `file://` in packaged builds. Sibling pattern to
 * `installLocalhostCorsInjector` — same Electron session-level hook,
 * scoped to the embed hosts that gate on Referer.
 *
 * The rewrite logic itself lives in `embed-referer.ts` so the
 * behavior is unit-testable without touching `session.defaultSession`.
 * Full rationale (why Error 153 happens, why `https://inkeep.com/`,
 * why YouTube-only) is in that module's docstring.
 */
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

// Single-instance lock — required for `app.on('second-instance')` to fire
// AND to prevent a duplicate OK.app launch from racing state.json +
// server.lock with the primary. A duplicate launch that carries an
// `openknowledge://` URL in argv (`OK.app/Contents/MacOS/OpenKnowledge
// openknowledge://...`) relinquishes the lock; Electron then dispatches its
// argv to the primary via the `second-instance` listener registered below.
// If we fail to acquire the lock we ARE the duplicate — exit without
// registering any of the boot-time handlers below.
//
// Earliest possible main-process side effect — must precede any stdout/stderr
// write so no timer-driven log can race ahead of the guard. See
// process-safety-net.ts for why this is a stream-level guard, not a global
// uncaughtException handler.
const safetyNetLogger = getLogger('process-safety-net');
installStdioBrokenPipeGuard(process, {
  onNonBenignError: (stream, err) => {
    safetyNetLogger.error(
      { stream, code: (err as NodeJS.ErrnoException).code, message: err.message },
      'unexpected stdio stream error',
    );
  },
});

// Driver-mode exception: when the env triplet
// `OK_DEBUG_KEYRING_SMOKE=1 + OK_DEBUG_KEYRING_SMOKE_EXIT=1` is set, the
// packaged app is being launched by the `verify-keyring-in-packaged-dmg.mjs`
// driver for a creds-free packaged-DMG smoke. Short-circuit at the top of
// boot — spawn a standalone utility, wait for its auto-smoke + self-exit,
// then `app.quit()`. No single-instance lock, no Navigator, no window
// creation. The utility's auto-smoke writes `KeyringSmokeResult` JSON to
// `OK_DEBUG_KEYRING_SMOKE_OUT` before exiting; the driver reads the file.

// Dev-only parallel-instance isolation. Electron keys the single-instance lock
// on `userData` (and Chromium storage + recents live there), so two desktop
// processes sharing one `userData` can't coexist — the second fails
// `requestSingleInstanceLock()` and quits. `OK_INSTANCE=<name>` relocates this
// launch's `userData` to a named sibling dir, giving each instance its own lock
// + isolated storage. Must run before `requestSingleInstanceLock()` and any
// `userData` read; packaged builds ignore it so releases are never affected.
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

// Differentiate parallel instances: when this launch uses a per-instance
// `userData` (the parallel-instance launcher's `--user-data-dir`, or dev
// `OK_INSTANCE`), surface that instance's name in the macOS menu-bar app name
// and window titles so multiple instances are tellable apart. No-op for the
// default install. Runs after `userData` is final, before any window is created.
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

  // Capture renderer console output into the desktop pino log
  // (`~/.ok/logs/desktop.<date>.log`, bundled by `ok bug-report`). Registered
  // before `whenReady` so every window's webContents is covered from creation.
  app.on('web-contents-created', (_event, contents) => {
    attachRendererConsoleCapture(contents);
  });

  // URL-scheme handler — register BEFORE `whenReady` so macOS cold-start
  // `open-url` Apple Events are caught even if they fire before the ready hook.
  // Listener registration is synchronous; the actual routing defers URLs into a
  // queue and drains them after `whenReady` + the first BrowserWindow exists.
  // Also wires `second-instance` for CLI / dev invocations that deliver the URL
  // via argv rather than Apple Events.
  const protocolControl = registerProtocolHandler({
    app: {
      on: (event, cb) => {
        // electron's `app.on` is overloaded — inject our typed shape by casting at
        // the call site. The `url-scheme` module owns the narrowing; this is just
        // the dispatch plumbing.
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
      // Use the Navigator-fallback path: on failure (bad path, git-init error,
      // stale lock) the user sees a dialog and is returned to the Navigator
      // rather than a silent "link doesn't work." Success path returns the
      // BrowserWindow so the caller can dispatch `ok:deep-link`.
      //
      // `pendingDeepLinkTarget` + `pendingBranch` + `pendingMultiCandidate`
      // + `pendingTargetMissing` + `pendingShareBranchSwitch` thread through
      // `wm.createProjectWindow`, which registers each one's readiness-gated
      // delivery BEFORE `loadURL` awaits. Delivery happens inside the
      // window-manager hook — no post-load dispatch here.
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
        // The fallback ran — dialog shown, Navigator reopened. Return null so
        // the caller knows the spawn failed (nothing to dispatch).
        return null;
      }
      return ctx.window as unknown as object;
    },
    // `openknowledge://open?file=<abs>` — the desktop side of `ok <file>`.
    // `openEphemeralFile` re-derives the plan and routes project-vs-
    // ephemeral itself, so the url-scheme layer just hands off the path.
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
        // The shared selector inline-filters `missing:true` entries from
        // its input, so the annotated projection is the production wiring
        // (mirrors how the renderer's bridge.listRecentProjects() surfaces
        // the same list).
        listRecent: () => annotateMissing(appState),
      }),
    // Kind-aware target-existence gate, run after `branch-match-ok` and before
    // dispatch (see `dispatchResolvedShare`). Native synchronous probe — no IPC.
    checkShareTargetExists: (projectPath, kind, path) =>
      checkTargetExistsImpl(projectPath, kind, path),
    routeShareToNavigator: (payload) => {
      // `openNavigator(payload)` handles both cold-create (cold path:
      // `createNavigatorWindow` registers `once('dom-ready', ...)` BEFORE
      // `loadFile`/`loadURL`) and warm-focus (warm path: `isLoading()`
      // gate → immediate send when loaded, `once('did-finish-load')` when
      // still mid-load). It always leaves `navigatorWindow` set (or throws on
      // an unrecoverable BrowserWindow failure that propagates), so there is
      // no post-call null state to guard. No post-call dispatch needed here.
      openNavigator(payload);
    },
    openScreen: (win, screen) => {
      // Same URL-hash trigger the app menu uses (`openSettings` /
      // `openInstallSkillDialog` above) — funnels deep links through the
      // renderer's existing client-side mount path. The Record gives
      // exhaustiveness: a new ScreenTarget without a hash here is a type error.
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
      // Startup instrumentation: stamp the launch origin and stand up the
      // OTel root (Plan A). `beginRoot` is fault-isolated + gated on
      // OTEL_SDK_DISABLED, so this is a near-free no-op when telemetry is off;
      // its return tells the waterfall whether main spans are live.
      startupWaterfall.mark('appReady');
      startupWaterfall.otelEnabled = beginRoot();
      // One-time userData migration for the "Open Knowledge" → "OpenKnowledge"
      // rename. Dormant until the packaged productName flips the userData
      // basename to "OpenKnowledge"; then it relocates a verified-ours legacy
      // "Open Knowledge" dir and cleans it up. Runs BEFORE the first-run probe
      // + loadAppState below so the migrated state is loaded, not treated as a
      // fresh first run. Routes events to the pino file logger so a failed
      // migration is visible in production logs, not just on the console.
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

      // Configure the native About panel with the project copyright + GPLv3
      // notice (the GUI "Appropriate Legal Notices" surface). Idempotent.
      app.setAboutPanelOptions(buildAboutPanelOptions(app.getVersion()));

      // True-first-run signal for the deferred-share handshake: captured BEFORE
      // bootstrap, which writes state.json and would otherwise erase the signal.
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
      // Startup instrumentation: bootstrap (IPC handlers, menu, dock, state)
      // is complete; the next launch phase is the project-window open + spawn.
      startupWaterfall.mark('bootstrapDone');

      // Re-broadcast a pending downloaded-update to any window opened from now
      // on. The relaunch banner (Toast A, `ok:update:downloaded`) fans out once
      // per `update-downloaded` to every window then-open; a window opened
      // *afterwards* missed that event, so resend it once the new window's
      // renderer has loaded its subscriber (the module-level update-notices
      // store attaches it before React mounts). `versionPendingInstall` is read
      // inside the `did-finish-load` callback, not at window-create time, so a
      // user who clicked "Relaunch now" in another window in the meantime
      // (`ok:update:relaunch-now` clears the field before `quitAndInstall()`)
      // doesn't get a stale banner here. Nothing staged → no-op.
      app.on('browser-window-created', (_event, win) => {
        win.webContents.once('did-finish-load', () => {
          // Update notices are a production-only surface. In a dev build
          // (unpackaged, no OK_UPDATER_FORCE_DEV) a persisted
          // `versionPendingInstall` is stale dev/test residue — the auto-updater
          // suppresses its boot-time emits there, so suppress this late-window
          // re-broadcast on the same signal for parity (else a newly-opened dev
          // window resurfaces the staged-update banner the boot path withheld).
          if (!(app.isPackaged || process.env.OK_UPDATER_FORCE_DEV === '1')) return;
          const pending = appState.versionPendingInstall;
          if (pending) {
            sendToRenderer(win.webContents, 'ok:update:downloaded', { version: pending });
          }
          // Late-window release-notes delivery: a project opened while the
          // what's-new notice is still live (within its ~60s window and not
          // dismissed) still shows the card. `getActiveWhatsNew` returns null
          // once that window elapses or the notice was dismissed, so an
          // unrelated window opened later gets nothing.
          const whatsNew = autoUpdaterHandle?.getActiveWhatsNew();
          if (whatsNew) {
            sendToRenderer(win.webContents, 'ok:update:whats-new', whatsNew);
          }
        });
      });

      // First-launch MCP consent. Armed before the window-open branch so the
      // `ok:mcp-wiring:renderer-ready` listener is installed BEFORE any
      // renderer could possibly fire it — otherwise a fast `did-finish-load`
      // → React-mount would race and the ack event lands on a dead channel.
      // `runMcpWiringOnFirstLaunch` no-ops (returns an inert handle) when the
      // platform is non-darwin, the app is in dev mode without
      // `OK_M6B_FORCE=1`, the user-scoped marker is present, or
      // `app.getPath('exe')` doesn't match the bundle shape. The cli surface
      // is imported via the published-package name `@inkeep/open-knowledge`
      // so turbo's `^build` topology correctly invalidates desktop's cache
      // when CLI internals change. Rollup tree-shakes unused CLI code at
      // electron-vite build time, keeping the DMG bundle size bounded.
      mcpWiringHandle = armMcpWiring();
      // Startup path-install runs WITHOUT a consent decision: OK-owned
      // steps (`~/.ok/bin` symlinks, `~/.ok/env.sh`) always self-heal, but
      // the rc-file append requires a recorded `consent: granted` on the
      // marker or grandfather evidence (a healthy managed block already on
      // disk). A fresh machine gets no rc write here — the consent dialog's
      // confirm path is the sole finalizer of a new decision.
      void Promise.allSettled([
        checkAndRepairMcpWiringOnStartup(createMcpWiringOpts()),
        ensureCliOnPath(buildEnsureCliOnPathOpts()),
      ])
        .then(([mcpSettled, pathSettled]) => {
          // A hard rejection here is a whole-operation failure, not editor-
          // specific — keep failedEditors empty (the failed-toast copy never
          // names editors) and log the real error instead.
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

      // Every project open spawns a NEW editor window. Boot restore order:
      //   1. An update relaunch left a `pendingWindowRestore` snapshot — open
      //      EVERY project that was open before the relaunch, not just the
      //      last one. The snapshot is consumed unconditionally (cleared to
      //      null + persisted) before any window opens, so a crash mid-restore
      //      can't loop it. A non-null-but-empty/all-missing snapshot opens
      //      the Navigator and deliberately does NOT fall through to
      //      `lastOpenedProject` — the relaunch is honored as "nothing was
      //      open" rather than reopening a stale project.
      //   2. Otherwise restore `lastOpenedProject` into one editor window.
      //   3. Holding Option (`--navigator`) or having nothing to restore
      //      opens the Navigator instead.
      const decision = await resolveBootRestoreDecision({
        pendingRestore: appState.pendingWindowRestore,
        lastOpenedProject: appState.lastOpenedProject,
        optionHeld: process.argv.includes('--navigator'),
        pathExists: existsSync,
        // A launch-claiming URL that opens its own window — a single-file open
        // (`ok <file>`) OR a valid share — suppresses the default boot-restore
        // window so the URL flush owns the launch. Read AFTER the settle barrier
        // resolves: on macOS the `open-url` Apple Event can land after this point
        // in the boot chain, so reading the flag synchronously here would miss a
        // cold-start share and open the previously-opened project instead.
        urlLaunchOwnsWindow: protocolControl.urlLaunchOwnsWindow,
        waitForUrlLaunchSettled: protocolControl.waitForUrlLaunchSettled,
      });
      // Field signal distinguishing "a URL owned the launch" from "restored
      // despite an inbound share" — the settled flag/decision pair is otherwise
      // unobservable outside a debugger.
      getLogger('startup').info(
        { urlLaunch: protocolControl.urlLaunchOwnsWindow(), action: decision.action },
        'boot-restore decision',
      );
      if (decision.clearSnapshot) {
        appState = { ...appState, pendingWindowRestore: null };
        if (!saveAppState(appState)) {
          // Persisting the cleared snapshot failed, so it may replay on the
          // next boot. The existsSync filter limits the blast radius to
          // projects that still exist on disk.
          console.warn('[main] failed to persist cleared window-restore snapshot', {
            projectCount: decision.action === 'restore' ? decision.projects.length : 0,
          });
        }
      }

      // Git preflight — runs for every launch EXCEPT a single-file deep-link,
      // whose ephemeral server boots git-off. Projects use git for the shadow
      // repo, so a missing/old binary surfaces here as a recoverable native
      // dialog (Open Install Page / Retry / Quit) instead of a spawn-ENOENT deep
      // in a later CRDT trace, BEFORE the project window + detached server child
      // are created. The Navigator preflights too — it opens no git-backed server
      // itself, but it's the gateway to project opens, so the gate stays where it
      // was pre-fix. Only the no-project ephemeral single-file shape skips it:
      // that server boots git-off, so requiring git would block `ok <file>` for a
      // user without it. A share launch ALSO yields `action: 'none'` (it
      // suppresses the default window) but opens/clones a git-backed project, so
      // it still preflights — gate on `singleFileLaunch()`, not the bare `'none'`.
      // A project later opened from a single-file session falls back to the
      // server child's own bootServer() preflight as the backstop.
      const skipGitPreflight = decision.action === 'none' && protocolControl.singleFileLaunch();
      if (!skipGitPreflight) {
        const gitOutcome = await ensureGitAvailable({
          assertGitAvailable,
          // Electron's MessageBoxOptions wants a mutable `buttons: string[]`; the
          // handler's contract uses `readonly string[]`. Spread to a fresh
          // mutable copy at the boundary.
          showMessageBox: async (opts) =>
            dialog.showMessageBox({ ...opts, buttons: [...opts.buttons] }),
          openExternal: (url) => shell.openExternal(url),
          log: { warn: (msg, obj) => console.warn(msg, obj) },
        });
        if (gitOutcome === 'aborted') {
          // User clicked Quit (or an unrecoverable non-typed error fired). Open
          // no window; bootstrap ran but no project window/server was spawned.
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
        // 'none' — a launch-claiming URL (single-file deep-link or valid share)
        // owns this launch. Open no default window; drain the queued URL now (the
        // window manager is ready post-bootstrap) so the URL-driven window opens
        // immediately rather than waiting out the auto-flush's window-ready retry
        // budget.
        protocolControl.drainQueuedUrls();
      }

      // Deferred-share first-run handshake. Fire-and-forget — it never claims
      // the launch (redemption is probabilistic) and runs concurrently with the
      // rest of boot. Gated to the fresh-install Navigator path (`'navigator'`):
      // a project restore or a single-file/url launch means the user already
      // arrived somewhere, so opening a `/continue` browser tab would be noise.
      // Every failure mode degrades to the splash re-click recovery.
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

      // Fire-and-forget user-global Agent Skill reclaim. Runs on every launch
      // — force-writes each ENABLED bundle's SKILL into the central store and
      // per-host dirs (per-bundle opt-in gated; declined bundles are removed).
      // PATH-independent (no npx subprocess), so it survives the GUI launch
      // context where /opt/homebrew/bin and ~/.nvm/… are off PATH. Never
      // awaited so window rendering + menu are unblocked.
      void reclaimUserSkillsOnLaunch(buildReclaimUserSkillsOpts()).catch((err) => {
        console.warn('[main] user-skill reclaim failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });

      // Auto-updater — wired as the LAST step in whenReady, after the window-
      // open branch (either openProjectOrFallbackToNavigator OR openNavigator).
      // Not gated on createNavigatorWindow specifically — Navigator only opens
      // on the Option-held / no-last-project path, but the updater must run on
      // every boot path. `electron-updater` is imported dynamically so unit
      // tests that import main/index.ts indirectly don't pull in the
      // Electron-only runtime dependency.
      //
      // Routed through `bootAutoUpdater` — a thin testable wrapper that
      // centralizes the dynamic-import + startAutoUpdater try/catch contract.
      // A silent dynamic-import failure (bundling drift, corrupt node_modules,
      // future Electron upgrade that desyncs the electron-updater version)
      // would leave the app session un-updateable with no signal; the wrapper
      // logs the failure at `error` level so operators see it in the
      // packaged-app console output and returns null so `autoUpdaterHandle`
      // stays null (destroy on will-quit no-ops).
      autoUpdaterHandle = await bootAutoUpdater(() => import('electron-updater'), {
        // Route the auto-updater's diagnostics into the pino file logger. Its
        // Logger interface is `(msg, ctx?)`; `getLogger` is `(data, msg)`, so
        // adapt the shape. Without this the updater falls back to its
        // console-only DEFAULT_LOGGER, which a packaged build never persists —
        // leaving the relaunch trigger, channel vetoes, and update events
        // invisible in `~/.ok/logs/`.
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
          // Rollback in-memory on disk-save failure so persistSafely-false in
          // auto-updater.ts truly means "no gate armed". `saveAppStateToDir`
          // returns a success boolean — on failure it has already logged +
          // cleaned up; we just revert the in-memory commit and throw so
          // persistSafely's catch registers the failure, skips the broadcast,
          // and leaves memory + disk agreeing on "nothing armed."
          // `saveAppStateToDir` itself never throws, so the rollback path is
          // reached purely via the return value.
          const prev = appState;
          appState = next;
          const ok = saveAppState(appState);
          if (!ok) {
            appState = prev;
            throw new Error('saveAppState failed — rolled back in-memory state');
          }
        },
        // Single-window target for the one-shot prompts that shouldn't multiply
        // (Toast C stuck-hint). Prefer the focused window so the prompt lands
        // where the user is looking; fall back to the first open window; null
        // when none is open so the broadcast helper no-ops.
        getPrimaryWindow: () => {
          const focused = BrowserWindow.getFocusedWindow();
          if (focused) return focused;
          const all = BrowserWindow.getAllWindows();
          return all[0] ?? null;
        },
        // Fan-out target for the relaunch banner (Toast A), the release-notes
        // notice (Toast B), and its cross-window dismiss — a staged update and
        // "what's new" should be actionable/visible from whichever window the
        // user is looking at, and a dismiss must reach every window.
        getAllWindows: () => BrowserWindow.getAllWindows(),
        getAppVersion: () => app.getVersion(),
        isPackaged: app.isPackaged,
        forceDevBypass: process.env.OK_UPDATER_FORCE_DEV === '1',
        // smoke override: point the updater at a local mock HTTP server
        // that serves a hand-crafted `latest-mac.yml` + fake .zip with valid
        // sha512. Production leaves this unset and reads `publish: github`
        // from `app-update.yml`. Paired with `OK_UPDATER_FORCE_DEV=1` (above)
        // so the `checkForUpdates()` gate actually hits the network in a dev
        // build. See `packages/desktop/scripts/smoke-mock-update.mjs --keep-alive`
        // for the server side.
        feedUrl: process.env.OK_UPDATER_FEED_URL || undefined,
        // Point the updater feed at the openknowledge.ai proxy so updates are
        // counted per version. The proxy 302s to the byte-identical GitHub
        // asset, preserving the manifest sha512 and the macOS signature; a feed
        // failure reverts to the GitHub provider for the session. Both channels
        // are enabled now that an end-to-end beta auto-update
        // has been confirmed through the proxy; the `latest` (stable) path
        // resolves via GitHub's authoritative `releases/latest` alias.
        proxyFeed: {
          base: 'https://openknowledge.ai/updates',
          channels: new Set<UpdateChannel>(['beta', 'latest']),
        },
        // Toast B renderer-mount race —
        // defer the dispatch until the primary window's renderer has
        // finished loading so its `<UpdateToast/>` subscribers are
        // attached. Without this, `webContents.send` sent from this very
        // `app.whenReady()` handler is dropped on the floor (Electron does
        // NOT buffer renderer-bound events before `did-finish-load`). If
        // the primary window has already loaded by the time Toast B fires
        // (rare — updater wires before loadURL resolves), fire immediately.
        whenRendererReady: (fn) => {
          // Three cases, all must deliver Toast B eventually because
          // `lastSeenVersion` has already advanced at the call site and the
          // contract ("user sees a toast on first launch post-update")
          // does not allow silent-drop — close the
          // `lastSeenVersion`-advanced-but-broadcast-lost gap that the
          // no-window race would otherwise open.
          //
          //   1. Window exists + already loaded → fire immediately.
          //   2. Window exists + still loading  → wait for did-finish-load.
          //   3. No window yet                  → wait for the next
          //      `browser-window-created` event, then recurse into cases
          //      1/2 against the fresh window.
          //
          // Electron emits `browser-window-created` synchronously inside
          // `new BrowserWindow(opts)`; `once` self-detaches after the first
          // firing so this listener can't leak across future spawns. If
          // the user quits the app before any window ever opens (pathological
          // — macOS doesn't dispatch Cmd+Q without a window), the listener is
          // garbage-collected alongside the `app` object at process exit.
          //
          // `getURL() === ''` distinguishes a freshly-constructed window
          // (loadURL not yet called) from an already-loaded one. Without it,
          // a fresh window emerging via `browser-window-created` registers
          // `isLoading() === false` and falls through to `fn()` synchronously
          // — sending the IPC before the renderer's main.tsx has run + before
          // `installUpdateNoticesBridge()` has attached the subscriber.
          // Electron drops main→renderer IPC sent against an unloaded page.
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
        // Pre-relaunch teardown — synchronously hard-kill every project-window
        // utility (Hocuspocus host) right before
        // `autoUpdater.quitAndInstall()` so Squirrel.Mac's `pgrep` against
        // the bundle path doesn't see a stale process and abort with code -9
        // ("App Still Running Error"). The graceful `{type:'shutdown'}`
        // window-close IPC isn't fast enough — Hocuspocus drain + file-watcher
        // teardown can outlast ShipIt's poll budget.
        prepareForRelaunch: async () => {
          // Snapshot every open project window so the post-update boot
          // restores all of them — not just `lastOpenedProject`. Persist
          // BEFORE the server shutdown: `saveAppState` is a synchronous tmp-
          // write + rename that completes well before `stopAllOwnedServers`
          // returns or `quitAndInstall()` fires.
          const openProjects = wm?.getOpenProjectPaths() ?? [];
          appState = { ...appState, pendingWindowRestore: openProjects };
          if (!saveAppState(appState)) {
            // Persisting the snapshot failed, so the post-update boot may not
            // reopen all the windows that were open before the relaunch.
            console.warn('[main] failed to persist window-restore snapshot before relaunch', {
              projectCount: openProjects.length,
            });
          }
          // Two-phase shutdown: SIGTERM detached server pids (and SIGKILL any
          // dev-path utilityProcess.fork helpers), then poll the lock files
          // until they release or 10 s elapses, then escalate to SIGKILL on
          // detached pids whose drain ran long. Awaiting here means the
          // updater's `quitAndInstall` waits for the process tree to be
          // genuinely clean before ShipIt's pre-swap `pgrep` runs.
          await wm?.stopAllOwnedServers();
          // Drain the async log buffer before `quitAndInstall()` hands off to
          // Squirrel, which SIGKILLs this process for the bundle swap. Without
          // this, the relaunch-trigger + update lines emitted moments earlier
          // never reach disk (the destination is `sync: false`).
          flushDesktopLogger();
        },
        // User feedback for menu-driven `Check for Updates…` clicks. The
        // periodic hourly check stays silent on a no-update outcome (the
        // existing `update-not-available` log-only handler), but a manual
        // gesture deserves explicit confirmation. macOS HIG / Sparkle
        // convention is a modal dialog parented to the active window.
        showCheckNowResult: (result) => {
          const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          // No-window case is rare on macOS (the app keeps the dock icon
          // alive past last-window-close, and the menu is unreachable
          // without at least one window) but cleanly degrade if it
          // happens — a missing parent makes showMessageBox throw on some
          // Electron versions.
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
      // Re-install the menu now that the auto-updater handle exists, so the
      // "Check for Updates…" entries actually have something to invoke.
      refreshApplicationMenu();

      // Mid-session drag-replace detector. AppKit caches `Info.plist` at
      // process launch (`NSBundle.mainBundle`); when a user drags a new
      // `.app` over `/Applications/OpenKnowledge.app` while the app is
      // running, every in-process reader (About panel, telemetry, Activity
      // Monitor Get Info) keeps serving the OLD version until the user
      // quits and relaunches. The auto-updater's `quitAndInstall` doesn't
      // hit this — it fully terminates the process before swapping — so
      // this watcher only ever fires for the manual drag-replace path.
      // Packaged macOS only: dev builds run from a non-bundle layout
      // (electron-vite → unpacked Resources), so there's no on-disk
      // `.app/Contents/Info.plist` to compare against `app.getVersion()`.
      if (process.platform === 'darwin' && app.isPackaged) {
        const exePath = app.getPath('exe');
        // `<exe>` resolves to `<…>/OpenKnowledge.app/Contents/MacOS/OpenKnowledge`,
        // so the Info.plist sits two dirnames up.
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
      // Boot diagnostic safety net. Without this, an unhandled rejection in
      // the whenReady chain (runBootstrap throw, dynamic import failure,
      // armMcpWiring synchronous error, etc.) leaves the user with no
      // window and only the unhandled-rejection banner in stderr.
      // Structured warn is the grep-able diagnostic trail.
      //
      // No `dialog.showErrorBox` here — that call is blocking on macOS.
      // firing it from the
      // unhandled-rejection path freezes the main process and prevents
      // show-gate's setTimeout from resolving, which causes smoke tests
      // (and real cold-launches in the same failure shape) to hang
      // instead of fail loudly. The "no window" failure mode is
      // acceptable here because boot already failed unrecoverably.
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? (err.stack ?? '') : '';
      console.error(JSON.stringify({ event: 'whenReady-unhandled-rejection', message, stack }));
    });

  // App-lifecycle breadcrumbs for diagnosing unexpected restarts. A genuine
  // crash fires NONE of these (the process dies with no quit sequence); a
  // controlled quit fires `before-quit` → `will-quit`; an auto-update install
  // additionally fires `before-quit-for-update`. Each flushes so the line
  // survives the imminent exit.
  app.on('before-quit', () => {
    getLogger('lifecycle').info({}, 'before-quit');
    // Flush pending startup telemetry before exit. `emitStartupWaterfall`
    // covers a quit during the post-window-shown flush-deadline window (the
    // `.unref()`'d deadline timer won't fire once the process is exiting): it
    // emits the partial timeline and ends the OTel root. `endRoot` then also
    // covers a quit BEFORE any window was shown (emit no-ops without the
    // `windowShown` mark). Both are idempotent, so the normal post-emit quit
    // path is a no-op here.
    emitStartupWaterfall();
    endRoot();
    flushDesktopLogger();
  });
  // electron-updater's MacUpdater installs via Electron's native autoUpdater
  // singleton, so this fires for BOTH the "Relaunch now" toast `quitAndInstall()`
  // and the `autoInstallOnAppQuit` install-on-quit path — it is the single
  // signal that distinguishes "an update swapped the bundle and relaunched"
  // from "the user just quit".
  electronAutoUpdater.on('before-quit-for-update', () => {
    getLogger('updater').info({}, 'before-quit-for-update — update install will relaunch the app');
    // Shut down the servers this desktop spawned BEFORE the swap completes, so
    // the relaunched (new-version) app spawns fresh instead of attaching to a
    // stale old-version server and showing the version-drift toast. Fires on
    // both install paths: the "Relaunch now" path already drained its servers
    // via `prepareForRelaunch` (so this no-ops there), while the silent
    // `autoInstallOnAppQuit` install-on-quit path has no other teardown and is
    // the case this closes. Synchronous best-effort — the event can't hold the
    // quit open, but the server flushes pending writes + releases its lock far
    // faster than the reinstall+relaunch takes. A plain quit never fires this
    // event, so a normal app-quit leaves the detached server running, by design.
    wm?.signalStopAllOwnedServers();
    flushDesktopLogger();
  });

  // Cleared on `will-quit` (canonical shutdown ordering — NOT `before-quit`,
  // which fires earlier in the shutdown sequence). Each handle's teardown
  // method (`destroy()` or `stop()`) is idempotent, and the null-assignment
  // after each call makes subsequent will-quit re-entrances no-ops.
  app.on('will-quit', () => {
    getLogger('lifecycle').info({}, 'will-quit');
    // Reap every window's PTY host first so no user shell / spawn-helper
    // outlives the app. Idempotent (clears the map; a second pass no-ops).
    terminalReaper?.killAll();
    dockVisibleForWindow.clear();
    autoUpdaterHandle?.destroy();
    autoUpdaterHandle = null;
    bundleReplaceWatcherHandle?.stop();
    bundleReplaceWatcherHandle = null;
    mcpWiringHandle?.destroy();
    mcpWiringHandle = null;
    // Final drain so the lifecycle + teardown lines reach disk before exit
    // (the destination is `sync: false`).
    flushDesktopLogger();
  });

  app.on('window-all-closed', () => {
    // macOS convention — keep app running so Dock icon click can re-open Navigator.
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    // macOS Dock icon click while no windows visible — re-open Navigator.
    if (BrowserWindow.getAllWindows().length === 0) {
      openNavigator();
    }
  });
} // end bootPrimaryInstance

// ── OTel metric caches for sidebar shell IPCs ───────────────────────────────
// Lazy initialization mirrors the file-watcher / rename-log patterns so the
// SDK-disabled default build pays no cost beyond a single null-check per
// dispatch. Histogram + counter co-exist with the span emission in the
// `ok:shell:trash-item` handler — the span feeds traces (Tempo), the
// histogram feeds duration distributions (Prometheus), and the counter
// feeds failure-rate dashboards keyed by reason. Reason set is closed
// (path-escape / not-found / permission-denied / system-error) so the
// label cardinality is bounded by design.
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
