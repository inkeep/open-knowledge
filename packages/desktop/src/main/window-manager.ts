import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SIGTERM_GRACE_MS,
  DEFAULT_SIGTERM_POLL_MS,
  SPAWN_ERROR_LOG,
  sliceLastSpawnAttempt,
} from '@inkeep/open-knowledge-core';
import type { KeepaliveHandle } from '@inkeep/open-knowledge-core/keepalive';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import type { OkServerRestartOutcome } from '../shared/bridge-contract.ts';
import { registerPendingDelivery } from '../shared/ipc-send.ts';
import type { AssetOpenResult } from './asset-allowlist.ts';
import { attachAssetSafetyNet } from './asset-safety-net.ts';
import type { ServerExitInfo } from './server-exit-record.ts';
import type { ShowGateRegistry } from './show-gate.ts';
import type { RestoredWindow } from './state-store.ts';
import type { ShareDeepLinkBranchSwitchPayload } from './url-scheme.ts';
import { classifyServerVersion } from './version-drift.ts';

const RESTART_SIGTERM_GRACE_MS = 3_000;

const DEFAULT_SPAWN_STARTUP_DEADLINE_MS = 15_000;

const SPAWN_WAIT_EXTENSION_FACTOR = 8;

const FOREIGN_LOCK_PROBE_ATTEMPTS = 3;
const FOREIGN_LOCK_PROBE_RETRY_MS = 500;

type ProbePhase = 'attach' | 'spawn-foreign-lock' | 'restart-recovery' | 'force-stop-recovery';

function isDialablePort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535;
}

type RecoveryCaller = 'restart' | 'force-stop';

const RECOVERY_CALLERS: Record<
  RecoveryCaller,
  { event: 'desktop-server-restart' | 'desktop-force-stop-conflicting-server'; phase: ProbePhase }
> = {
  restart: { event: 'desktop-server-restart', phase: 'restart-recovery' },
  'force-stop': {
    event: 'desktop-force-stop-conflicting-server',
    phase: 'force-stop-recovery',
  },
};

const EPHEMERAL_SERVER_WATCH_POLL_MS = 3_000;

function isValidLockPidLocal(value: unknown): value is number {
  if (typeof value !== 'number') return false;
  if (!Number.isInteger(value)) return false;
  if (value < 2) return false;
  if (value > 0x7fffffff) return false;
  return true;
}

let windowInstanceLabel: string | null = null;

export function setWindowInstanceLabel(label: string | null): void {
  windowInstanceLabel = label;
}

function instanceLabelArgs(): string[] {
  return windowInstanceLabel ? [`--ok-instance-label=${windowInstanceLabel}`] : [];
}

function formatEditorTitle(projectName: string): string {
  const suffix = windowInstanceLabel ? ` (${windowInstanceLabel})` : '';
  return `${projectName} — OpenKnowledge${suffix}`;
}

export interface BrowserWindowLike {
  focus(): void;
  show?(): void;
  showInactive?(): void;
  restore?(): void;
  isMinimized?(): boolean;
  isDestroyed?(): boolean;
  isVisible?(): boolean;
  moveTop?(): void;
  isFocused?(): boolean;
  close?(): void;
  destroy?(): void;
  on(event: 'closed', cb: () => void): void;
  once(event: 'ready-to-show', cb: () => void): void;
  webContents: {
    send(channel: string, ...args: unknown[]): void;
    once(event: 'dom-ready' | 'did-finish-load', cb: () => void): void;
    executeJavaScript(code: string): Promise<unknown>;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
    on(
      event: 'will-navigate' | 'will-redirect',
      handler: (event: { preventDefault: () => void }, url: string) => void,
    ): void;
  };
  loadFile(filePath: string): Promise<void>;
  loadURL(url: string): Promise<void>;
}

export interface UtilityProcessLike {
  pid: number | undefined;
  postMessage(msg: unknown): void;
  on(event: 'message', cb: (msg: unknown) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  once(event: 'message', cb: (msg: unknown) => void): void;
  removeListener?(event: 'message', cb: (msg: unknown) => void): void;
  removeListener?(event: 'exit', cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ServerLockMetadataLike {
  pid: number;
  hostname: string;
  port: number;
  url?: string;
  startedAt: string;
  worktreeRoot: string;
  kind?: 'interactive' | 'mcp-spawned';
  capabilities?: string[];
  protocolVersion?: number;
  runtimeVersion?: string;
  machineId?: string;
  draining?: boolean;
}

function loopbackOriginFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname;
  const loopback =
    host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  return loopback ? parsed.origin : null;
}

function lockMayHaveServer(lock: { port?: unknown; url?: unknown }): boolean {
  if (loopbackOriginFromUrl(lock.url) !== null) return true;
  const port = typeof lock.port === 'string' ? Number(lock.port) : lock.port;
  return isDialablePort(port);
}

function lockIsAttachable(lock: { port?: unknown }): boolean {
  return isDialablePort(lock.port);
}

export function lockApiOrigin(lock: { port?: unknown; url?: unknown }): string {
  return loopbackOriginFromUrl(lock.url) ?? `http://localhost:${lock.port}`;
}

function httpOriginToWsOrigin(origin: string): string {
  return origin.replace(/^http/, 'ws');
}

export function lockWsOrigin(lock: Pick<ServerLockMetadataLike, 'port' | 'url'>): string {
  return httpOriginToWsOrigin(lockApiOrigin(lock));
}

export function collabUrlFromApiOrigin(apiOrigin: string): string {
  return `${httpOriginToWsOrigin(apiOrigin)}/collab`;
}

export function lockCollabUrl(lock: { port?: unknown; url?: unknown }): string {
  return collabUrlFromApiOrigin(lockApiOrigin(lock));
}

interface ProjectContext {
  projectPath: string;
  canonicalKey: string;
  projectName: string;
  port: number;
  apiOrigin: string;
  window: BrowserWindowLike;
  utility: UtilityProcessLike | null;
  ownsServer: boolean;
  ephemeral?: {
    projectDir: string;
    pid: number;
    lockDir: string;
  };
}

export interface EphemeralOpenIdentity {
  canonicalFilePath: string;
  contentDir: string;
  docName: string;
}

interface CreateProjectWindowOpts {
  projectPath: string;
  pendingDeepLinkTarget?: {
    kind: 'doc' | 'folder';
    path: string;
    repositoryPath?: string;
    contentRootDepth?: number;
  };
  pendingBranch?: string | null;
  pendingMultiCandidate?: boolean;
  pendingTargetMissing?: boolean;
  pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload;
  didEnsureGit?: boolean;
  consentVersion?: number;
  localOpCliArgs?: string[];
  pendingServerRestartedToast?: boolean;
  freshlyCreated?: boolean;
}

export interface WindowManagerDeps {
  createWindow(opts: {
    additionalArguments: string[];
    title: string;
    projectPath?: string;
    focusKey?: string;
  }): BrowserWindowLike;
  forkUtility(
    entry: string,
    args: string[],
    opts: { windowLifecycleBound?: boolean },
  ): UtilityProcessLike;
  utilityEntryPath: string;
  spawnDetachedServer?(opts: {
    contentDir: string;
    reactShellDistDir: string;
    singleFile?: string;
    projectDir?: string;
  }): Promise<{
    pid: number;
    readExit?: () => { code: number | null; signal: string | null } | null;
  }>;
  createEphemeralProjectDir?(contentDir: string): string;
  removeDir?(dir: string): Promise<void>;
  spawnLockPollDeadlineMs?: number;
  spawnLockProgressDeadlineMs?: number;
  sigtermGraceMs?: number;
  createKeepalive?(opts: { lockDir: string }): KeepaliveHandle;
  rendererEntryPath: string;
  rendererDevUrl?: string | null;
  appVersion: string;
  selfProtocolVersion?: number;
  selfRuntimeVersion?: string;
  reclaimForeignServerInDev?: boolean;
  isFirstLaunchAfterUpgrade?(): boolean;
  setTimeout(cb: () => void, ms: number): unknown;
  setInterval?(cb: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
  killProbe(pid: number, signal: number | NodeJS.Signals): void;
  showGate: ShowGateRegistry;
  runClean?(opts: { lockDir: string }): Promise<void>;
  realpathSync?(p: string): string;
  activateApp?(): void;
  readServerLock?(lockDir: string): ServerLockMetadataLike | null;
  removeServerLock?(lockDir: string, expected: { pid: number }): boolean;
  isProcessAlive?(pid: number): boolean;
  hostname?(): string;
  probeWsUpgrade?(url: string, timeoutMs: number): Promise<boolean>;
  utilityInitTimeoutMs?: number;
  onProjectServerRestarted?(args: {
    readonly projectPath: string;
    readonly apiOrigin: string;
  }): void;
  log?: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
  onUtilityMessage?(msg: unknown): void;
  onUtilityExit?(utility: UtilityProcessLike): void;
  recordServerExit?(info: Pick<ServerExitInfo, 'lockDir' | 'pid' | 'code'>): void;
  startup?: {
    traceparent?: string;
    markServerLockReady?(info?: { startedAt?: string; apiOrigin?: string }): void;
    markWindowCreated?(): void;
    markLoadUrlResolved?(): void;
  };
  safetyNet?: {
    openExternal: (url: string) => Promise<void>;
    openAsset: (projectPath: string, relPath: string) => Promise<AssetOpenResult>;
  };
}

export function signalDetachedServerStop(
  entries: ReadonlyArray<readonly [string, number]>,
  killProbe: (pid: number, signal: number | NodeJS.Signals) => void,
  log?: { warn(obj: object, msg: string): void },
): number {
  let signalled = 0;
  for (const [projectPath, pid] of entries) {
    try {
      killProbe(pid, 'SIGTERM');
      signalled++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') continue;
      log?.warn(
        {
          event: 'update-install-server-stop-failed',
          err,
          code,
          pid,
          projectPath,
        },
        'SIGTERM failed during before-quit-for-update teardown',
      );
    }
  }
  return signalled;
}

export function signalStopOwnedUtilityForks(
  contexts: Iterable<Pick<ProjectContext, 'ownsServer' | 'utility' | 'projectPath'>>,
  log?: { warn(obj: object, msg: string): void },
): void {
  for (const ctx of contexts) {
    if (!ctx.ownsServer || !ctx.utility) continue;
    try {
      ctx.utility.kill('SIGKILL');
    } catch (err) {
      log?.warn(
        { err, projectPath: ctx.projectPath },
        'utility SIGKILL failed during owned-server teardown',
      );
    }
  }
}

export class WindowManager {
  private readonly windowsByPath = new Map<string, ProjectContext>();

  private readonly ephemeralWindowIdentity = new Map<BrowserWindowLike, EphemeralOpenIdentity>();

  private readonly loadingContextByWindow = new Map<BrowserWindowLike, ProjectContext>();

  private readonly spawnedDetachedPids = new Map<string, number>();

  private readonly ephemeralPendingByPath = new Map<string, Promise<ProjectContext>>();

  private readonly projectPendingByPath = new Map<string, Promise<ProjectContext>>();

  private readonly keepalives = new Map<string, KeepaliveHandle>();

  constructor(private readonly deps: WindowManagerDeps) {}

  private canonicalizeKey(projectPath: string): string {
    const absolute = resolve(projectPath);
    const rp = this.deps.realpathSync ?? realpathSync;
    try {
      return rp(absolute);
    } catch {
      return absolute;
    }
  }

  getWindowFor(projectPath: string): ProjectContext | undefined {
    return this.windowsByPath.get(this.canonicalizeKey(projectPath));
  }

  focusWindowForProject(
    projectPath: string,
    opts?: { activate?: boolean },
  ): BrowserWindowLike | null {
    const ctx = this.windowsByPath.get(this.canonicalizeKey(projectPath));
    if (!ctx) return null;
    if (ctx.window.isDestroyed?.() === true) return null;
    this.bringToFront(ctx.window, opts);
    return ctx.window;
  }

  private bringToFront(win: BrowserWindowLike, opts?: { activate?: boolean }): void {
    const activate = opts?.activate ?? true;
    if (win.isMinimized?.()) win.restore?.();
    if (activate) {
      win.show?.();
    } else if (win.isVisible?.() !== true) {
      if (win.showInactive !== undefined) win.showInactive();
      else win.show?.();
    }
    const alreadyFrontmost = win.isFocused?.() === true;
    win.moveTop?.();
    win.focus();
    if (activate && !alreadyFrontmost) this.deps.activateApp?.();
  }

  getContextForBrowserWindow(win: BrowserWindowLike): ProjectContext | undefined {
    for (const ctx of this.windowsByPath.values()) {
      if (ctx.window === win) return ctx;
    }
    return this.loadingContextByWindow.get(win);
  }

  private publishLoadingContext(context: ProjectContext): () => void {
    this.loadingContextByWindow.set(context.window, context);
    return () => {
      this.loadingContextByWindow.delete(context.window);
    };
  }

  getOpenProjectPaths(): string[] {
    const paths: string[] = [];
    for (const ctx of this.windowsByPath.values()) {
      if (ctx.window.isDestroyed?.() === true) continue;
      paths.push(ctx.projectPath);
    }
    return paths;
  }

  getOpenWindows(): RestoredWindow[] {
    const windows: RestoredWindow[] = [];
    for (const ctx of this.windowsByPath.values()) {
      if (ctx.window.isDestroyed?.() === true) continue;
      windows.push(
        ctx.ephemeral !== undefined
          ? { kind: 'file', filePath: ctx.canonicalKey }
          : { kind: 'project', projectPath: ctx.projectPath },
      );
    }
    return windows;
  }

  windowCount(): number {
    return this.windowsByPath.size;
  }

  async stopAllOwnedServers(): Promise<void> {
    signalStopOwnedUtilityForks(this.windowsByPath.values(), this.deps.log);

    const stopOne = async (canonicalKey: string, pid: number): Promise<void> => {
      const projectPath = canonicalKey;
      try {
        this.deps.killProbe(pid, 'SIGTERM');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          return;
        }
        this.deps.log?.warn({ err, pid, projectPath }, 'SIGTERM failed during stopAllOwnedServers');
      }
      {
        const graceMs = this.deps.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          if (!this.isPidAlive(pid)) return;
          await new Promise<void>((resolveSleep) => {
            this.deps.setTimeout(() => {
              resolveSleep();
            }, DEFAULT_SIGTERM_POLL_MS);
          });
        }
      }
      try {
        this.deps.killProbe(pid, 'SIGKILL');
        this.deps.log?.warn(
          { event: 'auto-update-server-stop-escalated', pid, projectPath },
          '[window-manager] SIGTERM grace expired — escalated to SIGKILL',
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return;
        this.deps.log?.warn(
          {
            event: 'auto-update-server-stop-sigkill-failed',
            err,
            code,
            pid,
            projectPath,
          },
          '[window-manager] SIGKILL escalation failed — server may still be running',
        );
      }
    };
    const entries = [...this.spawnedDetachedPids.entries()];
    this.spawnedDetachedPids.clear();

    const ephemeralSessions = [...this.windowsByPath.values()]
      .map((ctx) => ctx.ephemeral)
      .filter((e): e is NonNullable<ProjectContext['ephemeral']> => e !== undefined);

    await Promise.all([
      ...entries.map(([key, pid]) => stopOne(key, pid)),
      ...ephemeralSessions.map((session) => this.teardownEphemeralSession(session)),
    ]);
  }

  signalStopAllOwnedServers(): void {
    signalStopOwnedUtilityForks(this.windowsByPath.values(), this.deps.log);

    const detached = [...this.spawnedDetachedPids.entries()];
    this.spawnedDetachedPids.clear();
    const ephemeral = [...this.windowsByPath.values()]
      .map((ctx) => ctx.ephemeral)
      .filter((e): e is NonNullable<ProjectContext['ephemeral']> => e !== undefined)
      .map((e) => [e.projectDir, e.pid] as const);
    const entries = [...detached, ...ephemeral];
    const signalled = signalDetachedServerStop(entries, this.deps.killProbe, this.deps.log);
    if (entries.length > 0) {
      this.deps.log?.info(
        { event: 'update-install-server-stop', count: entries.length, signalled },
        '[window-manager] signalled owned detached servers to stop for update install',
      );
    }
  }

  private isPidAlive(pid: number): boolean {
    const probe = this.deps.isProcessAlive;
    if (probe) return probe(pid);
    try {
      this.deps.killProbe(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private isEphemeralServerAlive(ctx: ProjectContext): boolean {
    const eph = ctx.ephemeral;
    if (eph === undefined) return true;
    if (!this.isPidAlive(eph.pid)) return false;
    const reader = this.deps.readServerLock;
    if (!reader) return true;
    const lock = reader(eph.lockDir);
    return lock !== null && lock.draining !== true;
  }

  private async terminateServerByPid(
    _lockDir: string,
    pid: number,
  ): Promise<{ ok: true; escalated: boolean } | { ok: false; reason: 'eperm' | 'other' }> {
    try {
      this.deps.killProbe(pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { ok: true, escalated: false };
      return { ok: false, reason: code === 'EPERM' ? 'eperm' : 'other' };
    }
    {
      const graceMs = this.deps.sigtermGraceMs ?? RESTART_SIGTERM_GRACE_MS;
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        if (!this.isPidAlive(pid)) return { ok: true, escalated: false };
        await new Promise<void>((resolveSleep) => {
          this.deps.setTimeout(() => resolveSleep(), DEFAULT_SIGTERM_POLL_MS);
        });
      }
    }
    try {
      this.deps.killProbe(pid, 'SIGKILL');
      return { ok: true, escalated: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { ok: true, escalated: true };
      return { ok: false, reason: code === 'EPERM' ? 'eperm' : 'other' };
    }
  }

  private async breakUnservingHolderLock(args: {
    lockDir: string;
    lock: Pick<ServerLockMetadataLike, 'pid' | 'url'> & { port: unknown };
    projectPath: string;
    caller: RecoveryCaller;
  }): Promise<boolean> {
    const { lockDir, lock, projectPath, caller } = args;
    const { event, phase } = RECOVERY_CALLERS[caller];
    const port = lock.port;
    if (!lockMayHaveServer(lock)) {
      if (port === 0) {
        this.deps.log?.warn(
          {
            event,
            outcome: 'eperm-stale-lock-break-skipped',
            reason: 'booting',
            pid: lock.pid,
            projectPath,
          },
          '[window-manager] holder has not bound a port yet — leaving its lock alone',
        );
        return false;
      }
      this.deps.log?.warn(
        {
          event,
          outcome: 'eperm-stale-lock-break-decided',
          reason: 'unservable-origin',
          pid: lock.pid,
          port,
          projectPath,
        },
        '[window-manager] holder names nowhere that could serve — breaking its stale lock',
      );
      return this.unlinkHolderLock({ lockDir, lock, projectPath, event });
    }
    const dialable = { pid: lock.pid, port, url: lock.url };
    if (await this.probeForeignLockWithGrace(dialable, phase)) return false;
    return this.unlinkHolderLock({ lockDir, lock, projectPath, event });
  }

  private unlinkHolderLock(args: {
    lockDir: string;
    lock: Pick<ServerLockMetadataLike, 'pid'> & { port?: unknown };
    projectPath: string;
    event: string;
  }): boolean {
    const { lockDir, lock, projectPath, event } = args;
    let broke = false;
    try {
      broke = this.deps.removeServerLock?.(lockDir, { pid: lock.pid }) ?? false;
    } catch (err) {
      this.deps.log?.warn(
        { event, outcome: 'eperm-stale-lock-break-failed', err, pid: lock.pid, projectPath },
        '[window-manager] could not break the stale lock',
      );
      return false;
    }
    if (!broke) {
      this.deps.log?.warn(
        { event, outcome: 'eperm-stale-lock-break-declined', pid: lock.pid, projectPath },
        '[window-manager] stale lock was not broken',
      );
      return false;
    }
    this.deps.log?.warn(
      {
        event,
        outcome: 'eperm-stale-lock-broken',
        pid: lock.pid,
        port: lock.port,
        projectPath,
      },
      "[window-manager] broke the unkillable holder's stale lock",
    );
    return true;
  }

  async forceStopConflictingServer(
    projectPath: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'eperm' | 'other' }> {
    const lockDir = getLocalDir(resolve(projectPath));
    let pid: unknown;
    let rawPort: unknown;
    let rawUrl: unknown;
    try {
      const raw = JSON.parse(readFileSync(join(lockDir, 'server.lock'), 'utf-8')) as {
        pid?: unknown;
        port?: unknown;
        url?: unknown;
      };
      pid = raw?.pid;
      rawPort = raw?.port;
      rawUrl = raw?.url;
    } catch {
      return { ok: true };
    }
    if (!isValidLockPidLocal(pid) || pid === process.pid) {
      return { ok: true };
    }
    const term = await this.terminateServerByPid(lockDir, pid);
    if (!term.ok && term.reason === 'eperm') {
      const broke = await this.breakUnservingHolderLock({
        lockDir,
        lock: {
          pid,
          port: rawPort,
          ...(typeof rawUrl === 'string' ? { url: rawUrl } : {}),
        },
        projectPath,
        caller: 'force-stop',
      });
      if (broke) return { ok: true };
    }
    this.deps.log?.info(
      {
        event: 'desktop-force-stop-conflicting-server',
        pid,
        projectPath,
        outcome: term.ok ? 'stopped' : term.reason,
      },
      '[window-manager] force-stopped conflicting server holder on user request',
    );
    return term.ok ? { ok: true } : term;
  }

  async restartAttachedServer(
    projectPath: string,
    opts?: { localOpCliArgs?: string[] },
  ): Promise<OkServerRestartOutcome> {
    const resolved = resolve(projectPath);
    const canonicalKey = this.canonicalizeKey(resolved);
    const lockDir = getLocalDir(resolved);
    const lock = this.deps.readServerLock?.(lockDir) ?? null;
    if (lock && isValidLockPidLocal(lock.pid)) {
      const term = await this.terminateServerByPid(lockDir, lock.pid);
      if (!term.ok) {
        const broke =
          term.reason === 'eperm' &&
          (await this.breakUnservingHolderLock({
            lockDir,
            lock,
            projectPath: resolved,
            caller: 'restart',
          }));
        if (!broke) {
          this.deps.log?.warn(
            {
              event: 'desktop-server-restart',
              outcome: term.reason,
              pid: lock.pid,
              projectPath: resolved,
            },
            '[window-manager] server restart could not terminate the attached server',
          );
          return term;
        }
      } else {
        this.deps.log?.info(
          {
            event: 'desktop-server-restart',
            outcome: 'terminated',
            escalated: term.escalated,
            pid: lock.pid,
            appRuntime: this.deps.selfRuntimeVersion ?? null,
            projectPath: resolved,
          },
          '[window-manager] terminated attached server for restart',
        );
      }
    }
    const originating = this.windowsByPath.get(canonicalKey);
    let releaseOriginatingContext: (() => void) | undefined;
    if (originating) {
      this.windowsByPath.delete(canonicalKey);
      releaseOriginatingContext = this.publishLoadingContext(originating);
    }
    try {
      let recreated: ProjectContext;
      try {
        recreated = await this.createProjectWindow({
          projectPath: resolved,
          pendingServerRestartedToast: true,
          localOpCliArgs: opts?.localOpCliArgs,
        });
      } catch (err) {
        this.deps.log?.warn(
          {
            event: 'desktop-server-restart',
            outcome: 'recreate-failed',
            err: err instanceof Error ? (err.stack ?? err.message) : String(err),
            projectPath: resolved,
          },
          '[window-manager] server restart killed the old server but could not respawn',
        );
        if (originating && originating.window.isDestroyed?.() !== true) {
          this.windowsByPath.set(canonicalKey, originating);
        }
        return { ok: false, reason: 'other' };
      }
      releaseOriginatingContext?.();
      try {
        this.deps.onProjectServerRestarted?.({
          projectPath: resolved,
          apiOrigin: recreated.apiOrigin,
        });
      } catch (err) {
        this.deps.log?.warn(
          {
            event: 'desktop-server-restart',
            outcome: 'note-recreate-failed',
            err: err instanceof Error ? (err.stack ?? err.message) : String(err),
            projectPath: resolved,
          },
          '[window-manager] project window recreated, but a note-window recreate threw',
        );
      }
      if (originating) await this.closeAndAwait(originating.window);
      return { ok: true };
    } finally {
      releaseOriginatingContext?.();
    }
  }

  getEphemeralIdentityForWindow(win: BrowserWindowLike): EphemeralOpenIdentity | undefined {
    return this.ephemeralWindowIdentity.get(win);
  }

  async restartEphemeralServer(
    identity: EphemeralOpenIdentity,
    requestingWindow: BrowserWindowLike,
  ): Promise<OkServerRestartOutcome> {
    this.deps.log?.info(
      {
        event: 'desktop-ephemeral-restart',
        outcome: 'requested',
        file: identity.canonicalFilePath,
      },
      '[window-manager] ephemeral server restart requested',
    );
    try {
      const canonicalKey = this.canonicalizeKey(identity.canonicalFilePath);
      const current = this.windowsByPath.get(canonicalKey);
      if (
        current &&
        current.window === requestingWindow &&
        current.window.isDestroyed?.() !== true &&
        this.isEphemeralServerAlive(current)
      ) {
        this.deps.log?.info(
          {
            event: 'desktop-ephemeral-restart',
            outcome: 'terminated-live',
            file: identity.canonicalFilePath,
          },
          '[window-manager] terminating the live ephemeral server before respawn',
        );
        this.windowsByPath.delete(canonicalKey);
        this.closeKeepalive(canonicalKey);
        if (current.ephemeral) await this.teardownEphemeralSession(current.ephemeral);
      }
      const recreated = await this.createEphemeralWindow({
        canonicalFilePath: identity.canonicalFilePath,
        contentDir: identity.contentDir,
        docName: identity.docName,
      });
      this.deps.log?.info(
        {
          event: 'desktop-ephemeral-restart',
          outcome: 'respawned',
          file: identity.canonicalFilePath,
          apiOrigin: recreated.apiOrigin,
        },
        '[window-manager] ephemeral server restart respawned',
      );
      return { ok: true };
    } catch (err) {
      this.deps.log?.warn(
        {
          event: 'desktop-ephemeral-restart',
          outcome: 'recreate-failed',
          err: err instanceof Error ? (err.stack ?? err.message) : String(err),
          file: identity.canonicalFilePath,
        },
        '[window-manager] ephemeral server restart could not respawn',
      );
      return { ok: false, reason: 'other' };
    }
  }

  async restartServerForWindow(
    sender: BrowserWindowLike | null,
    projectPath: string,
    opts: { localOpCliArgs?: string[] },
  ): Promise<OkServerRestartOutcome> {
    if (sender !== null) {
      const ephemeralIdentity = this.getEphemeralIdentityForWindow(sender);
      if (ephemeralIdentity !== undefined) {
        return this.restartEphemeralServer(ephemeralIdentity, sender);
      }
    }
    return this.restartAttachedServer(projectPath, opts);
  }

  private retireStaleWindowsForFile(canonicalKey: string, keepWindow: BrowserWindowLike): void {
    const stale: BrowserWindowLike[] = [];
    for (const [win, identity] of this.ephemeralWindowIdentity) {
      if (win === keepWindow) continue;
      if (this.canonicalizeKey(identity.canonicalFilePath) !== canonicalKey) continue;
      stale.push(win);
    }
    if (stale.length === 0) return;
    this.deps.log?.info(
      { event: 'desktop-ephemeral-retire-stale', canonicalKey, retired: stale.length },
      '[window-manager] retiring stale ephemeral window(s) for the file',
    );
    for (const win of stale) void this.closeAndAwait(win);
  }

  private closeKeepalive(canonicalKey: string): void {
    const keepalive = this.keepalives.get(canonicalKey);
    if (keepalive) {
      keepalive.close();
      this.keepalives.delete(canonicalKey);
    }
  }

  private async closeAndAwait(window: BrowserWindowLike): Promise<void> {
    if (window.isDestroyed?.() === true) return;
    await new Promise<void>((resolveClosed) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolveClosed();
      };
      window.on('closed', finish);
      window.close?.();
      this.deps.setTimeout(() => {
        if (!settled && window.isDestroyed?.() !== true) window.destroy?.();
        finish();
      }, 2_000);
    });
  }

  private attachSafetyNet(
    webContents: BrowserWindowLike['webContents'],
    editorOrigin: string,
    assetRoot: string,
  ): void {
    const net = this.deps.safetyNet;
    if (!net) return;
    attachAssetSafetyNet(webContents, {
      editorOrigin,
      openExternal: net.openExternal,
      openAsset: (relPath) => net.openAsset(assetRoot, relPath),
    });
  }

  async createProjectWindow(opts: CreateProjectWindowOpts): Promise<ProjectContext> {
    const canonicalKey = this.canonicalizeKey(resolve(opts.projectPath));
    const inFlight = this.projectPendingByPath.get(canonicalKey);
    if (inFlight) {
      const ctx = await inFlight;
      if (ctx.window.isDestroyed?.() !== true) {
        this.bringToFront(ctx.window);
        return ctx;
      }
    }
    const work = (async (): Promise<ProjectContext> => {
      try {
        return await this.spawnProjectWindow(opts);
      } finally {
        this.projectPendingByPath.delete(canonicalKey);
      }
    })();
    this.projectPendingByPath.set(canonicalKey, work);
    return work;
  }

  private async spawnProjectWindow(opts: CreateProjectWindowOpts): Promise<ProjectContext> {
    const projectPath = resolve(opts.projectPath);
    const canonicalKey = this.canonicalizeKey(projectPath);
    const existing = this.windowsByPath.get(canonicalKey);
    if (existing) {
      if (existing.window.isDestroyed?.() !== true) {
        this.bringToFront(existing.window);
        return existing;
      }
      this.deps.log?.warn(
        { canonicalKey },
        '[window-manager] stale destroyed-window entry — clearing and re-creating',
      );
      this.windowsByPath.delete(canonicalKey);
    }
    const projectName = basename(projectPath);

    const lockDir = getLocalDir(projectPath);

    const candidate = this.tryAttachExistingServer(lockDir);
    const attached =
      candidate !== null && (await this.probeAttachableLock(candidate)) ? candidate : null;
    if (attached) {
      const isForeign = this.spawnedDetachedPids.get(canonicalKey) !== attached.pid;
      let reclaimed = false;
      if (this.deps.reclaimForeignServerInDev === true && isForeign) {
        const term = await this.terminateServerByPid(lockDir, attached.pid);
        if (term.ok) {
          this.deps.log?.info(
            {
              event: 'desktop-dev-reclaim',
              outcome: 'terminated',
              escalated: term.escalated,
              pid: attached.pid,
              projectPath,
            },
            '[window-manager] dev-mode reclaimed foreign server; spawning fresh own-build server',
          );
          reclaimed = true;
        } else {
          this.deps.log?.warn(
            {
              event: 'desktop-dev-reclaim',
              outcome: term.reason,
              pid: attached.pid,
              projectPath,
            },
            '[window-manager] dev-mode reclaim could not terminate the foreign server; attaching to it instead',
          );
        }
      }
      if (!reclaimed && this.deps.isFirstLaunchAfterUpgrade?.() === true && isForeign) {
        const selfProtocol = this.deps.selfProtocolVersion;
        const selfRuntime = this.deps.selfRuntimeVersion;
        if (selfProtocol !== undefined && selfRuntime !== undefined) {
          const drift = classifyServerVersion(
            { protocolVersion: attached.protocolVersion, runtimeVersion: attached.runtimeVersion },
            { protocolVersion: selfProtocol, runtimeVersion: selfRuntime },
          );
          if (drift.relation === 'older' || drift.relation === 'newer') {
            const term = await this.terminateServerByPid(lockDir, attached.pid);
            if (term.ok) {
              this.deps.log?.info(
                {
                  event: 'desktop-upgrade-reconcile',
                  outcome: 'terminated',
                  escalated: term.escalated,
                  relation: drift.relation,
                  pid: attached.pid,
                  projectPath,
                },
                '[window-manager] first launch after upgrade — auto-terminated pre-upgrade server; spawning fresh own-version server',
              );
              reclaimed = true;
            } else {
              this.deps.log?.warn(
                {
                  event: 'desktop-upgrade-reconcile',
                  outcome: term.reason,
                  relation: drift.relation,
                  pid: attached.pid,
                  projectPath,
                },
                '[window-manager] upgrade auto-terminate failed; attaching to the pre-upgrade server (the manual version-drift prompt still offers a restart)',
              );
            }
          }
        }
      }
      if (!reclaimed) {
        return this.attachToExistingServer({
          projectPath,
          canonicalKey,
          projectName,
          lock: attached,
          pendingDeepLinkTarget: opts.pendingDeepLinkTarget,
          pendingBranch: opts.pendingBranch,
          pendingMultiCandidate: opts.pendingMultiCandidate,
          pendingTargetMissing: opts.pendingTargetMissing,
          pendingShareBranchSwitch: opts.pendingShareBranchSwitch,
          pendingServerRestartedToast: opts.pendingServerRestartedToast,
          freshlyCreated: opts.freshlyCreated,
        });
      }
    }

    if (this.deps.runClean) {
      try {
        await this.deps.runClean({ lockDir });
      } catch (err) {
        this.deps.log?.warn({ err, lockDir }, 'runClean failed; proceeding to spawn server');
      }
    }

    if (this.deps.spawnDetachedServer) {
      const reactShellDistDir = dirname(this.deps.rendererEntryPath);
      const handle = await this.deps.spawnDetachedServer({
        contentDir: projectPath,
        reactShellDistDir,
      });
      this.spawnedDetachedPids.set(canonicalKey, handle.pid);
      const POLL_DEADLINE_MS =
        this.deps.spawnLockPollDeadlineMs ?? DEFAULT_SPAWN_STARTUP_DEADLINE_MS;
      const { lock, waitedDeadlineMs } = await this.pollServerLock(
        lockDir,
        POLL_DEADLINE_MS,
        handle,
        this.deps.spawnLockProgressDeadlineMs,
      );
      if (lock === null) {
        const childExited = this.deps.isProcessAlive
          ? !this.deps.isProcessAlive(handle.pid)
          : undefined;
        const childExit = handle.readExit?.() ?? null;
        try {
          this.deps.killProbe(handle.pid, 'SIGTERM');
        } catch (signalErr) {
          const code = (signalErr as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            this.deps.log?.warn(
              {
                event: 'desktop-spawn-orphan-sigterm-failed',
                err: signalErr,
                code,
                pid: handle.pid,
                projectPath,
              },
              '[window-manager] SIGTERM on orphan after spawn-lock-timeout failed',
            );
          }
        }
        this.spawnedDetachedPids.delete(canonicalKey);
        throw this.buildSpawnFailureError({
          pid: handle.pid,
          exit: childExit,
          lockDir,
          deadlineMs: waitedDeadlineMs,
          spawnLabel: 'spawn',
          childExited,
        });
      }
      const adoptedForeignLock = lock.pid !== handle.pid;
      const unusableLock = !lockIsAttachable(lock);
      if (unusableLock || (adoptedForeignLock && !(await this.probeForeignLockWithGrace(lock)))) {
        const childExited = this.deps.isProcessAlive
          ? !this.deps.isProcessAlive(handle.pid)
          : undefined;
        const childExit = handle.readExit?.() ?? null;
        try {
          this.deps.killProbe(handle.pid, 'SIGTERM');
        } catch (signalErr) {
          const code = (signalErr as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            this.deps.log?.warn(
              {
                event: 'desktop-spawn-orphan-sigterm-failed',
                err: signalErr,
                code,
                pid: handle.pid,
                projectPath,
              },
              '[window-manager] SIGTERM on orphan after refusing a stale lock failed',
            );
          }
        }
        this.spawnedDetachedPids.delete(canonicalKey);
        this.deps.log?.warn(
          {
            event: 'desktop-server-spawn-refused-stale-lock',
            reason: unusableLock ? 'lock-not-attachable' : 'holder-not-serving',
            pid: handle.pid,
            lockPid: lock.pid,
            port: lock.port,
            portType: typeof lock.port,
            rawPort: String(lock.port),
            lockDir,
            projectPath,
          },
          '[window-manager] refusing to attach the spawn to a lock we cannot use',
        );
        const holder = adoptedForeignLock
          ? `Another process (pid ${lock.pid})`
          : `The server OpenKnowledge just started (pid ${lock.pid})`;
        throw Object.assign(
          new Error(
            unusableLock
              ? `${holder} holds this project's server lock, but the lock does not name a port ` +
                  `OpenKnowledge can keep a connection open on (${String(lock.port)}).`
              : `${holder} holds this project's server lock but is not serving on port ${lock.port}.`,
          ),
          {
            name: 'StaleLockHolderError',
            kind: 'stale-lock-holder' as const,
            reason: unusableLock
              ? ('lock-not-attachable' as const)
              : ('holder-not-serving' as const),
            holderIsOwnChild: !adoptedForeignLock,
            holderPid: lock.pid,
            holderPort: lock.port,
            pid: handle.pid,
            childExited,
            exitCode: childExit?.code ?? null,
            exitSignal: childExit?.signal ?? null,
          },
        );
      }
      this.deps.log?.info(
        {
          event: 'desktop-server-spawned-detached',
          pid: handle.pid,
          lockPid: lock.pid,
          readiness: adoptedForeignLock ? 'foreign-lock-probe-verified' : 'own-child',
          port: lock.port,
          lockDir,
        },
        '[window-manager] detached server ready',
      );
      this.deps.startup?.markServerLockReady?.({
        startedAt: lock.startedAt,
        apiOrigin: lockApiOrigin(lock),
      });
      return this.attachToExistingServer({
        projectPath,
        canonicalKey,
        projectName,
        lock,
        pendingDeepLinkTarget: opts.pendingDeepLinkTarget,
        pendingBranch: opts.pendingBranch,
        pendingMultiCandidate: opts.pendingMultiCandidate,
        pendingTargetMissing: opts.pendingTargetMissing,
        pendingShareBranchSwitch: opts.pendingShareBranchSwitch,
        pendingServerRestartedToast: opts.pendingServerRestartedToast,
        freshlyCreated: opts.freshlyCreated,
      });
    }

    const INIT_TIMEOUT_MS = this.deps.utilityInitTimeoutMs ?? 15_000;

    const utility = this.deps.forkUtility(
      this.deps.utilityEntryPath,
      [`--ok-lock-dir-b64=${Buffer.from(lockDir, 'utf8').toString('base64url')}`],
      {
        windowLifecycleBound: true,
      },
    );
    const utilityRef = utility;
    const ready = new Promise<{ port: number; apiOrigin: string }>((resolveReady, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        utilityRef.removeListener?.('message', onMessage);
        utilityRef.removeListener?.('exit', onExit);
        fn();
      };
      const onMessage = (msg: unknown) => {
        const m = msg as {
          type?: string;
          port?: number;
          apiOrigin?: string;
          message?: string;
          kind?: string;
          existingLock?: ServerLockMetadataLike;
        };
        if (m.type === 'ready' && typeof m.port === 'number' && typeof m.apiOrigin === 'string') {
          const p = m.port;
          const o = m.apiOrigin;
          settle(() => resolveReady({ port: p, apiOrigin: o }));
        } else if (m.type === 'error') {
          const richError = Object.assign(new Error(m.message ?? 'utility init failed'), {
            name: m.kind === 'lock-collision' ? 'LockCollisionError' : 'UtilityInitError',
            kind: m.kind,
            existingLock: m.existingLock,
          });
          settle(() => reject(richError));
        }
      };
      const onExit = (code: number | null) => {
        settle(() => reject(new Error(`utility exited before ready (code=${code})`)));
      };
      utilityRef.on('message', onMessage);
      utilityRef.on('exit', onExit);

      this.deps.setTimeout(() => {
        settle(() => reject(new Error(`utility init timed out after ${INIT_TIMEOUT_MS}ms`)));
      }, INIT_TIMEOUT_MS);
    });

    const reactShellDistDir = this.deps.rendererDevUrl
      ? null
      : dirname(this.deps.rendererEntryPath);

    utility.postMessage({
      type: 'init',
      opts: {
        contentDir: projectPath,
        projectDir: projectPath,
        port: 0,
        host: DEFAULT_SERVER_HOST,
        didEnsureGit: opts.didEnsureGit === true,
        consentVersion: opts.consentVersion ?? 1,
        ...(reactShellDistDir !== null ? { reactShellDistDir } : {}),
        ...(opts.localOpCliArgs ? { localOpCliArgs: opts.localOpCliArgs } : {}),
      },
    });

    const { port, apiOrigin } = await ready;
    this.deps.startup?.markServerLockReady?.({ apiOrigin });

    if (this.deps.onUtilityMessage) {
      const onMessage = this.deps.onUtilityMessage;
      utility.on('message', (msg) => onMessage(msg));
    }

    utility.on('exit', (code) => {
      this.deps.log?.info({ pid: utility.pid, code }, 'utility exited');
      this.deps.recordServerExit?.({ lockDir, pid: utility.pid ?? null, code });
      this.windowsByPath.delete(canonicalKey);
      this.deps.onUtilityExit?.(utility);
      const pid = utility.pid;
      if (typeof pid === 'number') {
        this.deps.setTimeout(() => {
          try {
            this.deps.killProbe(pid, 0);
            this.deps.log?.warn(
              { pid },
              'utility pid still alive 1s after exit event — sending SIGTERM',
            );
            this.deps.killProbe(pid, 'SIGTERM');
          } catch {}
        }, 1000);
      }
    });

    const additionalArguments = [
      `--ok-collab-url=ws://localhost:${port}/collab`,
      `--ok-api-origin=${apiOrigin}`,
      `--ok-project-path=${projectPath}`,
      `--ok-project-name=${projectName}`,
      `--ok-mode=editor`,
      `--ok-app-version=${this.deps.appVersion}`,
      ...instanceLabelArgs(),
      ...(this.deps.startup?.traceparent !== undefined
        ? [`--ok-startup-traceparent=${this.deps.startup.traceparent}`]
        : []),
      ...(opts.freshlyCreated ? ['--ok-fresh-create=1'] : []),
    ];
    const window = this.deps.createWindow({
      additionalArguments,
      title: formatEditorTitle(projectName),
      projectPath,
    });
    this.deps.startup?.markWindowCreated?.();
    this.attachSafetyNet(window.webContents, apiOrigin, projectPath);

    if (opts.pendingDeepLinkTarget) {
      const doc = opts.pendingDeepLinkTarget.path;
      const kind = opts.pendingDeepLinkTarget.kind;
      const branch = opts.pendingBranch ?? null;
      const multiCandidate = opts.pendingMultiCandidate === true;
      registerPendingDelivery(window.webContents, 'ok:deep-link', {
        doc,
        kind,
        branch,
        multiCandidate,
        ...(opts.pendingDeepLinkTarget.repositoryPath === undefined
          ? {}
          : { repositoryPath: opts.pendingDeepLinkTarget.repositoryPath }),
        ...(opts.pendingDeepLinkTarget.contentRootDepth === undefined
          ? {}
          : { contentRootDepth: opts.pendingDeepLinkTarget.contentRootDepth }),
        ...(opts.pendingTargetMissing === true ? { targetMissing: true } : {}),
      });
    }

    if (opts.pendingShareBranchSwitch) {
      const branchSwitch = opts.pendingShareBranchSwitch;
      registerPendingDelivery(window.webContents, 'ok:share:received', {
        kind: 'project-branch-switch' as const,
        share: branchSwitch.share,
        projectPath: branchSwitch.projectPath,
        currentBranch: branchSwitch.currentBranch,
      });
    }

    const disposeShowGate = this.deps.showGate.register(window, { kind: 'editor' });

    const context: ProjectContext = {
      projectPath,
      canonicalKey,
      projectName,
      port,
      apiOrigin,
      window,
      utility,
      ownsServer: true,
    };
    const releaseLoadingContext = this.publishLoadingContext(context);
    try {
      if (this.deps.rendererDevUrl) {
        await window.loadURL(this.deps.rendererDevUrl);
      } else {
        await window.loadFile(this.deps.rendererEntryPath);
      }
      this.deps.startup?.markLoadUrlResolved?.();

      window.on('closed', () => {
        disposeShowGate();
        try {
          utility.postMessage({ type: 'shutdown' });
        } catch (err) {
          this.deps.log?.warn(
            { err, projectPath },
            'utility shutdown IPC failed on window close (likely already exited)',
          );
        }
      });

      this.windowsByPath.set(canonicalKey, context);
    } finally {
      releaseLoadingContext();
    }
    return context;
  }

  async createEphemeralWindow(opts: {
    canonicalFilePath: string;
    contentDir: string;
    docName: string;
  }): Promise<ProjectContext> {
    const canonicalKey = this.canonicalizeKey(opts.canonicalFilePath);
    const existing = this.windowsByPath.get(canonicalKey);
    if (existing) {
      const windowAlive = existing.window.isDestroyed?.() !== true;
      if (windowAlive && this.isEphemeralServerAlive(existing)) {
        this.bringToFront(existing.window);
        this.retireStaleWindowsForFile(canonicalKey, existing.window);
        return existing;
      }
      this.deps.log?.warn(
        {
          event: 'desktop-ephemeral-stale-entry',
          canonicalKey,
          windowAlive,
          pid: existing.ephemeral?.pid,
          apiOrigin: existing.apiOrigin,
          lockDir: existing.ephemeral?.lockDir,
        },
        windowAlive
          ? '[window-manager] ephemeral entry has a dead server — clearing and re-spawning'
          : '[window-manager] stale destroyed ephemeral entry — clearing and re-creating',
      );
      this.windowsByPath.delete(canonicalKey);
      this.closeKeepalive(canonicalKey);
      if (windowAlive && existing.ephemeral) {
        void this.teardownEphemeralSession(existing.ephemeral);
      }
    }

    const inFlight = this.ephemeralPendingByPath.get(canonicalKey);
    if (inFlight) {
      const ctx = await inFlight;
      if (ctx.window.isDestroyed?.() !== true) {
        this.bringToFront(ctx.window);
        return ctx;
      }
      return this.createEphemeralWindow(opts);
    }

    const work = (async (): Promise<ProjectContext> => {
      try {
        return await this.spawnEphemeralWindow(opts, canonicalKey);
      } finally {
        this.ephemeralPendingByPath.delete(canonicalKey);
      }
    })();
    this.ephemeralPendingByPath.set(canonicalKey, work);
    return work;
  }

  private async spawnEphemeralWindow(
    opts: { canonicalFilePath: string; contentDir: string; docName: string },
    canonicalKey: string,
  ): Promise<ProjectContext> {
    const { createEphemeralProjectDir, spawnDetachedServer, removeDir } = this.deps;
    if (!createEphemeralProjectDir || !spawnDetachedServer || !removeDir) {
      throw new Error(
        'createEphemeralWindow requires createEphemeralProjectDir + spawnDetachedServer + removeDir deps to be wired',
      );
    }

    const projectName = basename(opts.canonicalFilePath);

    const tempProjectDir = createEphemeralProjectDir(opts.contentDir);
    const lockDir = getLocalDir(tempProjectDir);

    const reactShellDistDir = dirname(this.deps.rendererEntryPath);
    let handle: Awaited<ReturnType<NonNullable<WindowManagerDeps['spawnDetachedServer']>>>;
    try {
      handle = await spawnDetachedServer({
        contentDir: opts.contentDir,
        reactShellDistDir,
        singleFile: opts.canonicalFilePath,
        projectDir: tempProjectDir,
      });
    } catch (err) {
      await removeDir(tempProjectDir).catch(() => {});
      throw err;
    }

    const POLL_DEADLINE_MS = this.deps.spawnLockPollDeadlineMs ?? DEFAULT_SPAWN_STARTUP_DEADLINE_MS;
    const { lock, waitedDeadlineMs } = await this.pollServerLock(
      lockDir,
      POLL_DEADLINE_MS,
      handle,
      this.deps.spawnLockProgressDeadlineMs,
    );
    if (lock === null) {
      const childExited = this.deps.isProcessAlive
        ? !this.deps.isProcessAlive(handle.pid)
        : undefined;
      const childExit = handle.readExit?.() ?? null;
      try {
        this.deps.killProbe(handle.pid, 'SIGTERM');
      } catch (signalErr) {
        const code = (signalErr as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          this.deps.log?.warn(
            {
              event: 'desktop-ephemeral-spawn-orphan-sigterm-failed',
              err: signalErr,
              code,
              pid: handle.pid,
            },
            '[window-manager] SIGTERM on ephemeral orphan after spawn-lock-timeout failed',
          );
        }
      }
      await removeDir(tempProjectDir).catch(() => {});
      throw this.buildSpawnFailureError({
        pid: handle.pid,
        exit: childExit,
        lockDir,
        deadlineMs: waitedDeadlineMs,
        spawnLabel: 'ephemeral spawn',
        childExited,
      });
    }

    const port = lock.port;
    const apiOrigin = lockApiOrigin(lock);
    this.deps.log?.info(
      {
        event: 'desktop-ephemeral-server-spawned',
        pid: handle.pid,
        port,
        lockDir,
        file: opts.canonicalFilePath,
      },
      '[window-manager] ephemeral single-file server ready',
    );

    const window = this.deps.createWindow({
      additionalArguments: [
        `--ok-collab-url=${lockCollabUrl(lock)}`,
        `--ok-api-origin=${apiOrigin}`,
        `--ok-project-path=${opts.contentDir}`,
        `--ok-project-name=${projectName}`,
        `--ok-mode=editor`,
        `--ok-single-file=1`,
        `--ok-initial-doc=${opts.docName}`,
        `--ok-app-version=${this.deps.appVersion}`,
        ...instanceLabelArgs(),
      ],
      title: formatEditorTitle(projectName),
      focusKey: canonicalKey,
    });
    this.attachSafetyNet(window.webContents, apiOrigin, opts.contentDir);

    const disposeShowGate = this.deps.showGate.register(window, { kind: 'editor' });

    const context: ProjectContext = {
      projectPath: opts.contentDir,
      canonicalKey,
      projectName,
      port,
      apiOrigin,
      window,
      utility: null,
      ownsServer: false,
      ephemeral: { projectDir: tempProjectDir, pid: handle.pid, lockDir },
    };
    let watchHandle: unknown;
    let watchCleared = false;
    const stopExitWatch = (): void => {
      if (watchCleared) return;
      watchCleared = true;
      if (watchHandle !== undefined) this.deps.clearInterval?.(watchHandle);
    };

    const releaseLoadingContext = this.publishLoadingContext(context);

    try {
      try {
        if (this.deps.rendererDevUrl) {
          await window.loadURL(this.deps.rendererDevUrl);
        } else {
          await window.loadFile(this.deps.rendererEntryPath);
        }
      } catch (err) {
        releaseLoadingContext();
        disposeShowGate();
        window.destroy?.();
        await this.teardownEphemeralSession({
          projectDir: tempProjectDir,
          pid: handle.pid,
          lockDir,
        });
        throw err;
      }

      window.on('closed', () => {
        stopExitWatch();
        disposeShowGate();
        this.ephemeralWindowIdentity.delete(window);
        if (this.windowsByPath.get(canonicalKey) !== context) return;
        this.windowsByPath.delete(canonicalKey);
        this.closeKeepalive(canonicalKey);
        void this.teardownEphemeralSession(
          context.ephemeral as NonNullable<ProjectContext['ephemeral']>,
        );
      });

      this.windowsByPath.set(canonicalKey, context);
      if (this.deps.createKeepalive) {
        const existingKeepalive = this.keepalives.get(canonicalKey);
        if (existingKeepalive) existingKeepalive.close();
        this.keepalives.set(canonicalKey, this.deps.createKeepalive({ lockDir }));
      }
      this.ephemeralWindowIdentity.set(window, {
        canonicalFilePath: opts.canonicalFilePath,
        contentDir: opts.contentDir,
        docName: opts.docName,
      });
      this.retireStaleWindowsForFile(canonicalKey, window);
    } finally {
      releaseLoadingContext();
    }

    if (this.deps.setInterval) {
      watchHandle = this.deps.setInterval(() => {
        try {
          if (watchCleared) return;
          if (this.windowsByPath.get(canonicalKey) !== context) {
            stopExitWatch();
            return;
          }
          if (this.isEphemeralServerAlive(context)) return;
          stopExitWatch();
          const eph = context.ephemeral as NonNullable<ProjectContext['ephemeral']>;
          this.deps.log?.warn(
            {
              event: 'desktop-ephemeral-server-exited',
              pid: eph.pid,
              lockDir: eph.lockDir,
              file: opts.canonicalFilePath,
            },
            '[window-manager] ephemeral server exited while its window was open — reaping the dead session temp dir',
          );
          this.closeKeepalive(canonicalKey);
          void this.teardownEphemeralSession(eph);
        } catch (err) {
          this.deps.log?.warn(
            {
              event: 'desktop-ephemeral-watch-probe-failed',
              err,
              file: opts.canonicalFilePath,
              pid: context.ephemeral?.pid,
              lockDir: context.ephemeral?.lockDir,
            },
            '[window-manager] ephemeral server-liveness probe threw — skipping this poll cycle',
          );
        }
      }, EPHEMERAL_SERVER_WATCH_POLL_MS);
    }

    return context;
  }

  private async teardownEphemeralSession(session: {
    projectDir: string;
    pid: number;
    lockDir: string;
  }): Promise<void> {
    try {
      const term = await this.terminateServerByPid(session.lockDir, session.pid);
      if (!term.ok) {
        this.deps.log?.warn(
          {
            event: 'desktop-ephemeral-teardown',
            outcome: term.reason,
            pid: session.pid,
            projectDir: session.projectDir,
          },
          '[window-manager] ephemeral server termination did not confirm; removing temp dir anyway',
        );
      }
      await this.deps.removeDir?.(session.projectDir).catch((err: unknown) => {
        this.deps.log?.warn(
          {
            event: 'desktop-ephemeral-teardown',
            err,
            projectDir: session.projectDir,
          },
          '[window-manager] failed to remove ephemeral temp dir',
        );
      });
    } catch (err) {
      this.deps.log?.warn(
        {
          event: 'desktop-ephemeral-teardown-unexpected',
          err,
          pid: session.pid,
          projectDir: session.projectDir,
        },
        '[window-manager] unexpected error tearing down ephemeral session',
      );
    }
  }

  closeProjectWindow(projectPath: string): boolean {
    const ctx = this.windowsByPath.get(this.canonicalizeKey(projectPath));
    if (!ctx) return false;
    if (!ctx.ownsServer || !ctx.utility) {
      return true;
    }
    try {
      ctx.utility.postMessage({ type: 'shutdown' });
    } catch (err) {
      this.deps.log?.warn(
        { err, projectPath },
        'utility shutdown IPC failed in closeProjectWindow (likely already exited)',
      );
    }
    return true;
  }

  private buildSpawnFailureError(opts: {
    pid: number;
    exit: { code: number | null; signal: string | null } | null;
    lockDir: string;
    deadlineMs: number;
    spawnLabel: string;
    childExited: boolean | undefined;
  }): Error {
    const { pid, exit, lockDir, deadlineMs, spawnLabel, childExited } = opts;
    const STDERR_TAIL_BYTES = 8192;
    let stderrTail: string | undefined;
    try {
      const attempt = sliceLastSpawnAttempt(
        readFileSync(join(lockDir, SPAWN_ERROR_LOG), 'utf-8'),
      ).trim();
      stderrTail =
        attempt.length > STDERR_TAIL_BYTES ? `…${attempt.slice(-STDERR_TAIL_BYTES)}` : attempt;
    } catch (readErr) {
      const code = (readErr as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        this.deps.log?.warn(
          { event: 'desktop-spawn-error-log-read-failed', err: readErr, code, lockDir },
          '[window-manager] could not read the spawn error log',
        );
      }
    }

    const exited = exit !== null || childExited === true;

    let messageBase: string;
    if (exited) {
      const reason =
        exit === null
          ? ''
          : exit.signal !== null
            ? `, killed by ${exit.signal}`
            : exit.code !== null
              ? `, exit code ${exit.code}`
              : '';
      messageBase = `OpenKnowledge server exited before binding a port (pid=${pid}${reason}).`;
    } else {
      const liveness = childExited === false ? ', still running' : '';
      messageBase = `OpenKnowledge server did not bind a port within ${deadlineMs}ms after ${spawnLabel} (pid=${pid}${liveness}).`;
    }

    const stderrHeading = exited
      ? '--- stderr ---'
      : '--- server output (printed during startup; probably not the cause) ---';
    return Object.assign(
      new Error(stderrTail ? `${messageBase}\n${stderrHeading}\n${stderrTail}` : messageBase),
      {
        name: 'SpawnLockTimeoutError' as const,
        kind: 'spawn-lock-timeout' as const,
        pid,
        ...(exit !== null && { exitCode: exit.code, exitSignal: exit.signal }),
        ...(stderrTail !== undefined && { stderrTail }),
      },
    );
  }

  private async pollServerLock(
    lockDir: string,
    deadlineMs: number,
    child?: { pid: number },
    progressDeadlineMs?: number,
  ): Promise<{ lock: ServerLockMetadataLike | null; waitedDeadlineMs: number }> {
    const POLL_INTERVAL_MS = 50;
    const reader = this.deps.readServerLock;
    if (!reader) return { lock: null, waitedDeadlineMs: deadlineMs };
    const isAlive = this.deps.isProcessAlive;
    const started = Date.now();
    const hardCapMs = Math.max(
      deadlineMs,
      progressDeadlineMs ?? deadlineMs * SPAWN_WAIT_EXTENSION_FACTOR,
    );
    let effectiveDeadlineMs = deadlineMs;
    let deadline = started + deadlineMs;
    let extended = false;
    for (;;) {
      const lock = reader(lockDir);
      if (lock !== null && lock.draining !== true && lock.port > 0 && lock.kind !== undefined) {
        return { lock, waitedDeadlineMs: effectiveDeadlineMs };
      }
      if (child !== undefined && isAlive !== undefined && !isAlive(child.pid)) {
        const winnerStillStarting =
          lock !== null && lock.draining !== true && lock.pid !== child.pid && isAlive(lock.pid);
        if (!winnerStillStarting) return { lock: null, waitedDeadlineMs: effectiveDeadlineMs };
      }
      if (Date.now() >= deadline) {
        const childStarting = child !== undefined && isAlive?.(child.pid) === true;
        const holderStarting =
          lock !== null && lock.draining !== true && isAlive?.(lock.pid) === true;
        const stillStarting =
          !extended && hardCapMs > deadlineMs && (childStarting || holderStarting);
        if (!stillStarting) return { lock: null, waitedDeadlineMs: effectiveDeadlineMs };
        extended = true;
        effectiveDeadlineMs = hardCapMs;
        deadline = started + hardCapMs;
        this.deps.log?.info(
          {
            event: 'desktop-spawn-wait-extended',
            pid: child?.pid,
            lockDir,
            startupDeadlineMs: deadlineMs,
            hardCapMs,
            startingParty: childStarting ? 'child' : 'lock-holder',
            lockPublished: lock !== null,
          },
          '[window-manager] server still starting at the spawn deadline — extending the wait',
        );
      }
      await new Promise<void>((resolveSleep) => {
        this.deps.setTimeout(() => {
          resolveSleep();
        }, POLL_INTERVAL_MS);
      });
    }
  }

  private tryAttachExistingServer(lockDir: string): ServerLockMetadataLike | null {
    const read = this.deps.readServerLock;
    const alive = this.deps.isProcessAlive;
    const getHost = this.deps.hostname;
    if (!read || !alive || !getHost) return null;
    const lock = read(lockDir);
    if (!lock) return null;
    const refuse = (reason: string): null => {
      this.deps.log?.warn(
        { event: 'desktop-attach-refused', reason, lockDir, lockPid: lock.pid },
        '[window-manager] refusing attach',
      );
      return null;
    };
    if (!isValidLockPidLocal(lock.pid)) return refuse('invalid-lock-pid');
    if (lock.machineId === undefined && lock.hostname !== getHost()) {
      return refuse('foreign-hostname');
    }
    if (!alive(lock.pid)) return refuse('lock-pid-dead');
    if (lock.draining === true) return refuse('lock-draining');
    if (!lockIsAttachable(lock)) return refuse('lock-not-attachable');
    if (lock.kind === undefined) return refuse('legacy-lock-no-kind');
    if (lock.capabilities !== undefined && !lock.capabilities.includes('ws')) {
      return refuse('capabilities-missing-ws');
    }
    return lock;
  }

  private async probeForeignLockWithGrace(
    lock: { pid: number; port?: unknown; url?: unknown },
    phase: ProbePhase = 'spawn-foreign-lock',
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= FOREIGN_LOCK_PROBE_ATTEMPTS; attempt++) {
      if (await this.probeAttachableLock(lock, phase)) return true;
      if (attempt < FOREIGN_LOCK_PROBE_ATTEMPTS) {
        await new Promise<void>((resolveSleep) => {
          this.deps.setTimeout(() => resolveSleep(), FOREIGN_LOCK_PROBE_RETRY_MS);
        });
      }
    }
    return false;
  }

  private async probeAttachableLock(
    lock: { pid: number; port?: unknown; url?: unknown },
    phase: ProbePhase = 'attach',
  ): Promise<boolean> {
    const probe = this.deps.probeWsUpgrade;
    if (!probe) return true;
    const url = `${lockCollabUrl(lock)}/__attach_probe__`;
    let upgradeOk = false;
    try {
      upgradeOk = await probe(url, 500);
    } catch {
      upgradeOk = false;
    }
    if (!upgradeOk) {
      this.deps.log?.warn(
        {
          event: 'desktop-attach-refused',
          reason: 'ws-upgrade-failed',
          lockPid: lock.pid,
          phase,
        },
        '[window-manager] refusing attach',
      );
    }
    return upgradeOk;
  }

  private async attachToExistingServer(args: {
    projectPath: string;
    canonicalKey: string;
    projectName: string;
    lock: ServerLockMetadataLike;
    pendingDeepLinkTarget?: {
      kind: 'doc' | 'folder';
      path: string;
      repositoryPath?: string;
      contentRootDepth?: number;
    };
    pendingBranch?: string | null;
    pendingMultiCandidate?: boolean;
    pendingTargetMissing?: boolean;
    pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload;
    pendingServerRestartedToast?: boolean;
    freshlyCreated?: boolean;
  }): Promise<ProjectContext> {
    const {
      projectPath,
      canonicalKey,
      projectName,
      lock,
      pendingDeepLinkTarget,
      pendingBranch,
      pendingMultiCandidate,
      pendingTargetMissing,
      pendingShareBranchSwitch,
      pendingServerRestartedToast,
      freshlyCreated,
    } = args;
    const port = lock.port;
    const apiOrigin = lockApiOrigin(lock);

    this.deps.log?.info(
      {
        projectPath,
        holderPid: lock.pid,
        port,
        startedAt: lock.startedAt,
        apiOrigin,
        capabilities: lock.capabilities,
      },
      'attaching to existing OpenKnowledge server',
    );

    this.deps.startup?.markServerLockReady?.({ startedAt: lock.startedAt, apiOrigin });

    const window = this.deps.createWindow({
      additionalArguments: [
        `--ok-collab-url=${lockCollabUrl(lock)}`,
        `--ok-api-origin=${apiOrigin}`,
        `--ok-project-path=${projectPath}`,
        `--ok-project-name=${projectName}`,
        `--ok-mode=editor`,
        `--ok-app-version=${this.deps.appVersion}`,
        ...instanceLabelArgs(),
        ...(this.deps.startup?.traceparent !== undefined
          ? [`--ok-startup-traceparent=${this.deps.startup.traceparent}`]
          : []),
        ...(freshlyCreated ? ['--ok-fresh-create=1'] : []),
      ],
      title: formatEditorTitle(projectName),
      projectPath,
    });
    this.deps.startup?.markWindowCreated?.();
    this.attachSafetyNet(window.webContents, apiOrigin, projectPath);

    if (pendingDeepLinkTarget) {
      const doc = pendingDeepLinkTarget.path;
      const kind = pendingDeepLinkTarget.kind;
      const branch = pendingBranch ?? null;
      const multiCandidate = pendingMultiCandidate === true;
      registerPendingDelivery(window.webContents, 'ok:deep-link', {
        doc,
        kind,
        branch,
        multiCandidate,
        ...(pendingDeepLinkTarget.repositoryPath === undefined
          ? {}
          : { repositoryPath: pendingDeepLinkTarget.repositoryPath }),
        ...(pendingDeepLinkTarget.contentRootDepth === undefined
          ? {}
          : { contentRootDepth: pendingDeepLinkTarget.contentRootDepth }),
        ...(pendingTargetMissing === true ? { targetMissing: true } : {}),
      });
    }

    if (pendingShareBranchSwitch) {
      const branchSwitch = pendingShareBranchSwitch;
      registerPendingDelivery(window.webContents, 'ok:share:received', {
        kind: 'project-branch-switch' as const,
        share: branchSwitch.share,
        projectPath: branchSwitch.projectPath,
        currentBranch: branchSwitch.currentBranch,
      });
    }

    const selfProtocol = this.deps.selfProtocolVersion;
    const selfRuntime = this.deps.selfRuntimeVersion;
    const serverRuntime = lock.runtimeVersion;
    if (selfProtocol !== undefined && selfRuntime !== undefined) {
      const drift = classifyServerVersion(
        { protocolVersion: lock.protocolVersion, runtimeVersion: serverRuntime },
        { protocolVersion: selfProtocol, runtimeVersion: selfRuntime },
      );
      if (
        (drift.relation === 'older' || drift.relation === 'newer') &&
        serverRuntime !== undefined
      ) {
        const payload = {
          relation: drift.relation,
          dimension: drift.dimension ?? 'runtime',
          serverRuntime,
          appRuntime: selfRuntime,
        } as const;
        registerPendingDelivery(window.webContents, 'ok:server-version-drift', payload);
      }
    }

    if (pendingServerRestartedToast && selfRuntime !== undefined) {
      registerPendingDelivery(
        window.webContents,
        'ok:server-restarted',
        { appRuntime: selfRuntime },
        { event: 'did-finish-load' },
      );
    }

    const disposeShowGate = this.deps.showGate.register(window, { kind: 'editor' });

    const context: ProjectContext = {
      projectPath,
      canonicalKey,
      projectName,
      port,
      apiOrigin,
      window,
      utility: null,
      ownsServer: false,
    };
    const releaseLoadingContext = this.publishLoadingContext(context);
    try {
      if (this.deps.rendererDevUrl) {
        await window.loadURL(this.deps.rendererDevUrl);
      } else {
        await window.loadFile(this.deps.rendererEntryPath);
      }
      this.deps.startup?.markLoadUrlResolved?.();

      if (this.deps.createKeepalive) {
        const existingKeepalive = this.keepalives.get(canonicalKey);
        if (existingKeepalive) existingKeepalive.close();
        const lockDir = getLocalDir(projectPath);
        const handle = this.deps.createKeepalive({ lockDir });
        this.keepalives.set(canonicalKey, handle);
      }

      window.on('closed', () => {
        disposeShowGate();
        if (this.windowsByPath.get(canonicalKey) !== context) return;
        const keepalive = this.keepalives.get(canonicalKey);
        if (keepalive) {
          keepalive.close();
          this.keepalives.delete(canonicalKey);
        }
        this.windowsByPath.delete(canonicalKey);
      });

      this.windowsByPath.set(canonicalKey, context);
    } finally {
      releaseLoadingContext();
    }
    return context;
  }
}
