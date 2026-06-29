import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DEFAULT_SIGTERM_GRACE_MS,
  DEFAULT_SIGTERM_POLL_MS,
  SPAWN_ERROR_LOG,
} from '@inkeep/open-knowledge-core';
import type { KeepaliveHandle } from '@inkeep/open-knowledge-core/keepalive';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import type { OkServerRestartOutcome } from '../shared/bridge-contract.ts';
import { registerPendingDelivery } from '../shared/ipc-send.ts';
import type { ShowGateRegistry } from './show-gate.ts';
import type { ShareDeepLinkBranchSwitchPayload } from './url-scheme.ts';
import { classifyServerVersion } from './version-drift.ts';

const RESTART_SIGTERM_GRACE_MS = 3_000;

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

function formatEditorTitle(projectName: string): string {
  const suffix = windowInstanceLabel ? ` (${windowInstanceLabel})` : '';
  return `${projectName} — OpenKnowledge${suffix}`;
}

export interface BrowserWindowLike {
  focus(): void;
  show?(): void;
  restore?(): void;
  isMinimized?(): boolean;
  isDestroyed?(): boolean;
  isVisible?(): boolean;
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
      event: 'will-navigate',
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
  startedAt: string;
  worktreeRoot: string;
  kind?: 'interactive' | 'mcp-spawned';
  capabilities?: string[];
  protocolVersion?: number;
  runtimeVersion?: string;
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

interface CreateProjectWindowOpts {
  projectPath: string;
  pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
  pendingBranch?: string | null;
  pendingMultiCandidate?: boolean;
  pendingTargetMissing?: boolean;
  pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload;
  didEnsureGit?: boolean;
  consentVersion?: number;
  localOpCliArgs?: string[];
  pendingServerRestartedToast?: boolean;
}

export interface WindowManagerDeps {
  createWindow(opts: { additionalArguments: string[]; title: string }): BrowserWindowLike;
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
  }>;
  createEphemeralProjectDir?(contentDir: string): string;
  removeDir?(dir: string): Promise<void>;
  spawnLockPollDeadlineMs?: number;
  sigtermGraceMs?: number;
  createKeepalive?(opts: { lockDir: string }): KeepaliveHandle;
  rendererEntryPath: string;
  /** electron-vite dev-server URL (`process.env.ELECTRON_RENDERER_URL`). When present,
   *  main uses `loadURL` for HMR; otherwise falls back to `loadFile(rendererEntryPath)`. */
  rendererDevUrl?: string | null;
  appVersion: string;
  selfProtocolVersion?: number;
  selfRuntimeVersion?: string;
  reclaimForeignServerInDev?: boolean;
  setTimeout(cb: () => void, ms: number): unknown;
  killProbe(pid: number, signal: number | NodeJS.Signals): void;
  showGate: ShowGateRegistry;
  runClean?(opts: { lockDir: string }): Promise<void>;
  realpathSync?(p: string): string;
  readServerLock?(lockDir: string): ServerLockMetadataLike | null;
  isProcessAlive?(pid: number): boolean;
  hostname?(): string;
  probeWsUpgrade?(url: string, timeoutMs: number): Promise<boolean>;
  utilityInitTimeoutMs?: number;
  log?: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
  onUtilityMessage?(msg: unknown): void;
  onUtilityExit?(utility: UtilityProcessLike): void;
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
          err: (err as Error).message,
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
        { err: (err as Error).message, projectPath: ctx.projectPath },
        'utility SIGKILL failed during owned-server teardown',
      );
    }
  }
}

export class WindowManager {
  private readonly windowsByPath = new Map<string, ProjectContext>();

  private readonly spawnedDetachedPids = new Map<string, number>();

  private readonly ephemeralPendingByPath = new Map<string, Promise<ProjectContext>>();

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

  focusWindowForProject(projectPath: string): BrowserWindowLike | null {
    const ctx = this.windowsByPath.get(this.canonicalizeKey(projectPath));
    if (!ctx) return null;
    const win = ctx.window;
    if (win.isMinimized?.()) win.restore?.();
    win.show?.();
    win.focus();
    return win;
  }

  getContextForBrowserWindow(win: BrowserWindowLike): ProjectContext | undefined {
    for (const ctx of this.windowsByPath.values()) {
      if (ctx.window === win) return ctx;
    }
    return undefined;
  }

  getOpenProjectPaths(): string[] {
    const paths: string[] = [];
    for (const ctx of this.windowsByPath.values()) {
      if (ctx.window.isDestroyed?.() === true) continue;
      paths.push(ctx.projectPath);
    }
    return paths;
  }

  windowCount(): number {
    return this.windowsByPath.size;
  }

  async stopAllOwnedServers(): Promise<void> {
    signalStopOwnedUtilityForks(this.windowsByPath.values(), this.deps.log);

    const readLock = this.deps.readServerLock;
    const stopOne = async (canonicalKey: string, pid: number): Promise<void> => {
      const projectPath = canonicalKey;
      const lockDir = getLocalDir(projectPath);
      try {
        this.deps.killProbe(pid, 'SIGTERM');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          return;
        }
        this.deps.log?.warn(
          { err: (err as Error).message, pid, projectPath },
          'SIGTERM failed during stopAllOwnedServers',
        );
      }
      if (readLock) {
        const graceMs = this.deps.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          const lock = readLock(lockDir);
          if (lock === null || lock.pid !== pid) {
            return;
          }
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
            err: (err as Error).message,
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

  private async terminateServerByPid(
    lockDir: string,
    pid: number,
  ): Promise<{ ok: true; escalated: boolean } | { ok: false; reason: 'eperm' | 'other' }> {
    const readLock = this.deps.readServerLock;
    try {
      this.deps.killProbe(pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { ok: true, escalated: false };
      return { ok: false, reason: code === 'EPERM' ? 'eperm' : 'other' };
    }
    if (readLock) {
      const graceMs = this.deps.sigtermGraceMs ?? RESTART_SIGTERM_GRACE_MS;
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        const lock = readLock(lockDir);
        if (lock === null || lock.pid !== pid) return { ok: true, escalated: false };
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
    const originating = this.windowsByPath.get(canonicalKey);
    if (originating) this.windowsByPath.delete(canonicalKey);
    try {
      await this.createProjectWindow({
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
    if (originating) await this.closeAndAwait(originating.window);
    return { ok: true };
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

  async createProjectWindow(opts: CreateProjectWindowOpts): Promise<ProjectContext> {
    const projectPath = resolve(opts.projectPath);
    const canonicalKey = this.canonicalizeKey(projectPath);
    const existing = this.windowsByPath.get(canonicalKey);
    if (existing) {
      if (existing.window.isDestroyed?.() !== true) {
        existing.window.focus();
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
    let pendingServerReclaimedToast = false;
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
        });
      }
      pendingServerReclaimedToast = true;
    }

    if (this.deps.runClean) {
      try {
        await this.deps.runClean({ lockDir });
      } catch (err) {
        this.deps.log?.warn(
          { err: (err as Error).message, lockDir },
          'runClean failed; proceeding to spawn server',
        );
      }
    }

    if (this.deps.spawnDetachedServer) {
      const reactShellDistDir = dirname(this.deps.rendererEntryPath);
      const handle = await this.deps.spawnDetachedServer({
        contentDir: projectPath,
        reactShellDistDir,
      });
      this.spawnedDetachedPids.set(canonicalKey, handle.pid);
      const POLL_DEADLINE_MS = this.deps.spawnLockPollDeadlineMs ?? 15_000;
      const lock = await this.pollServerLock(lockDir, POLL_DEADLINE_MS);
      if (lock === null) {
        try {
          this.deps.killProbe(handle.pid, 'SIGTERM');
        } catch (signalErr) {
          const code = (signalErr as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            this.deps.log?.warn(
              {
                event: 'desktop-spawn-orphan-sigterm-failed',
                err: (signalErr as Error).message,
                code,
                pid: handle.pid,
                projectPath,
              },
              '[window-manager] SIGTERM on orphan after spawn-lock-timeout failed',
            );
          }
        }
        this.spawnedDetachedPids.delete(canonicalKey);
        const STDERR_TAIL_BYTES = 8192;
        let stderrTail: string | undefined;
        try {
          const raw = readFileSync(join(lockDir, SPAWN_ERROR_LOG), 'utf-8');
          stderrTail = raw.length > STDERR_TAIL_BYTES ? `…${raw.slice(-STDERR_TAIL_BYTES)}` : raw;
        } catch {}
        const messageBase = `OpenKnowledge server did not bind a port within ${POLL_DEADLINE_MS}ms after spawn (pid=${handle.pid}).`;
        const err = Object.assign(
          new Error(stderrTail ? `${messageBase}\n--- stderr ---\n${stderrTail}` : messageBase),
          {
            name: 'SpawnLockTimeoutError' as const,
            kind: 'spawn-lock-timeout' as const,
            pid: handle.pid,
            ...(stderrTail !== undefined && { stderrTail }),
          },
        );
        throw err;
      }
      this.deps.log?.info(
        { event: 'desktop-server-spawned-detached', pid: handle.pid, port: lock.port, lockDir },
        '[window-manager] detached server ready',
      );
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
        host: 'localhost',
        didEnsureGit: opts.didEnsureGit === true,
        consentVersion: opts.consentVersion ?? 1,
        ...(reactShellDistDir !== null ? { reactShellDistDir } : {}),
        ...(opts.localOpCliArgs ? { localOpCliArgs: opts.localOpCliArgs } : {}),
      },
    });

    const { port, apiOrigin } = await ready;

    if (this.deps.onUtilityMessage) {
      const onMessage = this.deps.onUtilityMessage;
      utility.on('message', (msg) => onMessage(msg));
    }

    utility.on('exit', (code) => {
      this.deps.log?.info({ pid: utility.pid, code }, 'utility exited');
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
    ];
    const window = this.deps.createWindow({
      additionalArguments,
      title: formatEditorTitle(projectName),
    });

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

    if (pendingServerReclaimedToast) {
      registerPendingDelivery(
        window.webContents,
        'ok:server-reclaimed',
        { appRuntime: this.deps.appVersion },
        { event: 'did-finish-load' },
      );
    }

    const disposeShowGate = this.deps.showGate.register(window, { kind: 'editor' });

    if (this.deps.rendererDevUrl) {
      await window.loadURL(this.deps.rendererDevUrl);
    } else {
      await window.loadFile(this.deps.rendererEntryPath);
    }

    window.on('closed', () => {
      disposeShowGate();
      try {
        utility.postMessage({ type: 'shutdown' });
      } catch (err) {
        this.deps.log?.warn(
          { err: (err as Error).message, projectPath },
          'utility shutdown IPC failed on window close (likely already exited)',
        );
      }
    });

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
    this.windowsByPath.set(canonicalKey, context);
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
      if (existing.window.isDestroyed?.() !== true) {
        existing.window.focus();
        return existing;
      }
      this.deps.log?.warn(
        { canonicalKey },
        '[window-manager] stale destroyed ephemeral entry — clearing and re-creating',
      );
      this.windowsByPath.delete(canonicalKey);
    }

    const inFlight = this.ephemeralPendingByPath.get(canonicalKey);
    if (inFlight) {
      const ctx = await inFlight;
      if (ctx.window.isDestroyed?.() !== true) {
        ctx.window.focus();
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
    let handle: { pid: number };
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

    const POLL_DEADLINE_MS = this.deps.spawnLockPollDeadlineMs ?? 15_000;
    const lock = await this.pollServerLock(lockDir, POLL_DEADLINE_MS);
    if (lock === null) {
      try {
        this.deps.killProbe(handle.pid, 'SIGTERM');
      } catch (signalErr) {
        const code = (signalErr as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          this.deps.log?.warn(
            {
              event: 'desktop-ephemeral-spawn-orphan-sigterm-failed',
              err: (signalErr as Error).message,
              code,
              pid: handle.pid,
            },
            '[window-manager] SIGTERM on ephemeral orphan after spawn-lock-timeout failed',
          );
        }
      }
      await removeDir(tempProjectDir).catch(() => {});
      const STDERR_TAIL_BYTES = 8192;
      let stderrTail: string | undefined;
      try {
        const raw = readFileSync(join(lockDir, SPAWN_ERROR_LOG), 'utf-8');
        stderrTail = raw.length > STDERR_TAIL_BYTES ? `…${raw.slice(-STDERR_TAIL_BYTES)}` : raw;
      } catch {}
      const messageBase = `OpenKnowledge server did not bind a port within ${POLL_DEADLINE_MS}ms after ephemeral spawn (pid=${handle.pid}).`;
      throw Object.assign(
        new Error(stderrTail ? `${messageBase}\n--- stderr ---\n${stderrTail}` : messageBase),
        {
          name: 'SpawnLockTimeoutError' as const,
          kind: 'spawn-lock-timeout' as const,
          pid: handle.pid,
          ...(stderrTail !== undefined && { stderrTail }),
        },
      );
    }

    const port = lock.port;
    const apiOrigin = `http://localhost:${port}`;
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
        `--ok-collab-url=ws://localhost:${port}/collab`,
        `--ok-api-origin=${apiOrigin}`,
        `--ok-project-path=${opts.contentDir}`,
        `--ok-project-name=${projectName}`,
        `--ok-mode=editor`,
        `--ok-single-file=1`,
        `--ok-initial-doc=${opts.docName}`,
        `--ok-app-version=${this.deps.appVersion}`,
      ],
      title: formatEditorTitle(projectName),
    });

    const disposeShowGate = this.deps.showGate.register(window, { kind: 'editor' });

    try {
      if (this.deps.rendererDevUrl) {
        await window.loadURL(this.deps.rendererDevUrl);
      } else {
        await window.loadFile(this.deps.rendererEntryPath);
      }
    } catch (err) {
      disposeShowGate();
      window.destroy?.();
      await this.teardownEphemeralSession({
        projectDir: tempProjectDir,
        pid: handle.pid,
        lockDir,
      });
      throw err;
    }

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

    window.on('closed', () => {
      disposeShowGate();
      if (this.windowsByPath.get(canonicalKey) !== context) return;
      this.windowsByPath.delete(canonicalKey);
      void this.teardownEphemeralSession(
        context.ephemeral as NonNullable<ProjectContext['ephemeral']>,
      );
    });

    this.windowsByPath.set(canonicalKey, context);
    return context;
  }

  private async teardownEphemeralSession(session: {
    projectDir: string;
    pid: number;
    lockDir: string;
  }): Promise<void> {
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
          err: err instanceof Error ? err.message : String(err),
          projectDir: session.projectDir,
        },
        '[window-manager] failed to remove ephemeral temp dir',
      );
    });
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
        { err: (err as Error).message, projectPath },
        'utility shutdown IPC failed in closeProjectWindow (likely already exited)',
      );
    }
    return true;
  }

  private async pollServerLock(
    lockDir: string,
    deadlineMs: number,
  ): Promise<ServerLockMetadataLike | null> {
    const POLL_INTERVAL_MS = 50;
    const reader = this.deps.readServerLock;
    if (!reader) return null;
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const lock = reader(lockDir);
      if (lock !== null && lock.port > 0 && lock.kind !== undefined) {
        return lock;
      }
      await new Promise<void>((resolveSleep) => {
        this.deps.setTimeout(() => {
          resolveSleep();
        }, POLL_INTERVAL_MS);
      });
    }
    return null;
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
    if (lock.hostname !== getHost()) return refuse('foreign-hostname');
    if (!alive(lock.pid)) return refuse('lock-pid-dead');
    if (lock.port <= 0) return refuse('lock-port-zero');
    if (lock.kind === undefined) return refuse('legacy-lock-no-kind');
    if (lock.capabilities !== undefined && !lock.capabilities.includes('ws')) {
      return refuse('capabilities-missing-ws');
    }
    return lock;
  }

  private async probeAttachableLock(lock: ServerLockMetadataLike): Promise<boolean> {
    const probe = this.deps.probeWsUpgrade;
    if (!probe) return true;
    const url = `ws://localhost:${lock.port}/collab/__attach_probe__`;
    let upgradeOk = false;
    try {
      upgradeOk = await probe(url, 500);
    } catch {
      upgradeOk = false;
    }
    if (!upgradeOk) {
      this.deps.log?.warn(
        { event: 'desktop-attach-refused', reason: 'ws-upgrade-failed', lockPid: lock.pid },
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
    pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
    pendingBranch?: string | null;
    pendingMultiCandidate?: boolean;
    pendingTargetMissing?: boolean;
    pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload;
    pendingServerRestartedToast?: boolean;
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
    } = args;
    const port = lock.port;
    const apiOrigin = `http://localhost:${port}`;

    this.deps.log?.info(
      { projectPath, holderPid: lock.pid, port, startedAt: lock.startedAt },
      'attaching to existing OpenKnowledge server',
    );

    const window = this.deps.createWindow({
      additionalArguments: [
        `--ok-collab-url=ws://localhost:${port}/collab`,
        `--ok-api-origin=${apiOrigin}`,
        `--ok-project-path=${projectPath}`,
        `--ok-project-name=${projectName}`,
        `--ok-mode=editor`,
        `--ok-app-version=${this.deps.appVersion}`,
      ],
      title: formatEditorTitle(projectName),
    });

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

    if (this.deps.rendererDevUrl) {
      await window.loadURL(this.deps.rendererDevUrl);
    } else {
      await window.loadFile(this.deps.rendererEntryPath);
    }

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
    this.windowsByPath.set(canonicalKey, context);
    return context;
  }
}
