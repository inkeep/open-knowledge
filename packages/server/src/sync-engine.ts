
import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { resolveGitDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { CC1Broadcaster } from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import { ConflictStore } from './conflict-storage.ts';
import type { ContentFilter } from './content-filter.ts';
import { isSupportedDocFile } from './doc-extensions.ts';
import {
  type ClassifiedError,
  classifyGitError,
  type UserFacingErrorCode,
} from './error-classification.ts';
import { createGhTokenSource, type GhTokenSource } from './gh-token-source.ts';
import { applyGitEnv, createGitInstance, type GitHandle, withParentLock } from './git-handle.ts';
import { resolveGitIdentity } from './git-identity.ts';
import {
  type CheckPushPermissionOptions,
  type DetectGhFn,
  checkPushPermission as defaultCheckPushPermission,
  type ProbeTokenStore,
  type PushPermission,
} from './github-permissions.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';
import {
  readOriginGitHubRepo,
  readSyncRemoteInfo,
  type SyncRemoteInfo,
} from './share/git-context.ts';
import { computeRemainingMs } from './sync-timing.ts';

const log = getLogger('sync-engine');

const SHA_HEX_40 = /^[0-9a-f]{40}$/i;

const SYNC_GH_TOKEN_HOST = 'github.com';


export type SyncState =
  | 'dormant'
  | 'idle'
  | 'fetching'
  | 'pulling'
  | 'pushing'
  | 'conflict'
  | 'offline'
  | 'auth-error'
  | 'disabled';

export type PushPermissionStatus =
  | { checkStatus: 'allowed' }
  | {
      checkStatus: 'denied';
      deniedReason: 'no-collaborator' | 'private-no-access' | 'repo-not-found';
    }
  | {
      checkStatus: 'unknown';
      unknownError?: 'network' | 'timeout' | 'rate-limit' | 'token-invalid' | 'malformed-response';
    };

function pushPermissionStatusFrom(p: PushPermission): PushPermissionStatus {
  if (p.kind === 'allowed') return { checkStatus: 'allowed' };
  if (p.kind === 'denied') return { checkStatus: 'denied', deniedReason: p.reason };
  return { checkStatus: 'unknown', unknownError: p.error };
}

function pushPermissionStatusEqual(
  a: PushPermissionStatus | null,
  b: PushPermissionStatus | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.checkStatus !== b.checkStatus) return false;
  if (a.checkStatus === 'denied' && b.checkStatus === 'denied') {
    return a.deniedReason === b.deniedReason;
  }
  if (a.checkStatus === 'unknown' && b.checkStatus === 'unknown') {
    return a.unknownError === b.unknownError;
  }
  return true;
}

interface SyncStatus {
  state: SyncState;
  lastSyncUtc: string | null;
  lastFetchUtc: string | null;
  lastPushedSha: string | null;
  ahead: number;
  behind: number;
  consecutiveFailures: number;
  conflictCount: number;
  hasRemote: boolean;
  syncEnabled: boolean;
  identityUnresolved: boolean;
  remote: SyncRemoteInfo | null;
  pushError?: string;
  pushErrorCode?: UserFacingErrorCode;
  pullError?: string;
  pullErrorCode?: UserFacingErrorCode;
  pausedReason?: string;
  pushPermission?: PushPermissionStatus;
}

interface ContentFileEntry {
  contentRelPath: string;
  projectRelPath: string;
}

interface PersistedSyncState {
  version: 1;
  lastSyncUtc: string | null;
  lastFetchUtc: string | null;
  lastPushedSha: string | null;
  consecutiveFailures: number;
  pausedReason?: string;
  pausedSinceUtc?: string;
  inflightConflicts: string[];
}

interface SyncEngineOptions {
  projectDir: string;
  contentDir: string;
  contentFilter: ContentFilter;
  contentRoot?: string;
  pullIntervalSeconds?: number;
  pushIntervalSeconds?: number;
  syncEnabled?: boolean;
  credentialArgs?: string[];
  cc1Broadcaster?: CC1Broadcaster | null;
  onStateChange?: (state: SyncState) => void;
  onContentConflictsDetected?: (files: string[]) => void | Promise<void>;
  /** Callback to gate batch-in-progress during merge operations.
   *  Prevents HEAD watcher from firing reconciliation mid-merge. */
  setBatchInProgress?: (value: boolean) => void;
  onAutoDisable?: (reason: 'protected-branch') => void | Promise<void>;
  detectGh?: DetectGhFn;
  tokenStore?: ProbeTokenStore | null;
  checkPushPermissionFn?: (opts: CheckPushPermissionOptions) => Promise<PushPermission>;
}


function jitteredMs(seconds: number): number {
  const base = seconds * 1000;
  const jitter = base * 0.15 * (2 * Math.random() - 1); // ±15%
  return Math.round(base + jitter);
}


function isUnbornHead(projectDir: string): boolean {
  try {
    const headPath = join(projectDir, '.git', 'HEAD');
    if (!existsSync(headPath)) return false;
    const headContent = readFileSync(headPath, 'utf-8').trim();
    const match = /^ref:\s+(refs\/.+)$/.exec(headContent);
    if (!match) return false;
    const refName = match[1] as string;
    if (existsSync(join(projectDir, '.git', refName))) return false;
    const packedRefsPath = join(projectDir, '.git', 'packed-refs');
    if (existsSync(packedRefsPath)) {
      const packed = readFileSync(packedRefsPath, 'utf-8');
      if (new RegExp(`^[0-9a-f]+\\s+${refName}$`, 'm').test(packed)) return false;
    }
    return true;
  } catch {
    return false;
  }
}


function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures >= 8) return 60 * 60 * 1000; // 60 min
  if (consecutiveFailures >= 5) return 15 * 60 * 1000; // 15 min
  if (consecutiveFailures >= 3) return 5 * 60 * 1000; // 5 min
  return 0; // use normal interval
}


export class SyncEngine {
  private state: SyncState = 'dormant';
  private projectDir: string;
  private contentDir: string;
  private contentFilter: ContentFilter;
  private contentRoot: string;
  private pullIntervalSeconds: number;
  private pushIntervalSeconds: number;
  private syncEnabled: boolean | undefined;
  private credentialArgs: string[];
  private cc1Broadcaster: CC1Broadcaster | null;
  private onStateChange: ((state: SyncState) => void) | undefined;
  private onContentConflictsDetected: ((files: string[]) => void | Promise<void>) | undefined;
  private setBatchInProgress: ((value: boolean) => void) | undefined;
  private onAutoDisable: ((reason: 'protected-branch') => void | Promise<void>) | undefined;
  private detectGh: DetectGhFn | undefined;
  private ghTokenSource: GhTokenSource;
  private tokenStore: ProbeTokenStore | null | undefined;
  private checkPushPermissionFn: (opts: CheckPushPermissionOptions) => Promise<PushPermission>;
  private pushPermission: PushPermissionStatus | null = null;
  private pushPermissionProbeInFlight = false;

  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private stateSaveTimer: ReturnType<typeof setTimeout> | null = null;

  private lastSyncUtc: string | null = null;
  private lastFetchUtc: string | null = null;
  private lastPushedSha: string | null = null;
  private consecutiveFailures = 0;
  private ahead = 0;
  private behind = 0;
  private conflictCount = 0;
  private pushError: string | undefined;
  private pushErrorCode: UserFacingErrorCode | undefined;
  private pullError: string | undefined;
  private pullErrorCode: UserFacingErrorCode | undefined;
  private pausedReason: string | undefined;
  private currentBranch = 'main';

  private pullInFlight = false;
  private pushInFlight = false;

  private hasRemote = false;

  private identityUnresolved = false;

  private statePath: string;
  private conflictStore: ConflictStore;

  constructor(options: SyncEngineOptions) {
    this.projectDir = options.projectDir;
    this.contentDir = options.contentDir;
    this.contentFilter = options.contentFilter;
    this.contentRoot = options.contentRoot ?? '';
    this.pullIntervalSeconds = options.pullIntervalSeconds ?? 30;
    this.pushIntervalSeconds = options.pushIntervalSeconds ?? 60;
    this.syncEnabled = options.syncEnabled;
    this.credentialArgs = options.credentialArgs ?? [];
    this.cc1Broadcaster = options.cc1Broadcaster ?? null;
    this.onStateChange = options.onStateChange;
    this.onContentConflictsDetected = options.onContentConflictsDetected;
    this.setBatchInProgress = options.setBatchInProgress;
    this.onAutoDisable = options.onAutoDisable;
    this.detectGh = options.detectGh;
    this.ghTokenSource = createGhTokenSource(options.detectGh);
    this.tokenStore = options.tokenStore;
    this.checkPushPermissionFn = options.checkPushPermissionFn ?? defaultCheckPushPermission;
    this.statePath = resolve(getLocalDir(this.projectDir), 'sync-state.json');
    this.conflictStore = new ConflictStore(this.projectDir, this.currentBranch);
  }

  private gitHandle(gitIndexFile?: string): GitHandle {
    return createGitInstance(this.projectDir, {
      credentialArgs: this.credentialArgs,
      gitIndexFile,
      ghToken: this.ghTokenSource.get(SYNC_GH_TOKEN_HOST) ?? undefined,
    });
  }


  async start(): Promise<void> {
    if (this.state !== 'dormant') return;

    this.loadState();

    let hasRemote = false;
    try {
      const handle = this.gitHandle();
      const remoteOutput = await handle.git.raw('remote', '-v');
      hasRemote = remoteOutput.trim().length > 0;
      this.hasRemote = hasRemote;

      try {
        const b = (await handle.git.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
        if (b && b !== 'HEAD') {
          this.currentBranch = b;
          this.conflictStore.setBranch(b);
        }
      } catch {
      }
    } catch (e) {
      log.warn({ err: e }, '[sync] remote detection failed');
    }

    if (hasRemote) {
      void this.probePushPermissionInternal('start');
    }

    if (this.syncEnabled !== true) {
      if (hasRemote) this.transitionTo('disabled');
      log.info(
        { hasRemote, syncEnabled: this.syncEnabled },
        '[sync] sync not enabled — staying inactive',
      );
      return;
    }

    if (!hasRemote) {
      log.info({}, '[sync] no remote detected — staying dormant');
      return;
    }

    this.transitionTo('idle');

    const gitDir = resolveGitDir(this.projectDir);
    const mergeHeadPath = gitDir ? join(gitDir, 'MERGE_HEAD') : null;
    const mergeInProgress = mergeHeadPath !== null && existsSync(mergeHeadPath);

    if (this.conflictCount > 0 && !mergeInProgress) {
      log.warn(
        { count: this.conflictCount },
        '[sync] persisted conflicts but no MERGE_HEAD — clearing stale state',
      );
      this.conflictStore.clear();
      this.conflictCount = 0;
    } else if (this.conflictCount > 0 && mergeInProgress) {
      try {
        const handle = this.gitHandle();
        const out = (await handle.git.raw(['diff', '--name-only', '--diff-filter=U'])).trim();
        const stillUnmerged = new Set(
          out
            ? out
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        );
        const before = this.conflictCount;
        for (const entry of this.conflictStore.list()) {
          if (!stillUnmerged.has(entry.file)) {
            this.conflictStore.removeConflict(entry.file);
          }
        }
        this.conflictCount = this.conflictStore.count();
        if (this.conflictCount < before) {
          log.info(
            { cleared: before - this.conflictCount, remaining: this.conflictCount },
            '[sync] reconciled conflicts.json against git unmerged index',
          );
        }
      } catch (e) {
        log.warn({ err: e }, '[sync] failed to reconcile conflicts with git index');
      }
    }

    if (mergeInProgress && this.conflictCount === 0) {
      log.warn({}, '[sync] stale MERGE_HEAD detected with no tracked conflicts — aborting merge');
      try {
        const handle = this.gitHandle();
        await handle.git.raw(['merge', '--abort']);
      } catch (e) {
        log.warn({ err: e }, '[sync] git merge --abort for stale MERGE_HEAD failed');
      }
    }

    if (this.conflictCount > 0) {
      await this.notifyContentConflictsDetected(
        this.conflictStore.list().map((entry) => entry.file),
      );
      this.transitionTo('conflict');
      log.warn(
        { count: this.conflictCount },
        '[sync] restarted with active conflicts — sync paused',
      );
      return;
    }

    const pullRemainingMs = computeRemainingMs(this.lastFetchUtc, this.pullIntervalSeconds);
    const pushRemainingMs = computeRemainingMs(this.lastSyncUtc, this.pushIntervalSeconds);
    this.schedulePull(pullRemainingMs > 0 ? pullRemainingMs : undefined);
    this.schedulePush(pushRemainingMs > 0 ? pushRemainingMs : undefined);
    log.info(
      { branch: this.currentBranch, pullDelayMs: pullRemainingMs, pushDelayMs: pushRemainingMs },
      '[sync] started',
    );
  }

  stop(): void {
    if (this.pullTimer !== null) {
      clearTimeout(this.pullTimer);
      this.pullTimer = null;
    }
    if (this.pushTimer !== null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.stateSaveTimer !== null) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = null;
    }
    if (this.state !== 'dormant') {
      this.transitionTo('dormant');
    }
  }

  async destroy(): Promise<void> {
    this.stop();
    this.saveStateNow();
  }


  async setEnabled(enabled: boolean): Promise<void> {
    if (this.syncEnabled === enabled) return;
    this.syncEnabled = enabled;

    if (!enabled) {
      if (this.pullTimer !== null) {
        clearTimeout(this.pullTimer);
        this.pullTimer = null;
      }
      if (this.pushTimer !== null) {
        clearTimeout(this.pushTimer);
        this.pushTimer = null;
      }
      const DRAIN_TIMEOUT_MS = 30_000;
      const drainStartMs = Date.now();
      while (this.pullInFlight || this.pushInFlight) {
        if (Date.now() - drainStartMs > DRAIN_TIMEOUT_MS) {
          log.warn(
            { pullInFlight: this.pullInFlight, pushInFlight: this.pushInFlight },
            '[sync] setEnabled(false): timed out waiting for in-flight cycle to drain',
          );
          break;
        }
        await wait(50);
      }
      this.pausedReason = undefined;
      this.clearPushError();
      this.clearPullError();
      this.transitionTo(this.hasRemote ? 'disabled' : 'dormant');
      this.saveStateNow();
      return;
    }

    this.hasRemote = await this.probeRemote();

    this.pausedReason = undefined;
    this.clearPushError();
    this.clearPullError();
    this.consecutiveFailures = 0;

    if (!this.hasRemote) {
      this.transitionTo('dormant');
      this.saveStateNow();
      return;
    }

    this.transitionTo('idle');
    this.schedulePull(0);
    this.schedulePush();
    this.saveStateNow();
    void this.probePushPermissionInternal('refresh');
  }


  async notifyCredentialsChanged(): Promise<void> {
    if (!this.syncEnabled) return;

    this.ghTokenSource.invalidate();

    if (this.state !== 'auth-error' && this.pausedReason !== 'auth-error') return;

    this.pausedReason = undefined;
    this.clearPushError();
    this.clearPullError();
    this.consecutiveFailures = 0;

    this.hasRemote = await this.probeRemote();
    if (!this.hasRemote) {
      this.transitionTo('dormant');
      this.saveStateNow();
      return;
    }

    this.transitionTo('idle');
    this.schedulePull(0);
    this.schedulePush();
    this.saveStateNow();
    void this.probePushPermissionInternal('refresh');
  }


  async trigger(op: 'sync' | 'push' | 'pull' = 'sync'): Promise<void> {
    this.consecutiveFailures = 0;
    if (
      this.pausedReason === 'dirty-tree' ||
      this.pausedReason === 'external-changes-pending' ||
      this.pausedReason === 'non-content-merge-failure'
    ) {
      this.pausedReason = undefined;
      this.clearPullError();
    }
    void this.probePushPermissionInternal('refresh');
    if (
      this.state === 'dormant' ||
      this.state === 'disabled' ||
      this.state === 'conflict' ||
      this.state === 'auth-error'
    ) {
      log.warn(
        {
          op,
          state: this.state,
          syncEnabled: this.syncEnabled,
          hasRemote: this.hasRemote,
          pausedReason: this.pausedReason,
          conflictCount: this.conflictCount,
        },
        `[sync] trigger(${op}) ignored — state=${this.state}`,
      );
    } else {
      log.info({ op, state: this.state }, `[sync] trigger(${op}) running`);
    }
    if (op === 'push') {
      await this.runPushCycle();
    } else if (op === 'pull') {
      await this.runPullCycle();
    } else {
      await this.runPushCycle();
      await this.runPullCycle();
    }
  }


  getStatus(): SyncStatus {
    return {
      state: this.state,
      lastSyncUtc: this.lastSyncUtc,
      lastFetchUtc: this.lastFetchUtc,
      lastPushedSha: this.lastPushedSha,
      ahead: this.ahead,
      behind: this.behind,
      consecutiveFailures: this.consecutiveFailures,
      conflictCount: this.conflictCount,
      hasRemote: this.hasRemote,
      syncEnabled: this.syncEnabled === true,
      identityUnresolved: this.identityUnresolved,
      remote: this.hasRemote ? readSyncRemoteInfo(this.projectDir) : null,
      ...(this.pushError !== undefined ? { pushError: this.pushError } : {}),
      ...(this.pushErrorCode !== undefined ? { pushErrorCode: this.pushErrorCode } : {}),
      ...(this.pullError !== undefined ? { pullError: this.pullError } : {}),
      ...(this.pullErrorCode !== undefined ? { pullErrorCode: this.pullErrorCode } : {}),
      pausedReason: this.pausedReason,
      ...(this.pushPermission !== null ? { pushPermission: this.pushPermission } : {}),
    };
  }

  async refreshPushPermission(): Promise<PushPermissionStatus | null> {
    return this.probePushPermissionInternal('refresh');
  }

  async refreshIdentity(): Promise<void> {
    const identity = await resolveGitIdentity(this.projectDir);
    const next = identity === null;
    if (this.identityUnresolved !== next) {
      this.identityUnresolved = next;
      this.cc1Broadcaster?.signal('sync-status');
    }
  }

  private async probePushPermissionInternal(
    caller: 'start' | 'refresh',
  ): Promise<PushPermissionStatus | null> {
    if (!this.hasRemote) return null;
    if (this.pushPermissionProbeInFlight) return null;

    const origin = readOriginGitHubRepo(this.projectDir);
    if (origin.kind !== 'ok') {
      const next: PushPermissionStatus = { checkStatus: 'unknown' };
      const prev = this.pushPermission;
      this.pushPermission = next;
      if (!pushPermissionStatusEqual(prev, next)) {
        this.cc1Broadcaster?.signal('sync-status');
      }
      return next;
    }

    this.pushPermissionProbeInFlight = true;
    log.info(
      {
        caller,
        host: 'github.com',
        hasDetectGh: this.detectGh !== undefined,
        hasTokenStore: this.tokenStore !== undefined && this.tokenStore !== null,
      },
      '[sync] push-permission probe dispatching',
    );
    let outcome: PushPermission;
    try {
      outcome = await this.checkPushPermissionFn({
        owner: origin.owner,
        repo: origin.repo,
        host: 'github.com',
        detectGh: this.detectGh,
        tokenStore: this.tokenStore,
      });
    } catch (err) {
      log.warn({ err, caller }, '[sync] push-permission probe threw — recording unknown/network');
      outcome = { kind: 'unknown', error: 'network' };
    } finally {
      this.pushPermissionProbeInFlight = false;
    }

    const next = pushPermissionStatusFrom(outcome);
    const prev = this.pushPermission;
    this.pushPermission = next;

    let transitioned = false;
    if (next.checkStatus === 'denied' && this.syncEnabled === true) {
      if (this.pausedReason !== 'no-push-permission' || this.state !== 'disabled') {
        this.pausedReason = 'no-push-permission';
        this.transitionTo('disabled'); // already broadcasts CC1 sync-status
        transitioned = true;
        log.info(
          { reason: next.deniedReason, caller },
          '[sync] paused — no push permission on origin',
        );
      }
    } else if (next.checkStatus === 'allowed' && this.pausedReason === 'no-push-permission') {
      this.pausedReason = undefined;
      if (this.state === 'disabled' && this.syncEnabled === true) {
        this.transitionTo('idle');
      }
      transitioned = true;
      log.info({ caller, priorState: this.state }, '[sync] push permission restored');
    }

    if (!transitioned && !pushPermissionStatusEqual(prev, next)) {
      this.cc1Broadcaster?.signal('sync-status');
    }

    return next;
  }

  async refreshRemote(): Promise<void> {
    if (this.hasRemote) return;

    const detected = await this.probeRemote();
    if (!detected) return;

    this.hasRemote = true;
    log.info(
      { syncEnabled: this.syncEnabled },
      '[sync] remote detected post-boot — re-evaluating state',
    );

    if (this.syncEnabled === true) {
      this.transitionTo('idle');
      this.schedulePull(0);
      this.schedulePush();
    } else {
      this.transitionTo('disabled');
    }
  }

  private async probeRemote(): Promise<boolean> {
    if (!existsSync(join(this.projectDir, '.git'))) return false;
    try {
      const handle = this.gitHandle();
      const remoteOutput = await handle.git.raw('remote', '-v');
      return remoteOutput.trim().length > 0;
    } catch (e) {
      log.warn({ err: e }, '[sync] remote detection failed');
      return false;
    }
  }

  getConflicts(): import('./conflict-storage.ts').ConflictEntry[] {
    return this.conflictStore.list();
  }

  async reconcileConflictsFromGit(): Promise<void> {
    if (this.conflictCount === 0) return;
    const before = this.conflictCount;
    const gitDir = resolveGitDir(this.projectDir);
    const mergeHeadPath = gitDir ? join(gitDir, 'MERGE_HEAD') : null;
    const mergeInProgress = mergeHeadPath !== null && existsSync(mergeHeadPath);

    if (!mergeInProgress) {
      log.info(
        { cleared: before },
        '[sync] external resolve detected (no MERGE_HEAD) — clearing tracked conflicts',
      );
      this.conflictStore.clear();
      this.conflictCount = 0;
    } else {
      try {
        const handle = this.gitHandle();
        const out = (await handle.git.raw(['diff', '--name-only', '--diff-filter=U'])).trim();
        const stillUnmerged = new Set(
          out
            ? out
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        );
        for (const entry of this.conflictStore.list()) {
          if (!stillUnmerged.has(entry.file)) {
            this.conflictStore.removeConflict(entry.file);
          }
        }
        this.conflictCount = this.conflictStore.count();
        if (this.conflictCount < before) {
          log.info(
            { cleared: before - this.conflictCount, remaining: this.conflictCount },
            '[sync] external resolve detected (mid-merge) — pruned resolved entries',
          );
        }
      } catch (err) {
        log.warn({ err }, '[sync] reconcileConflictsFromGit: git probe failed');
        return;
      }
    }

    if (this.conflictCount === before) return;
    if (this.conflictCount === 0 && this.state === 'conflict') {
      this.transitionTo('idle'); // fires CC1
      this.pausedReason = undefined;
      this.schedulePull();
      this.schedulePush();
    } else {
      this.cc1Broadcaster?.signal('sync-status');
    }
    this.scheduleSaveState();
  }

  async resolveConflict(
    file: string,
    strategy: import('./conflict-storage.ts').ResolveStrategy,
    content?: string,
  ): Promise<void> {
    this.setBatchInProgress?.(true);
    try {
      try {
        await this.conflictStore.resolveConflict(file, strategy, content);
      } catch (e) {
        this.conflictCount = this.conflictStore.count();
        this.scheduleSaveState();
        throw e;
      }
      this.conflictCount = this.conflictStore.count();
      if (this.conflictCount === 0 && this.state === 'conflict') {
        this.transitionTo('idle');
        this.pausedReason = undefined;
        this.schedulePull();
        this.schedulePush();
      } else {
        this.cc1Broadcaster?.signal('sync-status');
      }
      this.scheduleSaveState();
    } finally {
      this.setBatchInProgress?.(false);
    }
  }

  updateCurrentBranch(branch: string | null): void {
    if (branch === null) {
      if (this.state !== 'dormant' && this.state !== 'disabled') {
        this.transitionTo('disabled');
        this.pausedReason = 'detached-head';
        this.scheduleSaveState();
      }
    } else if (this.currentBranch !== branch) {
      this.currentBranch = branch;
      this.conflictStore.setBranch(branch);
      if (this.state === 'disabled' && this.pausedReason === 'detached-head') {
        this.pausedReason = undefined;
        this.transitionTo('idle');
        this.schedulePull();
        this.schedulePush();
      }
    }
  }


  private schedulePull(overrideDelayMs?: number): void {
    if (this.pullTimer !== null) clearTimeout(this.pullTimer);
    const delayMs = overrideDelayMs ?? this.effectivePullDelayMs();
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null;
      this.runPullCycle().catch((e) => {
        log.error({ err: e }, '[sync] pull cycle uncaught error');
      });
    }, delayMs);
  }

  private schedulePush(overrideDelayMs?: number): void {
    if (this.pushTimer !== null) clearTimeout(this.pushTimer);
    const delayMs = overrideDelayMs ?? jitteredMs(this.pushIntervalSeconds);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.runPushCycle().catch((e) => {
        log.error({ err: e }, '[sync] push cycle uncaught error');
      });
    }, delayMs);
  }

  private effectivePullDelayMs(): number {
    const failures = this.consecutiveFailures;
    const bkoff = backoffMs(failures);
    return bkoff > 0 ? bkoff : jitteredMs(this.pullIntervalSeconds);
  }


  private async runPullCycle(): Promise<void> {
    if (this.pullInFlight) return;
    if (this.state === 'dormant' || this.state === 'disabled' || this.state === 'auth-error')
      return;
    if (this.state === 'conflict') {
      this.schedulePull(); // retry after interval but don't fetch while conflicted
      return;
    }
    if (isUnbornHead(this.projectDir)) {
      this.schedulePull();
      return;
    }

    this.pullInFlight = true;
    try {
      await this.doPullCycle();
    } finally {
      this.pullInFlight = false;
      this.schedulePull(); // chain: schedule next after current completes
    }
  }

  private async doPullCycle(): Promise<void> {
    const handle = this.gitHandle();

    let branch: string;
    try {
      const b = (await handle.git.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
      if (!b || b === 'HEAD') {
        this.transitionTo('disabled');
        this.pausedReason = 'detached-head';
        log.warn({}, '[sync] detached HEAD — pausing sync');
        return;
      }
      branch = b;
      this.currentBranch = branch;
    } catch (e) {
      this.handleError(classifyGitError(e instanceof Error ? e : new Error(String(e))), 'pull');
      return;
    }

    this.transitionTo('fetching');
    try {
      await handle.git.fetch('origin');
      this.lastFetchUtc = new Date().toISOString();
      this.consecutiveFailures = 0;
      this.clearPullError();
    } catch (e) {
      const classified = classifyGitError(e instanceof Error ? e : new Error(String(e)));
      this.handleError(classified, 'pull');
      return;
    }

    try {
      const status = await handle.git.status();
      this.ahead = status.ahead;
      this.behind = status.behind;
    } catch {
    }

    if (this.behind > 0 && this.conflictCount === 0) {
      this.transitionTo('pulling');
      this.setBatchInProgress?.(true);
      try {
        await this.commitDirtyContentFilesToHead(handle);
        const mergePrep = await this.prepareForMerge(handle, branch);
        if (!mergePrep.proceed) return;
        try {
          await handle.git.merge([`origin/${branch}`]);
          this.lastSyncUtc = new Date().toISOString();
          this.behind = 0;
          this.transitionTo('idle');
        } finally {
          if (mergePrep.needsStashPop) await this.popPreMergeStash(handle);
        }
      } catch (e) {
        const classified = classifyGitError(e instanceof Error ? e : new Error(String(e)));
        if (classified.class === 'semantic' && classified.subclass === 'merge-conflict') {
          await this.handleMergeConflict();
        } else {
          this.handleError(classified, 'pull');
        }
        return;
      } finally {
        this.setBatchInProgress?.(false);
      }
    } else {
      this.transitionTo('idle');
    }

    this.scheduleSaveState();
  }


  private async runPushCycle(): Promise<void> {
    if (this.pushInFlight) return;
    if (this.state === 'dormant' || this.state === 'disabled') return;
    if (this.state === 'conflict' || this.state === 'auth-error') return;
    if (isUnbornHead(this.projectDir)) {
      this.schedulePush();
      return;
    }

    this.pushInFlight = true;
    try {
      await this.doPushCycle(1);
    } finally {
      this.pushInFlight = false;
      this.schedulePush(); // chain: schedule next after current completes
    }
  }

  private async doPushCycle(retriesLeft = 0): Promise<void> {
    const contentFiles = this.gatherContentFilesSync();

    const tmpIndexPath = join(tmpdir(), `ok-sync-idx-${process.pid}-${Date.now()}.idx`);
    let commitSha: string | null = null;

    this.transitionTo('pushing');

    try {
      await withParentLock(async () => {
        const handle = this.gitHandle(tmpIndexPath);

        if (isUnbornHead(this.projectDir)) {
          log.info({}, '[sync] repo has no commits yet — skipping push cycle');
          this.transitionTo('idle');
          return;
        }
        let headSha: string;
        try {
          headSha = (await handle.git.revparse('HEAD')).trim();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const raw = (e as { git?: unknown }).git?.toString() ?? msg;
          const combined = `${msg}\n${raw}`;
          if (
            /unknown revision or path not in the working tree/i.test(combined) ||
            /ambiguous argument 'HEAD'/i.test(combined) ||
            /does not have any commits yet/i.test(combined)
          ) {
            log.info({}, '[sync] repo has no commits yet — skipping push cycle');
            this.transitionTo('idle');
            return;
          }
          this.handleError(classifyGitError(e instanceof Error ? e : new Error(String(e))), 'push');
          return; // early exit from lock
        }

        await handle.git.raw(['read-tree', headSha]);

        const headContentSet = await this.listHeadContentPaths(handle, headSha);

        if (contentFiles.length > 0) {
          const BATCH = 100; // avoid ARG_MAX
          for (let i = 0; i < contentFiles.length; i += BATCH) {
            const batch = contentFiles.slice(i, i + BATCH).map((f) => f.projectRelPath);
            await handle.git.raw(['add', '--', ...batch]);
          }
        }

        const onDiskSet = new Set(contentFiles.map((f) => f.projectRelPath));
        const deleted = [...headContentSet].filter((f) => !onDiskSet.has(f));
        await this.removePathsFromIndex(handle, deleted);

        const newTreeSha = (await handle.git.raw(['write-tree'])).trim();

        let headTreeSha = '';
        try {
          headTreeSha = (await handle.git.raw(['rev-parse', `${headSha}^{tree}`])).trim();
        } catch {
        }
        if (headTreeSha && headTreeSha === newTreeSha) {
          let upstreamSha: string | null = null;
          try {
            upstreamSha = (
              await handle.git.raw(['rev-parse', `origin/${this.currentBranch}`])
            ).trim();
          } catch {
          }

          if (upstreamSha === headSha) {
            log.info(
              { contentFileCount: contentFiles.length, headSha },
              '[sync] push cycle: nothing to commit (tree unchanged, origin matches HEAD)',
            );
            this.lastPushedSha = headSha;
            this.lastSyncUtc = new Date().toISOString();
            this.clearPushError();
            this.transitionTo('idle');
            return;
          }

          log.info(
            { headSha, upstreamSha },
            '[sync] push cycle: tree unchanged but local ahead of origin — pushing existing commits',
          );

          let hasUpstream = false;
          try {
            await handle.git.raw(['rev-parse', '--abbrev-ref', `${this.currentBranch}@{u}`]);
            hasUpstream = true;
          } catch {}

          if (hasUpstream) {
            await handle.git.raw(['push', 'origin', this.currentBranch]);
          } else {
            await handle.git.raw(['push', '--set-upstream', 'origin', this.currentBranch]);
          }

          commitSha = headSha;
          return;
        }

        let changedProjectRelPaths: string[] = [];
        let changedContentRelPaths: string[] = [];
        try {
          const diffOut = (
            await handle.git.raw(['diff-tree', '--name-only', '-r', headSha, newTreeSha])
          ).trim();
          if (diffOut) {
            const contentFileByProjRel = new Map(
              contentFiles.map((f) => [f.projectRelPath, f.contentRelPath]),
            );
            for (const line of diffOut.split('\n')) {
              const projRelPath = line.trim();
              if (!projRelPath) continue;
              changedProjectRelPaths.push(projRelPath);
              const contentRelPath =
                contentFileByProjRel.get(projRelPath) ??
                toPosix(relative(this.contentDir, join(this.projectDir, projRelPath)));
              if (contentRelPath && !contentRelPath.startsWith('..')) {
                changedContentRelPaths.push(contentRelPath);
              }
            }
          }
        } catch {
          changedProjectRelPaths = contentFiles.map((f) => f.projectRelPath).concat(deleted);
          changedContentRelPaths = contentFiles.map((f) => f.contentRelPath);
        }
        const message = this.buildCommitMessage(changedContentRelPaths);

        const identity = await resolveGitIdentity(this.projectDir);
        const nextUnresolved = identity === null;
        if (this.identityUnresolved !== nextUnresolved) {
          this.identityUnresolved = nextUnresolved;
          this.cc1Broadcaster?.signal('sync-status');
        }
        const authorName = identity?.name ?? 'OpenKnowledge';
        const authorEmail = identity?.email ?? 'sync@open-knowledge.local';

        applyGitEnv(handle, {
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_COMMITTER_NAME: authorName,
          GIT_COMMITTER_EMAIL: authorEmail,
        });

        const newCommitSha = (
          await handle.git.raw(['commit-tree', newTreeSha, '-p', headSha, '-m', message])
        ).trim();

        if (!newCommitSha || !SHA_HEX_40.test(newCommitSha)) {
          log.warn(
            { raw: newCommitSha },
            '[sync] commit-tree returned invalid SHA — aborting push',
          );
          this.transitionTo('idle');
          return;
        }

        await handle.git.raw([
          'update-ref',
          `refs/heads/${this.currentBranch}`,
          newCommitSha,
          headSha,
        ]);

        await this.resetRealIndexForPaths(changedProjectRelPaths);

        let hasUpstream = false;
        try {
          await handle.git.raw(['rev-parse', '--abbrev-ref', `${this.currentBranch}@{u}`]);
          hasUpstream = true;
        } catch {}

        if (hasUpstream) {
          await handle.git.raw(['push', 'origin', this.currentBranch]);
        } else {
          await handle.git.raw(['push', '--set-upstream', 'origin', this.currentBranch]);
        }

        commitSha = newCommitSha;
      });

      if (commitSha) {
        this.lastPushedSha = commitSha;
        this.lastSyncUtc = new Date().toISOString();
        this.ahead = 0;
        this.clearPushError();
        if (this.state === 'pushing') {
          this.transitionTo('idle');
        }
        if (this.pausedReason === 'dirty-tree') {
          this.pausedReason = undefined;
          this.clearPullError();
          this.schedulePull(0);
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const classified = classifyGitError(err);
      if (classified.class === 'semantic' && classified.subclass === 'non-fast-forward') {
        if (retriesLeft > 0) {
          log.info({}, '[sync] push rejected (non-fast-forward) — fetching, merging, retrying');
          const retryHandle = this.gitHandle();
          this.setBatchInProgress?.(true);
          try {
            await retryHandle.git.fetch('origin');
            await this.commitDirtyContentFilesToHead(retryHandle);
            const mergePrep = await this.prepareForMerge(retryHandle, this.currentBranch);
            if (!mergePrep.proceed) {
              this.setBatchInProgress?.(false);
              return;
            }
            try {
              await retryHandle.git.merge([`origin/${this.currentBranch}`]);
            } finally {
              if (mergePrep.needsStashPop) await this.popPreMergeStash(retryHandle);
            }
          } catch (mergeErr) {
            const mc = classifyGitError(
              mergeErr instanceof Error ? mergeErr : new Error(String(mergeErr)),
            );
            if (mc.class === 'semantic' && mc.subclass === 'merge-conflict') {
              await this.handleMergeConflict();
            } else {
              this.handleError(mc, 'pull');
            }
            this.scheduleSaveState();
            return;
          } finally {
            this.setBatchInProgress?.(false);
          }
          await this.doPushCycle(0);
          return;
        }
        log.info({}, '[sync] push still rejected after retry — waiting for next pull cycle');
        this.consecutiveFailures++;
        if (this.state === 'pushing') this.transitionTo('idle');
      } else {
        this.handleError(classified, 'push');
      }
    } finally {
      try {
        unlinkSync(tmpIndexPath);
      } catch {}
    }

    this.scheduleSaveState();
  }


  private async commitDirtyContentFilesToHead(handle: GitHandle): Promise<string | null> {
    const status = await handle.git.status();
    if (status.files.length === 0) return null;

    const headSha = (await handle.git.revparse('HEAD')).trim();
    const contentFiles = this.gatherContentFilesSync();
    const headContentSet = await this.listHeadContentPaths(handle, headSha);
    if (contentFiles.length === 0 && headContentSet.size === 0) return null;

    const tmpIndex = join(tmpdir(), `ok-sync-retry-idx-${process.pid}-${Date.now()}.idx`);
    const isoHandle = this.gitHandle(tmpIndex);
    try {
      await isoHandle.git.raw(['read-tree', headSha]);
      const BATCH = 100;
      for (let i = 0; i < contentFiles.length; i += BATCH) {
        const batch = contentFiles.slice(i, i + BATCH).map((f) => f.projectRelPath);
        await isoHandle.git.raw(['add', '--', ...batch]);
      }
      const onDiskSet = new Set(contentFiles.map((f) => f.projectRelPath));
      const deleted = [...headContentSet].filter((f) => !onDiskSet.has(f));
      await this.removePathsFromIndex(isoHandle, deleted);
      const newTreeSha = (await isoHandle.git.raw(['write-tree'])).trim();
      const headTreeSha = (await isoHandle.git.raw(['rev-parse', `${headSha}^{tree}`])).trim();
      if (newTreeSha === headTreeSha) return null;
      let changedProjectRelPaths: string[] = [];
      try {
        const diffOut = (
          await isoHandle.git.raw(['diff-tree', '--name-only', '-r', headSha, newTreeSha])
        ).trim();
        changedProjectRelPaths = diffOut
          ? diffOut
              .split('\n')
              .map((p) => p.trim())
              .filter(Boolean)
          : [];
      } catch {
        changedProjectRelPaths = contentFiles.map((f) => f.projectRelPath).concat(deleted);
      }

      const identity = await resolveGitIdentity(this.projectDir);
      const authorName = identity?.name ?? 'OpenKnowledge';
      const authorEmail = identity?.email ?? 'sync@open-knowledge.local';
      applyGitEnv(isoHandle, {
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_COMMITTER_NAME: authorName,
        GIT_COMMITTER_EMAIL: authorEmail,
      });

      const message = 'Auto-save: interim before merge';
      const newCommitSha = (
        await isoHandle.git.raw(['commit-tree', newTreeSha, '-p', headSha, '-m', message])
      ).trim();
      if (!newCommitSha || !SHA_HEX_40.test(newCommitSha)) {
        log.warn(
          { raw: newCommitSha },
          '[sync] commit-tree returned invalid SHA in commitDirtyContentFilesToHead',
        );
        return null;
      }

      await handle.git.raw([
        'update-ref',
        `refs/heads/${this.currentBranch}`,
        newCommitSha,
        headSha,
      ]);

      await this.resetRealIndexForPaths(changedProjectRelPaths, handle);

      return newCommitSha;
    } finally {
      try {
        unlinkSync(tmpIndex);
      } catch {}
    }
  }

  private async prepareForMerge(
    handle: GitHandle,
    branch: string,
  ): Promise<{ proceed: boolean; needsStashPop: boolean }> {
    let dirtyOut = '';
    try {
      dirtyOut = (await handle.git.raw(['diff-index', '--name-only', 'HEAD'])).trim();
    } catch (err) {
      log.warn({ err, branch }, '[sync] diff-index failed — allowing merge attempt');
      return { proceed: true, needsStashPop: false };
    }
    if (!dirtyOut) return { proceed: true, needsStashPop: false };
    const dirtyPaths = dirtyOut
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    if (dirtyPaths.length === 0) return { proceed: true, needsStashPop: false };

    let mergeOut = '';
    try {
      mergeOut = (await handle.git.raw(['diff', '--name-only', `HEAD..origin/${branch}`])).trim();
    } catch (err) {
      log.warn({ err, branch }, '[sync] merge-path diff failed — allowing merge attempt');
      return { proceed: true, needsStashPop: false };
    }
    const mergePaths = new Set(
      mergeOut
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean),
    );
    const blocking = dirtyPaths.filter((p) => mergePaths.has(p));

    if (blocking.length > 0) {
      const display = blocking.slice(0, 3).join(', ');
      const rest = blocking.length > 3 ? `, +${blocking.length - 3} more` : '';
      this.pullErrorCode = undefined;
      this.pullError = `Sync paused — your local changes to ${display}${rest} conflict with incoming changes. Commit, stash, or discard them before syncing.`;
      this.pausedReason = 'external-changes-pending';
      this.consecutiveFailures = 0;
      this.transitionTo('idle');
      this.scheduleSaveState();
      log.warn({ files: blocking }, '[sync] paused — dirty paths overlap incoming merge');
      return { proceed: false, needsStashPop: false };
    }

    const stashMessage = `ok-sync: pre-merge stash @ ${new Date().toISOString()}`;
    try {
      await handle.git.raw(['stash', 'push', '-m', stashMessage]);
    } catch (err) {
      log.warn({ err }, '[sync] stash push failed — proceeding without stash');
      return { proceed: true, needsStashPop: false };
    }
    return { proceed: true, needsStashPop: true };
  }

  private async popPreMergeStash(handle: GitHandle): Promise<void> {
    try {
      await handle.git.raw(['stash', 'pop']);
    } catch (err) {
      log.warn({ err }, '[sync] stash pop failed — stash remains on stack');
    }
  }

  private gatherContentFilesSync(): ContentFileEntry[] {
    const results: ContentFileEntry[] = [];

    const walk = (dir: string) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const dirRelPath = toPosix(relative(this.contentDir, fullPath));
          if (!dirRelPath.startsWith('..') && this.contentFilter.isDirExcluded(dirRelPath))
            continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const contentRelPath = toPosix(relative(this.contentDir, fullPath));
          if (!contentRelPath.startsWith('..') && !this.contentFilter.isExcluded(contentRelPath)) {
            const projectRelPath = toPosix(relative(this.projectDir, fullPath));
            results.push({ contentRelPath, projectRelPath });
          }
        }
      }
    };

    if (existsSync(this.contentDir)) {
      walk(this.contentDir);
    }
    return results;
  }

  private async listHeadContentPaths(handle: GitHandle, headSha: string): Promise<Set<string>> {
    const paths = new Set<string>();
    try {
      const lsOut = (await handle.git.raw(['ls-tree', '-r', '--name-only', headSha])).trim();
      for (const line of lsOut ? lsOut.split('\n') : []) {
        const projRelPath = line.trim();
        if (!projRelPath) continue;
        const absPath = join(this.projectDir, projRelPath);
        const contentRelPath = toPosix(relative(this.contentDir, absPath));
        if (!contentRelPath.startsWith('..') && !this.contentFilter.isExcluded(contentRelPath)) {
          paths.add(projRelPath);
        }
      }
    } catch {
    }
    return paths;
  }

  private async removePathsFromIndex(handle: GitHandle, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const unique = [...new Set(paths)];
    const BATCH = 100;
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = unique.slice(i, i + BATCH);
      await handle.git.raw(['rm', '--cached', '--', ...batch]);
    }
  }

  private async resetRealIndexForPaths(paths: string[], handle?: GitHandle): Promise<void> {
    if (paths.length === 0) return;
    const realIndexHandle = handle ?? this.gitHandle();
    const unique = [...new Set(paths)];
    const BATCH = 100;
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = unique.slice(i, i + BATCH);
      try {
        await realIndexHandle.git.raw(['reset', 'HEAD', '--', ...batch]);
      } catch {
      }
    }
  }

  private buildCommitMessage(contentRelPaths: string[]): string {
    if (contentRelPaths.length === 0) {
      return 'Auto-save: changes saved';
    }
    if (contentRelPaths.length <= 3) {
      return `Auto-save: Updated ${contentRelPaths.join(', ')}`;
    }
    return `Auto-save: ${contentRelPaths.length} files changed`;
  }


  private async handleMergeConflict(): Promise<void> {
    const handle = this.gitHandle();

    let conflictedFiles: string[] = [];
    try {
      const out = (await handle.git.raw(['diff', '--name-only', '--diff-filter=U'])).trim();
      conflictedFiles = out
        ? out
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    } catch (e) {
      log.error(
        { err: e },
        '[sync] failed to list conflicted files — aborting merge to avoid committing unresolved state',
      );
      try {
        await handle.git.raw(['merge', '--abort']);
      } catch (abortErr) {
        log.warn({ err: abortErr }, '[sync] git merge --abort failed during cleanup');
      }
      this.pullErrorCode = undefined;
      this.pullError = 'Failed to detect conflict files — merge aborted';
      this.pausedReason = undefined;
      this.transitionTo('idle');
      return;
    }

    const contentConflicts: string[] = [];
    const nonContentConflicts: string[] = [];

    for (const file of conflictedFiles) {
      const absPath = join(this.projectDir, file);
      const contentRelPath = toPosix(relative(this.contentDir, absPath));
      if (
        !contentRelPath.startsWith('..') &&
        isSupportedDocFile(contentRelPath) &&
        !this.contentFilter.isExcluded(contentRelPath)
      ) {
        contentConflicts.push(file);
      } else {
        nonContentConflicts.push(file);
      }
    }

    const nonContentResolveFailures: Array<{ file: string; err: unknown }> = [];
    for (const file of nonContentConflicts) {
      try {
        await handle.git.raw(['checkout', '--theirs', '--', file]);
        await handle.git.raw(['add', '--', file]);
        log.info({ file }, '[sync] auto-resolved non-content conflict with theirs');
      } catch (e) {
        log.warn(
          { err: e, file },
          '[sync] non-content auto-resolve failed — will abort merge and pause sync',
        );
        nonContentResolveFailures.push({ file, err: e });
      }
    }

    if (nonContentResolveFailures.length > 0) {
      const failedFiles = nonContentResolveFailures.map((f) => f.file);
      try {
        await handle.git.raw(['merge', '--abort']);
      } catch (abortErr) {
        log.warn(
          { err: abortErr, files: failedFiles },
          '[sync] git merge --abort failed during non-content cleanup',
        );
      }
      const display = failedFiles.slice(0, 3).join(', ');
      const rest = failedFiles.length > 3 ? `, +${failedFiles.length - 3} more` : '';
      this.pullErrorCode = undefined;
      this.pullError = `Sync paused — couldn't auto-resolve ${display}${rest}. Resolve in your terminal (e.g. \`git rm <file>\` or \`git checkout --ours/--theirs <file> && git add <file>\`), then retry sync.`;
      this.pausedReason = 'non-content-merge-failure';
      this.consecutiveFailures = 0;
      this.transitionTo('idle');
      this.scheduleSaveState();
      log.warn(
        { files: failedFiles },
        '[sync] non-content auto-resolve failed — merge aborted, sync paused',
      );
      return;
    }

    if (contentConflicts.length > 0) {
      for (const file of contentConflicts) {
        this.conflictStore.addConflict({ file, detectedAt: new Date().toISOString() });
      }
      this.conflictCount = this.conflictStore.count();
      await this.notifyContentConflictsDetected(contentConflicts);

      if (this.pullTimer !== null) {
        clearTimeout(this.pullTimer);
        this.pullTimer = null;
      }
      if (this.pushTimer !== null) {
        clearTimeout(this.pushTimer);
        this.pushTimer = null;
      }

      this.transitionTo('conflict');
      log.warn(
        { files: contentConflicts },
        '[sync] content conflicts — sync paused until resolved',
      );
    } else {
      try {
        await handle.git.raw(['commit', '--no-edit']);
        this.lastSyncUtc = new Date().toISOString();
        this.behind = 0;
        this.transitionTo('idle');
        log.info({}, '[sync] all conflicts auto-resolved — merge committed');
      } catch (e) {
        log.warn(
          { err: e },
          '[sync] failed to commit after auto-resolving conflicts — aborting merge',
        );
        try {
          await handle.git.raw(['merge', '--abort']);
        } catch (abortErr) {
          log.warn({ err: abortErr }, '[sync] git merge --abort failed during cleanup');
        }
        this.transitionTo('idle');
      }
    }
  }

  private async notifyContentConflictsDetected(files: string[]): Promise<void> {
    if (files.length === 0) return;
    try {
      await this.onContentConflictsDetected?.(files);
    } catch (err) {
      log.warn({ err, files }, '[sync] content conflict callback failed');
    }
  }


  private clearPushError(): void {
    this.pushError = undefined;
    this.pushErrorCode = undefined;
  }

  private clearPullError(): void {
    this.pullError = undefined;
    this.pullErrorCode = undefined;
  }

  private handleError(classified: ClassifiedError, op: 'push' | 'pull'): void {
    if (classified.userFacingCode !== null) {
      if (op === 'push') {
        this.pushErrorCode = classified.userFacingCode;
        this.pushError = undefined;
      } else {
        this.pullErrorCode = classified.userFacingCode;
        this.pullError = undefined;
      }
    } else if (op === 'push') {
      this.pushErrorCode = undefined;
      this.pushError = classified.message;
    } else {
      this.pullErrorCode = undefined;
      this.pullError = classified.message;
    }
    log.warn(
      {
        class: classified.class,
        subclass: classified.subclass,
        retryable: classified.retryable,
        rawStderr: classified.rawStderr,
      },
      `[sync-error] ${classified.message}`,
    );

    if (classified.class === 'auth') {
      this.ghTokenSource.invalidate();
      this.transitionTo('auth-error');
      this.pausedReason = 'auth-error';
    } else if (classified.class === 'semantic' && classified.subclass === 'protected-branch') {
      this.syncEnabled = false;
      this.transitionTo('disabled');
      this.pausedReason = 'protected-branch';
      void this.onAutoDisable?.('protected-branch');
    } else if (classified.class === 'local' && classified.subclass === 'dirty-tree') {
      this.consecutiveFailures++;
      this.transitionTo('idle');
      this.pausedReason = 'dirty-tree';
      this.schedulePush(0);
    } else if (classified.retryable) {
      this.consecutiveFailures++;
      this.transitionTo('offline');
    } else {
      this.consecutiveFailures++;
      this.transitionTo('idle');
    }
  }


  private transitionTo(newState: SyncState): void {
    if (this.state === newState) return;
    const prev = this.state;
    this.state = newState;
    log.info({ from: prev, to: newState }, `[sync] state: ${prev} → ${newState}`);
    this.onStateChange?.(newState);
    this.cc1Broadcaster?.signal('sync-status');
  }


  private scheduleSaveState(): void {
    if (this.stateSaveTimer !== null) return; // debounce
    this.stateSaveTimer = setTimeout(() => {
      this.stateSaveTimer = null;
      this.saveStateNow();
    }, 5_000);
  }

  private saveStateNow(): void {
    try {
      const persistedReason =
        this.pausedReason === 'no-push-permission' || this.pausedReason === 'auth-error'
          ? undefined
          : this.pausedReason;
      const data: PersistedSyncState = {
        version: 1,
        lastSyncUtc: this.lastSyncUtc,
        lastFetchUtc: this.lastFetchUtc,
        lastPushedSha: this.lastPushedSha,
        consecutiveFailures: this.consecutiveFailures,
        pausedReason: persistedReason,
        pausedSinceUtc: persistedReason ? new Date().toISOString() : undefined,
        inflightConflicts: this.conflictStore.list().map((c) => c.file),
      };
      writeFileSync(this.statePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      log.warn({ err: e }, '[sync] failed to persist sync state');
    }
  }

  private loadState(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const raw = readFileSync(this.statePath, 'utf-8');
      const data = JSON.parse(raw) as Partial<PersistedSyncState>;
      if (data.version !== 1) return;
      this.lastSyncUtc = data.lastSyncUtc ?? null;
      this.lastFetchUtc = data.lastFetchUtc ?? null;
      this.lastPushedSha = data.lastPushedSha ?? null;
      this.consecutiveFailures = data.consecutiveFailures ?? 0;
      this.pausedReason =
        data.pausedReason === 'no-push-permission' || data.pausedReason === 'auth-error'
          ? undefined
          : data.pausedReason;

      const inflightFiles = data.inflightConflicts ?? [];
      if (inflightFiles.length > 0) {
        for (const file of inflightFiles) {
          if (!this.conflictStore.list().some((c) => c.file === file)) {
            this.conflictStore.addConflict({ file, detectedAt: new Date().toISOString() });
          }
        }
        this.conflictCount = this.conflictStore.count();
      }
    } catch (e) {
      log.warn({ err: e }, '[sync] failed to load sync state');
    }
  }
}
