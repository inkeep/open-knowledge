import type {
  LanguagePreference,
  OkBugReportCrashAckResult,
  OkBugReportCrashDetectedEvent,
  OkBugReportCrashDumpAvailability,
  OkBugReportCreateResult,
  OkBugReportDeleteResult,
  OkBugReportListResult,
  OkBugReportScreenshot,
  OkBugReportSendResult,
  ReportBundleLevel,
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeListResult,
} from '@inkeep/open-knowledge-core';
import {
  contextBridge,
  crashReporter,
  type IpcRendererEvent,
  ipcRenderer,
  webUtils,
} from 'electron';
import type {
  OkChromeColors,
  OkDesktopBridge,
  OkDesktopConfig,
  OkEditorActiveTargetSnapshot,
  OkEditorViewMenuStateSnapshot,
  OkLocalOpAuthEvent,
  OkLocalOpCloneEvent,
  OkLocalOpStream,
  OkMcpWiringShowPayload,
  OkMenuAction,
  OkMenuActionDispatch,
  OkMenuActionOrigin,
  OkMenuDispatchRequest,
  OkNoteWindowMainAction,
  OkNoteWindowMainActionResult,
  OkOnboardingShowPayload,
  OkPtyData,
  OkPtyExit,
  OkPtyNotice,
  OkRecentRemovedMissingInfo,
  OkServerRestartedInfo,
  OkServerVersionDriftInfo,
  OkShareReceivedPayload,
  OkThemeSource,
  OkUpdateDownloadedInfo,
  OkUpdateFetchingLatestInfo,
  OkUpdateRelaunchFailedInfo,
  OkUpdateRelaunchingInfo,
  OkUpdateStuckHintInfo,
  OkWhatsNewInfo,
} from '../shared/bridge-contract.ts';
import {
  DISPLAY_LOCK_CRASH_KEY,
  DISPLAY_LOCK_CRASH_KEY_MAX_BYTES,
} from '../shared/display-lock-crash-key.ts';
import type {
  IntegrationsSetResult,
  IntegrationsStatus,
  ProjectIntegrationsSetResult,
  ProjectIntegrationsStatus,
} from '../shared/ipc-channels.ts';
import { createInvoker } from '../shared/ipc-invoke.ts';
import { resolveOkDesktopMode } from '../shared/ok-desktop-mode.ts';
import { isUninstallPreload } from '../shared/uninstall-preload-arg.ts';
import { createSlidesBridge } from './slides-bridge.ts';
import { createUninstallBridge } from './uninstall.ts';

const invoke = createInvoker(ipcRenderer);

function isDockStateIpcTeardown(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /destroyed|disposed|closed|no handler registered/i.test(error.message);
}

function createIpcEventStream<E extends { type: string }>(
  startResultPromise: Promise<{ ok: true; streamId: string } | { ok: false; error: string }>,
  eventChannel: 'ok:local-op:auth:event' | 'ok:local-op:clone:event',
  cancelChannel: 'ok:local-op:auth:cancel' | 'ok:local-op:clone:cancel',
): OkLocalOpStream<E> {
  const buffer: E[] = [];
  const waiters: ((event: E | null) => void)[] = [];
  let terminated = false;
  let myStreamId: string | null = null;
  let listenerAttached = false;

  const push = (event: E): void => {
    if (terminated) return;
    if (waiters.length > 0) {
      const next = waiters.shift();
      next?.(event);
    } else {
      buffer.push(event);
    }
    if (event.type === 'complete' || event.type === 'error') {
      terminated = true;
      detach();
      for (const w of waiters.splice(0)) w(null);
    }
  };

  const listener = (_event: IpcRendererEvent, payload: { streamId: string; event: E }): void => {
    if (myStreamId === null || payload.streamId !== myStreamId) return;
    push(payload.event);
  };

  const detach = (): void => {
    if (listenerAttached) {
      ipcRenderer.removeListener(eventChannel, listener);
      listenerAttached = false;
    }
  };

  // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
  ipcRenderer.on(eventChannel, listener);
  listenerAttached = true;

  startResultPromise
    .then((result) => {
      if (!result.ok) {
        push({ type: 'error', message: result.error } as unknown as E);
        return;
      }
      myStreamId = result.streamId;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      push({ type: 'error', message: `IPC error: ${message}` } as unknown as E);
    });

  const events: AsyncIterable<E> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<E>> {
          if (buffer.length > 0) {
            const value = buffer.shift();
            if (value === undefined) return { value: undefined, done: true };
            return { value, done: false };
          }
          if (terminated) return { value: undefined, done: true };
          return new Promise<IteratorResult<E>>((resolve) => {
            waiters.push((event) => {
              if (event === null) resolve({ value: undefined, done: true });
              else resolve({ value: event, done: false });
            });
          });
        },
      };
    },
  };

  return {
    events,
    cancel: () => {
      if (terminated) return;
      terminated = true;
      detach();
      for (const w of waiters.splice(0)) w(null);
      if (myStreamId !== null) {
        invoke(cancelChannel, myStreamId).catch(() => {});
        return;
      }
      void startResultPromise.then((result) => {
        if (result.ok) invoke(cancelChannel, result.streamId).catch(() => {});
      });
    },
  };
}

function createLocalOpAuthStream(): OkLocalOpStream<OkLocalOpAuthEvent> {
  return createIpcEventStream<OkLocalOpAuthEvent>(
    invoke('ok:local-op:auth:start'),
    'ok:local-op:auth:event',
    'ok:local-op:auth:cancel',
  );
}

function createLocalOpCloneStream(request: {
  url: string;
  dir: string;
  branch?: string | null;
}): OkLocalOpStream<OkLocalOpCloneEvent> {
  return createIpcEventStream<OkLocalOpCloneEvent>(
    invoke('ok:local-op:clone:start', request),
    'ok:local-op:clone:event',
    'ok:local-op:clone:cancel',
  );
}

function parseArg(name: string): string | undefined {
  const prefix = `--ok-${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function readConfigFromArgv(): OkDesktopConfig {
  const collabUrl = parseArg('collab-url') ?? '';
  const apiOrigin = parseArg('api-origin') ?? '';
  const projectPath = parseArg('project-path') ?? '';
  const projectName = parseArg('project-name') ?? '';
  const mode = resolveOkDesktopMode(parseArg('mode'));
  const singleFile = parseArg('single-file') === '1';
  const languagePreference = parseArg('language-preference') as LanguagePreference | undefined;
  const initialDoc = parseArg('initial-doc') ?? null;
  const freshlyCreated = parseArg('fresh-create') === '1';
  const e2eSmoke = parseArg('e2e-smoke') === '1';
  const startupTraceparent = parseArg('startup-traceparent');
  const ptyAvailable = parseArg('pty-available') === '1';
  return Object.freeze({
    collabUrl,
    apiOrigin,
    projectPath,
    projectName,
    mode,
    e2eSmoke,
    singleFile,
    initialDoc,
    freshlyCreated,
    ptyAvailable,
    ...(startupTraceparent !== undefined ? { startupTraceparent } : {}),
    ...(languagePreference !== undefined ? { languagePreference } : {}),
  });
}

/*
 * UPSTREAM(electron/electron#25516): `contextBridge` captures plain values at
 * exposure time, so this has to reach the renderer as a method whose closure
 * reads the live binding rather than as a field on the frozen config.
 */
let screenReaderActive = parseArg('screen-reader-active') === '1';
// biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
ipcRenderer.on('ok:accessibility:changed', (_event, info: { screenReaderActive: boolean }) => {
  screenReaderActive = info.screenReaderActive === true;
});

const MAX_BUFFERED_MENU_ACTIONS = 32;

type MenuActionBufferPolicy = 'never-buffer' | 'parity' | 'additive';

const MENU_ACTION_BUFFER_POLICY: Record<OkMenuAction, MenuActionBufferPolicy> = {
  delete: 'never-buffer',
  'move-to-trash': 'never-buffer',
  'close-active-tab-or-window': 'never-buffer',
  'kill-terminal': 'never-buffer',

  'toggle-sidebar': 'parity',
  'toggle-source': 'parity',
  'toggle-doc-panel': 'parity',
  'toggle-terminal': 'parity',
  'toggle-agent-panel': 'parity',
  'toggle-show-hidden-files': 'parity',
  'toggle-show-ok-folders': 'parity',
  'toggle-show-only-markdown-files': 'parity',
  'toggle-show-skills-section': 'parity',
  'move-terminal': 'parity',

  'new-doc': 'additive',
  'new-folder': 'additive',
  'new-project': 'additive',
  rename: 'additive',
  'save-version': 'additive',
  'version-history': 'additive',
  'focus-search': 'additive',
  'focus-command-palette': 'additive',
  'navigate-back': 'additive',
  'navigate-forward': 'additive',
  'new-from-template': 'additive',
  duplicate: 'additive',
  'reveal-in-finder': 'additive',
  'send-to-ai': 'additive',
  'copy-full-path': 'additive',
  'copy-relative-path': 'additive',
  'expand-all-tree': 'additive',
  'collapse-all-tree': 'additive',
  'new-terminal': 'additive',
  'new-worktree': 'additive',
  'switch-worktree': 'additive',
  'report-bug': 'additive',
  'send-feedback': 'additive',
};

const menuActionListeners = new Set<(action: OkMenuAction, origin: OkMenuActionOrigin) => void>();
function deliverMenuAction(dispatch: OkMenuActionDispatch): void {
  for (const listener of menuActionListeners) {
    try {
      listener(dispatch.action, dispatch.origin);
    } catch (err) {
      console.error('[preload:menu-action] listener threw during dispatch:', err);
    }
  }
}

const bufferedMenuActions: OkMenuActionDispatch[] = [];

// biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
ipcRenderer.on('ok:menu-action', (_event, dispatch: OkMenuActionDispatch) => {
  if (menuActionListeners.size > 0) {
    deliverMenuAction(dispatch);
    return;
  }
  const policy = MENU_ACTION_BUFFER_POLICY[dispatch.action];
  if (policy === 'never-buffer') {
    console.debug(
      '[preload:menu-action] destructive action dropped, nothing listening:',
      dispatch.action,
    );
    return;
  }
  if (policy === 'parity' && bufferedMenuActions.at(-1)?.action === dispatch.action) return;
  if (bufferedMenuActions.length >= MAX_BUFFERED_MENU_ACTIONS) bufferedMenuActions.shift();
  bufferedMenuActions.push(dispatch);
});

const bridge: OkDesktopBridge = {
  config: readConfigFromArgv(),

  onProjectSwitched(cb: (next: OkDesktopConfig) => void) {
    /*
     * UPSTREAM(electron/electron#33328): `removeListener` matches on the exact
     * function registered, so the wrapper — not `cb` — is what both calls use.
     */
    const listener = (_event: IpcRendererEvent, next: OkDesktopConfig) => cb(next);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:project:switched', listener);
    return () => ipcRenderer.removeListener('ok:project:switched', listener);
  },

  onMenuAction(cb: (action: OkMenuAction, origin: OkMenuActionOrigin) => void) {
    const wasUnlistened = menuActionListeners.size === 0;
    menuActionListeners.add(cb);
    if (wasUnlistened && bufferedMenuActions.length > 0) {
      const replay = bufferedMenuActions.splice(0, bufferedMenuActions.length);
      queueMicrotask(() => {
        if (menuActionListeners.size === 0) {
          bufferedMenuActions.unshift(...replay);
          return;
        }
        for (const dispatch of replay) deliverMenuAction(dispatch);
      });
    }
    return () => {
      menuActionListeners.delete(cb);
    };
  },

  onUpdateDownloaded(cb: (info: OkUpdateDownloadedInfo) => void) {
    const listener = (_event: IpcRendererEvent, info: OkUpdateDownloadedInfo) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:update:downloaded', listener);
    return () => ipcRenderer.removeListener('ok:update:downloaded', listener);
  },

  onUpdateRelaunching(cb: (info: OkUpdateRelaunchingInfo) => void) {
    const listener = (_event: IpcRendererEvent, info: OkUpdateRelaunchingInfo) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:update:relaunching', listener);
    return () => ipcRenderer.removeListener('ok:update:relaunching', listener);
  },

  onUpdateFetchingLatest(cb: (info: OkUpdateFetchingLatestInfo) => void) {
    const listener = (_event: IpcRendererEvent, info: OkUpdateFetchingLatestInfo) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:update:fetching-latest', listener);
    return () => ipcRenderer.removeListener('ok:update:fetching-latest', listener);
  },

  onUpdateRelaunchFailed(cb: (info: OkUpdateRelaunchFailedInfo) => void) {
    const listener = (_event: IpcRendererEvent, info: OkUpdateRelaunchFailedInfo) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:update:relaunch-failed', listener);
    return () => ipcRenderer.removeListener('ok:update:relaunch-failed', listener);
  },

  onWhatsNew(cb: (info: OkWhatsNewInfo) => void) {
    const listener = (_event: IpcRendererEvent, info: OkWhatsNewInfo) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:update:whats-new', listener);
    return () => ipcRenderer.removeListener('ok:update:whats-new', listener);
  },

  onWhatsNewDismissed(cb: (info: { version: string }) => void) {
    const listener = (_event: IpcRendererEvent, info: { version: string }) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:update:whats-new-dismissed', listener);
    return () => ipcRenderer.removeListener('ok:update:whats-new-dismissed', listener);
  },

  onUpdateStuckHint(cb: (info: OkUpdateStuckHintInfo) => void) {
    const listener = (_event: IpcRendererEvent, info: OkUpdateStuckHintInfo) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:update:stuck-hint', listener);
    return () => ipcRenderer.removeListener('ok:update:stuck-hint', listener);
  },

  onDeepLink(
    cb: (evt: {
      doc: string;
      kind: 'doc' | 'folder';
      branch?: string | null;
      multiCandidate?: boolean;
    }) => void,
  ) {
    const listener = (
      _event: IpcRendererEvent,
      evt: {
        doc: string;
        kind: 'doc' | 'folder';
        branch?: string | null;
        multiCandidate?: boolean;
      },
    ) => cb(evt);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:deep-link', listener);
    return () => ipcRenderer.removeListener('ok:deep-link', listener);
  },

  onShareReceived(cb: (payload: OkShareReceivedPayload) => void) {
    const listener = (_event: IpcRendererEvent, payload: OkShareReceivedPayload) => cb(payload);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:share:received', listener);
    return () => ipcRenderer.removeListener('ok:share:received', listener);
  },

  onServerVersionDrift(cb: (info: OkServerVersionDriftInfo) => void) {
    const listener = (_event: IpcRendererEvent, info: OkServerVersionDriftInfo) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:server-version-drift', listener);
    return () => ipcRenderer.removeListener('ok:server-version-drift', listener);
  },

  onServerRestarted(cb: (info: OkServerRestartedInfo) => void) {
    const listener = (_event: IpcRendererEvent, info: OkServerRestartedInfo) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:server-restarted', listener);
    return () => ipcRenderer.removeListener('ok:server-restarted', listener);
  },

  onRecentRemovedMissing(cb: (info: OkRecentRemovedMissingInfo) => void) {
    const listener = (_event: IpcRendererEvent, info: OkRecentRemovedMissingInfo) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:project:recent-removed-missing', listener);
    return () => ipcRenderer.removeListener('ok:project:recent-removed-missing', listener);
  },

  restartServer: (projectPath: string) => invoke('ok:project:restart-server', projectPath),

  setThemeSource: (source: OkThemeSource) => invoke('ok:theme:set-source', { source }),

  setLanguagePreference: (preference: LanguagePreference) =>
    invoke('ok:locale:set-preference', { preference }),

  signalThemeApplied: (opts?: { reducedTransparency?: boolean; chrome?: OkChromeColors }) => {
    invoke('ok:theme:applied', opts).catch((err: unknown) => {
      console.warn(
        JSON.stringify({
          event: 'signal-theme-applied-failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  },

  dialog: {
    openFolder: (opts) => invoke('ok:dialog:open-folder', opts),
  },

  shell: {
    openExternal: (url: string) => invoke('ok:shell:open-external', url),
    detectProtocol: (scheme: string) => invoke('ok:shell:detect-protocol', scheme),
    spawnCursor: (path: string) => invoke('ok:shell:spawn-cursor', path),
    recordHandoff: (line) => invoke('ok:shell:record-handoff', line),
    openAsset: (relPath: string) => invoke('ok:shell:open-asset', relPath),
    revealAsset: (relPath: string) => invoke('ok:shell:reveal-asset', relPath),
    revealExternal: (absPath: string) => invoke('ok:shell:reveal-external', absPath),
    showAssetMenu: (params) => invoke('ok:shell:show-asset-menu', params),
    showItemInFolder: (path: string) => invoke('ok:shell:show-item-in-folder', path),
    trashItem: (absPath: string) => invoke('ok:shell:trash-item', absPath),
  },

  clipboard: {
    writeText: (text: string) => invoke('ok:clipboard:write-text', text),
    copyImage: (params) => invoke('ok:clipboard:copy-image', params),
  },

  project: {
    listRecent: () => invoke('ok:project:list-recent'),
    removeRecent: (path: string) => invoke('ok:project:remove-recent', path),
    getSessionState: () => invoke('ok:project:get-session-state'),
    setSessionState: (state) => invoke('ok:project:set-session-state', state),
    open: (request) => invoke('ok:project:open', request),
    openFile: () => invoke('ok:project:open-file-picker'),
    createNew: (args) => invoke('ok:project:create-new', args),
    recordCreateNewBannerShown: (banner) =>
      invoke('ok:project:record-create-new-banner-shown', banner),
    checkTargetExists: (request) => invoke('ok:project:check-target-exists', request),
    readHeadBranch: (projectPath: string) => invoke('ok:project:read-head-branch', projectPath),
    fetchBranchInfo: (request) => invoke('ok:project:fetch-branch-info', request),
    runCheckout: (request) => invoke('ok:project:run-checkout', request),
    fetchTargetStatus: (request) => invoke('ok:project:fetch-target-status', request),
    awaitBranchSwitched: (request) => invoke('ok:project:await-branch-switched', request),
    okInit: (request) => invoke('ok:project:ok-init', request),
    close: () => invoke('ok:project:close'),
  },

  worktree: {
    list: () => invoke('ok:worktree:dispatch', { kind: 'list' }) as Promise<WorktreeListResult>,
    create: (request: WorktreeCreateRequest) =>
      invoke('ok:worktree:dispatch', {
        kind: 'create',
        ...request,
      }) as Promise<WorktreeCreateResult>,
    checkout: (request: { branch: string }) =>
      invoke('ok:worktree:dispatch', {
        kind: 'checkout',
        branch: request.branch,
      }) as Promise<WorktreeCreateResult>,
  },

  sharing: {
    status: async () => {
      const result = await invoke('ok:sharing:dispatch', { kind: 'status' });
      if (result.kind !== 'status') {
        throw new Error(`ok:sharing:dispatch: expected status, got ${result.kind}`);
      }
      return result;
    },
    setMode: async (mode: 'shared' | 'local-only') => {
      const result = await invoke('ok:sharing:dispatch', { kind: 'set-mode', mode });
      if (result.kind === 'status') {
        throw new Error('ok:sharing:dispatch: expected set-mode result, got status');
      }
      return result;
    },
  },

  slides: createSlidesBridge(invoke),

  bugReport: {
    create: (request: {
      level: ReportBundleLevel;
      note?: string;
      includeCrashDump?: boolean;
      includeScreenshot?: boolean;
    }) =>
      invoke('ok:bug-report:dispatch', {
        kind: 'create',
        level: request.level,
        note: request.note,
        includeCrashDump: request.includeCrashDump,
        includeScreenshot: request.includeScreenshot,
      }) as Promise<OkBugReportCreateResult>,
    captureScreenshot: () =>
      invoke('ok:bug-report:dispatch', {
        kind: 'capture-screenshot',
      }) as Promise<OkBugReportScreenshot | null>,
    crashDumpAvailability: () =>
      invoke('ok:bug-report:dispatch', {
        kind: 'crash-dump-availability',
      }) as Promise<OkBugReportCrashDumpAvailability>,
    send: (request: Parameters<OkDesktopBridge['bugReport']['send']>[0]) =>
      invoke('ok:bug-report:dispatch', {
        ...request,
        kind: 'send',
      }) as Promise<OkBugReportSendResult>,
    crashAck: (request: { eventId: string }) =>
      invoke('ok:bug-report:dispatch', {
        kind: 'crash-ack',
        eventId: request.eventId,
      }) as Promise<OkBugReportCrashAckResult>,
    list: () =>
      invoke('ok:bug-report:dispatch', { kind: 'list' }) as Promise<OkBugReportListResult>,
    delete: (id: string) =>
      invoke('ok:bug-report:dispatch', { kind: 'delete', id }) as Promise<OkBugReportDeleteResult>,
    onCrashDetected(cb: (event: OkBugReportCrashDetectedEvent) => void) {
      const listener = (_event: IpcRendererEvent, event: OkBugReportCrashDetectedEvent) =>
        cb(event);
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:bug-report:crash-detected', listener);
      return () => ipcRenderer.removeListener('ok:bug-report:crash-detected', listener);
    },
  },

  fs: {
    defaultProjectsRoot: () => invoke('ok:fs:default-projects-root'),
    folderState: (path: string) => invoke('ok:fs:folder-state', path),
    findEnclosingProjectRoot: (path: string) => invoke('ok:fs:find-enclosing-project-root', path),
    findEnclosingGitRoot: (path: string) => invoke('ok:fs:find-enclosing-git-root', path),
    removeGitFolder: (gitRoot: string) => invoke('ok:fs:remove-git-folder', gitRoot),
  },

  navigator: {
    open: () => invoke('ok:navigator:open'),
  },

  noteWindow: {
    open: async (docName: string, entryPoint: 'tab-menu' | 'palette') => {
      const result = await invoke('ok:window:open-note', { kind: 'open', docName, entryPoint });
      if (result.ok && !('outcome' in result)) {
        throw new Error('ok:window:open-note returned a non-open result for an open request');
      }
      return result as Awaited<ReturnType<OkDesktopBridge['noteWindow']['open']>>;
    },
    dispatchToMain: (action: OkNoteWindowMainAction) =>
      invoke('ok:window:open-note', {
        kind: 'dispatch-to-main',
        action,
      }) as Promise<OkNoteWindowMainActionResult>,
    onMainAction(cb: (action: OkNoteWindowMainAction) => void) {
      const listener = (_event: IpcRendererEvent, action: OkNoteWindowMainAction) => cb(action);
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:note-window:main-action', listener);
      return () => ipcRenderer.removeListener('ok:note-window:main-action', listener);
    },
  },

  seed: {
    plan: (options) => invoke('ok:seed:plan', options),
    apply: (plan, options) => invoke('ok:seed:apply', plan, options),
    listPacks: () => invoke('ok:seed:list-packs'),
  },

  skill: {
    detectClaudeDesktop: () => invoke('ok:skill:detect-claude-desktop'),
    buildAndOpen: (opts) => invoke('ok:skill:build-and-open', opts),
  },

  update: {
    relaunchNow: () => invoke('ok:update:relaunch-now'),
    checkNow: () => invoke('ok:update:check-now'),
    dismissWhatsNew: (version: string) => invoke('ok:update:whats-new-dismiss', { version }),
  },

  state: {
    query: () => invoke('ok:state:query'),
    resetIncompatible: () => invoke('ok:state:reset-incompatible'),
  },

  mcpWiring: {
    onShow(cb: (payload: OkMcpWiringShowPayload) => void) {
      const listener = (_event: IpcRendererEvent, payload: OkMcpWiringShowPayload) => cb(payload);
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:mcp-wiring:show', listener);
      return () => ipcRenderer.removeListener('ok:mcp-wiring:show', listener);
    },
    signalReady: () => {
      invoke('ok:mcp-wiring:renderer-ready').catch(() => {});
    },
    confirm: (request) =>
      invoke('ok:mcp-wiring:confirm', {
        editorIds: request.editorIds,
        pathInstall: request.pathInstall,
        skills: request.skills,
      }),
    skip: () => invoke('ok:mcp-wiring:skip'),
    reconfigure: () => invoke('ok:mcp-wiring:reconfigure'),
  },

  spellcheck: {
    toggle: () => invoke('ok:spellcheck:toggle'),
  },

  integrations: {
    status: () =>
      invoke('ok:integrations:dispatch', { kind: 'status' }) as Promise<IntegrationsStatus>,
    setComponent: (request) =>
      invoke('ok:integrations:dispatch', {
        kind: 'set',
        component: request.component,
        enabled: request.enabled,
      }) as Promise<IntegrationsSetResult>,
  },

  projectIntegrations: {
    status: () =>
      invoke('ok:project-integrations:dispatch', {
        kind: 'status',
      }) as Promise<ProjectIntegrationsStatus>,
    setComponent: (request) =>
      invoke('ok:project-integrations:dispatch', {
        kind: 'set',
        component: request.component,
        enabled: request.enabled,
      }) as Promise<ProjectIntegrationsSetResult>,
  },

  remoteAccess: {
    probePort: (port) =>
      invoke('ok:remote-access:dispatch', { kind: 'probe-port', port }) as Promise<boolean>,
  },

  onboarding: {
    onShow(cb: (payload: OkOnboardingShowPayload) => void) {
      const listener = (_event: IpcRendererEvent, payload: OkOnboardingShowPayload) => cb(payload);
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:onboarding:show', listener);
      return () => ipcRenderer.removeListener('ok:onboarding:show', listener);
    },
    signalReady: () => {
      invoke('ok:onboarding:renderer-ready').catch(() => {});
    },
    confirm: (request) => invoke('ok:onboarding:confirm', request),
    cancel: () => invoke('ok:onboarding:cancel'),
    probeContent: (request) => invoke('ok:onboarding:probe-content', request),
    onToast(
      cb: (
        payload:
          | { readonly kind: 'ancestor-promote'; readonly ancestorPath: string }
          | {
              readonly kind: 'git-root-promote';
              readonly gitRoot: string;
              readonly pickedPath: string;
            }
          | {
              readonly kind: 'startup-reclaim';
              readonly mcp:
                | { readonly status: 'none' }
                | { readonly status: 'repaired'; readonly editors: readonly string[] }
                | { readonly status: 'failed'; readonly editors: readonly string[] };
              readonly path:
                | { readonly status: 'none' }
                | { readonly status: 'installed'; readonly summary: string }
                | { readonly status: 'failed'; readonly summary: string };
            },
      ) => void,
    ) {
      const listener = (
        _event: IpcRendererEvent,
        payload:
          | { readonly kind: 'ancestor-promote'; readonly ancestorPath: string }
          | {
              readonly kind: 'git-root-promote';
              readonly gitRoot: string;
              readonly pickedPath: string;
            }
          | {
              readonly kind: 'startup-reclaim';
              readonly mcp:
                | { readonly status: 'none' }
                | { readonly status: 'repaired'; readonly editors: readonly string[] }
                | { readonly status: 'failed'; readonly editors: readonly string[] };
              readonly path:
                | { readonly status: 'none' }
                | { readonly status: 'installed'; readonly summary: string }
                | { readonly status: 'failed'; readonly summary: string };
            },
      ) => cb(payload);
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:onboarding:toast', listener);
      return () => ipcRenderer.removeListener('ok:onboarding:toast', listener);
    },
  },

  localOp: {
    auth: {
      start: () => createLocalOpAuthStream(),
    },
    clone: {
      start: (request) => createLocalOpCloneStream(request),
    },
    authStatus: (request) => invoke('ok:local-op:auth:status', request),
    authRepos: (request) => invoke('ok:local-op:auth:repos', request),
  },

  share: {
    validateLocalFolder: (args) => invoke('ok:share:validate-folder', args),
  },

  editor: {
    notifyActiveTargetChanged: (target: OkEditorActiveTargetSnapshot) => {
      invoke('ok:editor:active-target-changed', target).catch(() => {});
    },
    notifyViewMenuStateChanged: (state: Partial<OkEditorViewMenuStateSnapshot>) => {
      invoke('ok:editor:view-menu-state-changed', state).catch(() => {});
    },
    notifyBackgroundThrottle: (signal: { hasPendingWork: boolean; enabled: boolean }) => {
      invoke('ok:editor:background-throttle', signal).catch(() => {});
    },
  },

  menu: {
    dispatch: (request: OkMenuDispatchRequest) => invoke('ok:menu:dispatch', request),
  },

  startup: {
    reportMarks: (marks: { pageListReadyMs: number; firstContentMs: number }) => {
      invoke('ok:startup:renderer-marks', marks).catch(() => {});
    },
  },

  sidebar: {
    expandAll(cb: () => void) {
      const listener = (_event: IpcRendererEvent) => cb();
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:sidebar:expand-all', listener);
      return () => ipcRenderer.removeListener('ok:sidebar:expand-all', listener);
    },
    collapseAll(cb: () => void) {
      const listener = (_event: IpcRendererEvent) => cb();
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:sidebar:collapse-all', listener);
      return () => ipcRenderer.removeListener('ok:sidebar:collapse-all', listener);
    },
  },

  terminal: {
    create: (opts) => invoke('ok:pty:create', opts),
    input: (ptyId, data) => {
      invoke('ok:pty:input', { ptyId, data }).catch(() => {});
    },
    resize: (ptyId, cols, rows) => {
      invoke('ok:pty:resize', { ptyId, cols, rows }).catch(() => {});
    },
    kill: (ptyId) => invoke('ok:pty:kill', { ptyId }),
    drain: (ptyId, bytes) => {
      invoke('ok:pty:drain', { ptyId, bytes }).catch(() => {});
    },
    list: () => invoke('ok:pty:list'),
    adopt: (ptyId) => invoke('ok:pty:adopt', { ptyId }),
    setMeta: (ptyId, meta) => {
      invoke('ok:pty:set-meta', { ptyId, ...meta }).catch(() => {});
    },
    setOrder: (orderedPtyIds) => {
      invoke('ok:pty:set-order', { orderedPtyIds: [...orderedPtyIds] }).catch(() => {});
    },
    getDockState: () => invoke('ok:terminal:dock-state'),
    setDockState: async (state) => {
      const request =
        state.surface === 'terminal'
          ? {
              surface: state.surface,
              order: [...state.order],
              activeKey: state.activeKey,
              terminalSnapshot: {
                tabs: state.terminalSnapshot.tabs.map((tab) => ({ ...tab })),
                activeOrdinal: state.terminalSnapshot.activeOrdinal,
              },
            }
          : {
              surface: state.surface,
              order: [...state.order],
              activeKey: state.activeKey,
            };
      try {
        return await invoke('ok:terminal:set-dock-state', request);
      } catch (error) {
        if (isDockStateIpcTeardown(error)) return { ok: false, reason: 'ipc-unavailable' };
        throw error;
      }
    },
    onData(cb) {
      const listener = (_event: IpcRendererEvent, msg: OkPtyData) => cb(msg);
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:pty:data', listener);
      return () => ipcRenderer.removeListener('ok:pty:data', listener);
    },
    onExit(cb) {
      const listener = (_event: IpcRendererEvent, msg: OkPtyExit) => cb(msg);
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:pty:exit', listener);
      return () => ipcRenderer.removeListener('ok:pty:exit', listener);
    },
    onNotice(cb) {
      const listener = (_event: IpcRendererEvent, msg: OkPtyNotice) => cb(msg);
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:pty:notice', listener);
      return () => ipcRenderer.removeListener('ok:pty:notice', listener);
    },
    claudePreflight: () => invoke('ok:terminal:claude-assist', { action: 'preflight' }),
    cliPreflight: (cli) => invoke('ok:terminal:cli-preflight', { cli }),
    cliInstalledMap: () => invoke('ok:terminal:cli-installed-map'),
    rewireClaudeMcp: () => invoke('ok:terminal:claude-assist', { action: 'rewire' }),
  },

  accessibility: {
    isScreenReaderActive: () => screenReaderActive,
    onScreenReaderChanged(cb) {
      const listener = (_event: IpcRendererEvent, info: { screenReaderActive: boolean }) =>
        cb(info.screenReaderActive === true);
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
      ipcRenderer.on('ok:accessibility:changed', listener);
      return () => ipcRenderer.removeListener('ok:accessibility:changed', listener);
    },
  },

  platform: process.platform as 'darwin' | 'win32' | 'linux',
  appVersion: parseArg('app-version') ?? '0.0.0',
  instanceLabel: parseArg('instance-label') ?? null,

  getPathForFile: (file) => {
    const path = webUtils.getPathForFile(file);
    return path === '' ? null : path;
  },

  setDisplayLockCrashKey: (state) => {
    if (new TextEncoder().encode(state).length > DISPLAY_LOCK_CRASH_KEY_MAX_BYTES) return;
    crashReporter.addExtraParameter(DISPLAY_LOCK_CRASH_KEY, state);
  },
};

if (parseArg('debug-keyring-smoke') === '1') {
  bridge.debug = {
    keyringSmoke: () => invoke('ok:debug:keyring-smoke'),
  };
}

if (isUninstallPreload(process.argv)) {
  contextBridge.exposeInMainWorld('okUninstall', createUninstallBridge(invoke));
} else {
  contextBridge.exposeInMainWorld('okDesktop', bridge);
}
