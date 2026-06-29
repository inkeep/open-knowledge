
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import type {
  OkDesktopBridge,
  OkDesktopConfig,
  OkEditorActiveTargetSnapshot,
  OkEditorViewMenuStateSnapshot,
  OkLocalOpAuthEvent,
  OkLocalOpCloneEvent,
  OkLocalOpStream,
  OkMcpWiringShowPayload,
  OkMenuAction,
  OkOnboardingShowPayload,
  OkPtyData,
  OkPtyExit,
  OkServerReclaimedInfo,
  OkServerRestartedInfo,
  OkServerVersionDriftInfo,
  OkShareReceivedPayload,
  OkThemeSource,
  OkUpdateDownloadedInfo,
  OkUpdateRelaunchFailedInfo,
  OkUpdateRelaunchingInfo,
  OkUpdateStuckHintInfo,
  OkWhatsNewInfo,
} from '../shared/bridge-contract.ts';
import { createInvoker } from '../shared/ipc-invoke.ts';

const invoke = createInvoker(ipcRenderer);

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
  const modeRaw = parseArg('mode') ?? 'editor';
  const mode: OkDesktopConfig['mode'] = modeRaw === 'navigator' ? 'navigator' : 'editor';
  const singleFile = parseArg('single-file') === '1';
  const initialDoc = parseArg('initial-doc') ?? null;
  const e2eSmoke = parseArg('e2e-smoke') === '1';
  return Object.freeze({
    collabUrl,
    apiOrigin,
    projectPath,
    projectName,
    mode,
    e2eSmoke,
    singleFile,
    initialDoc,
  });
}

const bridge: OkDesktopBridge = {
  config: readConfigFromArgv(),

  onProjectSwitched(cb: (next: OkDesktopConfig) => void) {
    const listener = (_event: IpcRendererEvent, next: OkDesktopConfig) => cb(next);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:project:switched', listener);
    return () => ipcRenderer.removeListener('ok:project:switched', listener);
  },

  onMenuAction(cb: (action: OkMenuAction) => void) {
    const listener = (_event: IpcRendererEvent, action: OkMenuAction) => cb(action);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:menu-action', listener);
    return () => ipcRenderer.removeListener('ok:menu-action', listener);
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

  onServerReclaimed(cb: (info: OkServerReclaimedInfo) => void) {
    const listener = (_event: IpcRendererEvent, info: OkServerReclaimedInfo) => cb(info);
    // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: preload-side subscription wrapper (precedent #14)
    ipcRenderer.on('ok:server-reclaimed', listener);
    return () => ipcRenderer.removeListener('ok:server-reclaimed', listener);
  },

  restartServer: (projectPath: string) => invoke('ok:project:restart-server', projectPath),

  setThemeSource: (source: OkThemeSource) => invoke('ok:theme:set-source', { source }),

  signalThemeApplied: (opts?: { reducedTransparency?: boolean }) => {
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
    showAssetMenu: (params) => invoke('ok:shell:show-asset-menu', params),
    showItemInFolder: (path: string) => invoke('ok:shell:show-item-in-folder', path),
    trashItem: (absPath: string) => invoke('ok:shell:trash-item', absPath),
  },

  clipboard: {
    writeText: (text: string) => invoke('ok:clipboard:write-text', text),
  },

  project: {
    listRecent: () => invoke('ok:project:list-recent'),
    removeRecent: (path: string) => invoke('ok:project:remove-recent', path),
    getSessionState: () => invoke('ok:project:get-session-state'),
    setSessionState: (state) => invoke('ok:project:set-session-state', state),
    open: (request) => invoke('ok:project:open', request),
    createNew: (args) => invoke('ok:project:create-new', args),
    recordCreateNewBannerShown: (banner) =>
      invoke('ok:project:record-create-new-banner-shown', banner),
    checkTargetExists: (request) => invoke('ok:project:check-target-exists', request),
    readHeadBranch: (projectPath: string) => invoke('ok:project:read-head-branch', projectPath),
    fetchBranchInfo: (request) => invoke('ok:project:fetch-branch-info', request),
    runCheckout: (request) => invoke('ok:project:run-checkout', request),
    awaitBranchSwitched: (request) => invoke('ok:project:await-branch-switched', request),
    okInit: (request) => invoke('ok:project:ok-init', request),
    close: () => invoke('ok:project:close'),
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
    confirm: (editorIds) => invoke('ok:mcp-wiring:confirm', { editorIds }),
    skip: () => invoke('ok:mcp-wiring:skip'),
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
    claudePreflight: () => invoke('ok:terminal:claude-assist', { action: 'preflight' }),
    cliPreflight: (cli) => invoke('ok:terminal:cli-preflight', { cli }),
    rewireClaudeMcp: () => invoke('ok:terminal:claude-assist', { action: 'rewire' }),
  },

  platform: process.platform as 'darwin' | 'win32' | 'linux',
  appVersion: parseArg('app-version') ?? '0.0.0',
};

if (parseArg('debug-keyring-smoke') === '1') {
  bridge.debug = {
    keyringSmoke: () => invoke('ok:debug:keyring-smoke'),
  };
}

contextBridge.exposeInMainWorld('okDesktop', bridge);
