import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';
import {
  OK_DIR,
  type PullOutcome,
  type SyncMode,
  type SyncModeChangeSource,
  tryLineLevelCombine,
} from '@inkeep/open-knowledge-core';
import { inspectGitRepository } from '@inkeep/open-knowledge-core/git-repository';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { resolveGitDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { CC1Broadcaster } from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import { type ConflictEntry, ConflictStore } from './conflict-storage.ts';
import type { ContentFilter } from './content-filter.ts';
import { isShareableOkArtifact } from './content-filter.ts';
import { isSupportedDocFile } from './doc-extensions.ts';
import {
  type ClassifiedError,
  classifyGitError,
  type UserFacingErrorCode,
} from './error-classification.ts';
import { tracedUnlinkSync, tracedWriteFileSync } from './fs-traced.ts';
import { createGhTokenSource, type GhTokenSource } from './gh-token-source.ts';
import {
  applyGitEnv,
  createGitInstance,
  type GitHandle,
  type RelayGhToken,
  withParentLock,
} from './git-handle.ts';
import { resolveGitIdentity } from './git-identity.ts';
import { listNames } from './git-paths.ts';
import {
  type CheckPushPermissionOptions,
  type DetectGhAccountsFn,
  type DetectGhFn,
  checkPushPermission as defaultCheckPushPermission,
  type ProbeTokenStore,
  type PushPermission,
} from './github-permissions.ts';
import { getLogger } from './logger.ts';
import {
  applyManagedMcpEntry,
  getMcpUnownedShell,
  type NativeTomlMcpEditor,
  reconcileTrackedMcpConfig,
  TRACKED_MCP_CONFIG_TARGETS,
} from './mcp-config-reconciler.ts';
import { toPosix } from './path-utils.ts';
import {
  readOriginGitHubRepo,
  readSyncRemoteInfo,
  type SyncRemoteInfo,
  sameGitHubLogin,
} from './share/git-context.ts';
import {
  type CachedGitHubAccountResolver,
  type CredentialUrlMatchReader,
  createCachedGitHubAccountResolver,
  type GitHubAccount,
} from './share/github-account.ts';
import { assertRealpathWithinDir } from './symlink-guard.ts';
import {
  computeRemainingMs,
  type PullAuthTier,
  pullIntervalSecondsForAuthTier,
} from './sync-timing.ts';

const log = getLogger('sync-engine');
const TRACKED_MCP_CONFIG_TARGET_SET: ReadonlySet<string> = new Set(TRACKED_MCP_CONFIG_TARGETS);

const SHA_HEX_40 = /^[0-9a-f]{40}$/i;

const execFileAsync = promisify(execFile);

class ShareableOkEnumerationError extends Error {
  constructor(relDir: string, cause: unknown) {
    super(`Shareable .ok subtree "${relDir}" could not be fully enumerated; sync staging aborted`, {
      cause,
    });
    this.name = 'ShareableOkEnumerationError';
  }
}

export type FastForwardRefusal = 'overlay-overlap' | 'divergence' | 'unknown';

export function classifyFastForwardRefusal(input: {
  exitCode?: number | null;
  stderr: string;
}): FastForwardRefusal {
  const { exitCode, stderr } = input;
  const s = stderr ?? '';
  if (exitCode === 128 || (/^fatal:/m.test(s) && /not possible to fast-forward/i.test(s))) {
    return 'divergence';
  }
  if (/^error:/m.test(s) && /would be overwritten by merge/i.test(s)) {
    return 'overlay-overlap';
  }
  return 'unknown';
}

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
  | ({
      checkStatus: 'denied';
      deniedReason: Extract<PushPermission, { kind: 'denied' }>['reason'];
    } & Pick<
      Extract<PushPermission, { kind: 'denied' }>,
      'resolvedLogin' | 'declaredLogin' | 'declaredSource'
    >)
  | {
      checkStatus: 'unknown';
      unknownError?: Extract<PushPermission, { kind: 'unknown' }>['error'];
    };

function pushPermissionStatusFrom(p: PushPermission): PushPermissionStatus {
  if (p.kind === 'allowed') return { checkStatus: 'allowed' };
  if (p.kind === 'denied') {
    return {
      checkStatus: 'denied',
      deniedReason: p.reason,
      ...(p.resolvedLogin !== undefined ? { resolvedLogin: p.resolvedLogin } : {}),
      ...(p.declaredLogin !== undefined ? { declaredLogin: p.declaredLogin } : {}),
      ...(p.declaredSource !== undefined ? { declaredSource: p.declaredSource } : {}),
    };
  }
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
    return (
      a.deniedReason === b.deniedReason &&
      a.resolvedLogin === b.resolvedLogin &&
      a.declaredLogin === b.declaredLogin &&
      a.declaredSource === b.declaredSource
    );
  }
  if (a.checkStatus === 'unknown' && b.checkStatus === 'unknown') {
    return a.unknownError === b.unknownError;
  }
  return true;
}

interface SyncStatus {
  state: SyncState;
  lastSyncUtc: string | null;
  lastRunUtc: string | null;
  lastPullOkUtc: string | null;
  lastPushOkUtc: string | null;
  lastFetchUtc: string | null;
  lastPushedSha: string | null;
  lastPullUtc: string | null;
  lastPullOutcome: PullOutcome | null;
  ahead: number;
  behind: number;
  consecutiveFailures: number;
  consecutivePushFailures: number;
  conflictCount: number;
  hasRemote: boolean;
  syncEnabled: boolean;
  syncMode: SyncMode;
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

interface PreparedMcpReconciliation {
  path: string;
  raw: string;
  winnerEntry: Record<string, unknown>;
}

interface MergePreparation {
  proceed: boolean;
  needsStashPop: boolean;
  reconciled: PreparedMcpReconciliation[];
}

/**
 * ContentFilter read-opts for the two staging-path consultations
 * (`gatherContentFilesSync`, `listHeadContentPaths`): admits the shareable
 * `.ok` artifact allow-list for staging and deletion tracking. Both paths
 * must consult the identical predicate — a HEAD path the head listing admits
 * but the gather walk refuses would be committed as a spurious deletion on
 * every push cycle (precedent #55). The conflict partition
 * (`isContentConflictPath` / `handleMergeConflict`) deliberately stays
 * unscoped so these artifacts keep the non-content auto-resolve class.
 */
const CONTENT_SYNC_STAGING_SCOPE = { syncScope: { pathBase: 'content' } } as const;
const PROJECT_SYNC_STAGING_SCOPE = { syncScope: { pathBase: 'project' } } as const;
type SyncStagingScope = typeof CONTENT_SYNC_STAGING_SCOPE | typeof PROJECT_SYNC_STAGING_SCOPE;

type PullInvocation = 'explicit' | 'sync';

const BLOCKING_PATHS_CAP = 50;

const FORWARD_ONLY_PAUSES: ReadonlySet<string | undefined> = new Set([
  'diverged-local-commits',
  'external-changes-pending',
]);

const COMMIT_BLOCKING_MESSAGE = 'Commit local changes before syncing';

interface PersistedSyncState {
  version: 1;
  lastSyncUtc: string | null;
  lastPullOkUtc?: string | null;
  lastPushOkUtc?: string | null;
  lastFetchUtc: string | null;
  lastPushedSha: string | null;
  consecutiveFailures: number;
  consecutivePushFailures?: number;
  pushStreakIsConnectivity?: boolean;
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
  mode?: SyncMode;
  syncEnabled?: boolean;
  credentialConfig?: string[];
  cc1Broadcaster?: Pick<CC1Broadcaster, 'signal'> | null;
  onStateChange?: (state: SyncState) => void;
  onContentConflictsDetected?: (files: string[]) => void | Promise<void>;
  onContentConflictsResolved?: (files: string[]) => void | Promise<void>;
  setBatchInProgress?: (value: boolean) => void;
  onAutoDisable?: (reason: 'protected-branch') => void | Promise<void>;
  checkpointBeforeStrandedConversion?: (context: {
    branch: string;
    ahead: number;
  }) => void | Promise<void>;
  checkpointBeforeOverlayRestore?: (context: {
    branch: string;
    paths: number;
  }) => void | Promise<void>;
  mcpTomlEditor?: NativeTomlMcpEditor;
  detectGh?: DetectGhFn;
  detectGhAccounts?: DetectGhAccountsFn;
  _readCredentialUrlMatch?: CredentialUrlMatchReader;
  tokenStore?: ProbeTokenStore | null;
  checkPushPermissionFn?: (opts: CheckPushPermissionOptions) => Promise<PushPermission>;
}

function jitteredMs(seconds: number): number {
  const base = seconds * 1000;
  const jitter = base * 0.15 * (2 * Math.random() - 1);
  return Math.round(base + jitter);
}

function isUnbornHead(projectDir: string): boolean {
  const inspected = inspectGitRepository(projectDir);
  if (inspected.kind !== 'repository') return false;
  const head = inspected.repository.readHead();
  if (head.kind !== 'branch') return false;
  return inspected.repository.readRef(head.ref).kind === 'absent';
}

export const CONTENTION_WARN_THRESHOLD = 3;

export function isFetchDisprovableFailure(
  classified: Pick<ClassifiedError, 'class' | 'subclass'>,
): boolean {
  return (
    classified.class === 'network' && classified.subclass !== '429' && classified.subclass !== '5xx'
  );
}

function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures >= 8) return 60 * 60 * 1000;
  if (consecutiveFailures >= 5) return 15 * 60 * 1000;
  if (consecutiveFailures >= 3) return 5 * 60 * 1000;
  return 0;
}

const FF_ONLY_TIMEOUT_MS = 120_000;

const GIT_BLOCK_TIMEOUT_MS = 120_000;

export class SyncEngine {
  private state: SyncState = 'dormant';
  private projectDir: string;
  private contentDir: string;
  private contentFilter: ContentFilter;
  private contentRoot: string;
  /**
   * True when the project-root `.ok/` directory sits outside the contentDir
   * walk (content.dir configured as a subfolder). The push cycle then runs a
   * second enumeration rooted at the project root so shareable `.ok`
   * artifacts still stage and deletion-track; gather and head listing consult
   * this flag in lock-step (precedent #55).
   */
  private rootOkOutsideContentWalk: boolean;
  private pullIntervalSeconds: number;
  private pushIntervalSeconds: number;
  private mode: SyncMode;
  private credentialConfig: string[];
  private cc1Broadcaster: Pick<CC1Broadcaster, 'signal'> | null;
  private onStateChange: ((state: SyncState) => void) | undefined;
  private onContentConflictsDetected: ((files: string[]) => void | Promise<void>) | undefined;
  private onContentConflictsResolved: ((files: string[]) => void | Promise<void>) | undefined;
  private setBatchInProgress: ((value: boolean) => void) | undefined;
  private onAutoDisable: ((reason: 'protected-branch') => void | Promise<void>) | undefined;
  private checkpointBeforeStrandedConversion:
    | ((context: { branch: string; ahead: number }) => void | Promise<void>)
    | undefined;
  private checkpointBeforeOverlayRestore:
    | ((context: { branch: string; paths: number }) => void | Promise<void>)
    | undefined;
  private mcpTomlEditor: NativeTomlMcpEditor | undefined;
  private detectGh: DetectGhFn | undefined;

  private detectGhAccounts: DetectGhAccountsFn | undefined;
  private ghTokenSource: GhTokenSource;
  private ghAccountResolver: CachedGitHubAccountResolver;
  private declaredAccountWarnKey: string | undefined;
  private tokenStore: ProbeTokenStore | null | undefined;
  private checkPushPermissionFn: (opts: CheckPushPermissionOptions) => Promise<PushPermission>;
  private pushPermission: PushPermissionStatus | null = null;
  private pushPermissionProbeInFlight = false;
  private authTier: PullAuthTier | 'unknown' = 'unknown';

  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private stateSaveTimer: ReturnType<typeof setTimeout> | null = null;

  private lastSyncUtc: string | null = null;
  private get lastRunUtc(): string | null {
    if (this.lastPullOkUtc === null) return this.lastPushOkUtc;
    if (this.lastPushOkUtc === null) return this.lastPullOkUtc;
    return this.lastPullOkUtc > this.lastPushOkUtc ? this.lastPullOkUtc : this.lastPushOkUtc;
  }
  private lastPullOkUtc: string | null = null;
  private lastPushOkUtc: string | null = null;
  private pushCycleLanded = false;
  private fetchOnlyInFlight = false;
  private lastFetchUtc: string | null = null;
  private lastPushedSha: string | null = null;
  private lastPullUtc: string | null = null;
  private lastPullOutcome: PullOutcome | null = null;
  private consecutivePullFailures = 0;
  private consecutivePushFailures = 0;
  private pushStreakIsConnectivity = false;
  private consecutiveContentions = 0;
  private ahead = 0;
  private behind = 0;
  private conflictCount = 0;
  private pushError: string | undefined;
  private pushErrorCode: UserFacingErrorCode | undefined;
  private pullError: string | undefined;
  private pullErrorCode: UserFacingErrorCode | undefined;
  private pausedReason: string | undefined;
  private blockingPaths: string[] = [];
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
    this.rootOkOutsideContentWalk = toPosix(
      relative(this.contentDir, join(this.projectDir, OK_DIR)),
    ).startsWith('..');
    this.pullIntervalSeconds = options.pullIntervalSeconds ?? 30;
    this.pushIntervalSeconds = options.pushIntervalSeconds ?? 60;
    this.mode = options.mode ?? (options.syncEnabled === true ? 'full' : 'off');
    this.credentialConfig = options.credentialConfig ?? [];
    this.cc1Broadcaster = options.cc1Broadcaster ?? null;
    this.onStateChange = options.onStateChange;
    this.onContentConflictsDetected = options.onContentConflictsDetected;
    this.onContentConflictsResolved = options.onContentConflictsResolved;
    this.setBatchInProgress = options.setBatchInProgress;
    this.onAutoDisable = options.onAutoDisable;
    this.checkpointBeforeStrandedConversion = options.checkpointBeforeStrandedConversion;
    this.checkpointBeforeOverlayRestore = options.checkpointBeforeOverlayRestore;
    this.mcpTomlEditor = options.mcpTomlEditor;
    this.detectGh = options.detectGh;
    this.detectGhAccounts = options.detectGhAccounts;
    this.ghTokenSource = createGhTokenSource(options.detectGh);
    this.ghAccountResolver = createCachedGitHubAccountResolver({
      _readCredentialUrlMatch: options._readCredentialUrlMatch,
    });
    this.tokenStore = options.tokenStore;
    this.checkPushPermissionFn = options.checkPushPermissionFn ?? defaultCheckPushPermission;
    this.statePath = resolve(getLocalDir(this.projectDir), 'sync-state.json');
    this.conflictStore = new ConflictStore(this.projectDir, this.currentBranch);
  }

  private syncGhTarget(): { account: GitHubAccount; host: string } {
    const account = this.ghAccountResolver.resolve(this.projectDir);
    return { account, host: account.host ?? 'github.com' };
  }

  private resolveRelayGhToken(): RelayGhToken | null {
    const { account, host } = this.syncGhTarget();
    const relay = this.ghTokenSource.get(host, account.login);
    this.noteDeclaredAccountOutcome(account, host, relay);
    return relay;
  }

  private noteDeclaredAccountOutcome(
    account: GitHubAccount,
    host: string,
    relay: RelayGhToken | null,
  ): void {
    const declared = account.login;
    const resolvedLogin = relay === null ? undefined : (relay.login ?? this.activeGhLogin(host));
    const missed =
      declared !== undefined && (relay === null || !sameGitHubLogin(resolvedLogin, declared));
    if (!missed) {
      this.declaredAccountWarnKey = undefined;
      return;
    }
    const key = `${host}\0${declared}\0${account.source}\0${relay === null ? 'none' : 'fallback'}`;
    if (key !== this.declaredAccountWarnKey) {
      if (relay === null) {
        log.warn(
          { host, declaredLogin: declared, declaredSource: account.source },
          '[sync] declared GitHub account produced no gh token — git runs with no relayed credential',
        );
      } else {
        log.warn(
          {
            host,
            declaredLogin: declared,
            declaredSource: account.source,
            resolvedLogin,
          },
          '[sync] declared GitHub account did not produce the gh token — using the active account',
        );
      }
    }
    this.declaredAccountWarnKey = key;
  }

  private parkedOnAmbiguousNotFound(): boolean {
    return (
      (this.state === 'auth-error' || this.pausedReason === 'auth-error') &&
      (this.pushErrorCode === 'auth-not-found-as-identity' ||
        this.pullErrorCode === 'auth-not-found-as-identity')
    );
  }

  private activeGhLogin(host: string): string | undefined {
    if (!this.detectGhAccounts) return undefined;
    try {
      return this.detectGhAccounts(host)?.find((a) => a.active)?.login;
    } catch (err) {
      log.warn({ err, host }, '[sync] detectGhAccounts failed — fallback identity stays unnamed');
      return undefined;
    }
  }

  private gitHandle(gitIndexFile?: string): GitHandle {
    return createGitInstance(this.projectDir, {
      credentialConfig: this.credentialConfig,
      gitIndexFile,
      ghToken: this.resolveRelayGhToken() ?? undefined,
      timeoutMs: GIT_BLOCK_TIMEOUT_MS,
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
      } catch {}
    } catch (e) {
      log.warn({ err: e }, '[sync] remote detection failed');
    }

    if (hasRemote) {
      void this.probePushPermissionInternal('start');
    }

    if (this.mode === 'off') {
      if (hasRemote) this.transitionTo('disabled');
      log.info({ hasRemote, mode: this.mode }, '[sync] sync not enabled — staying inactive');
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

    this.conflictCount = this.conflictStore.count();
    const mergeNativeEntries = () =>
      this.conflictStore.list().filter((e) => e.variant !== 'working-tree');

    if (mergeNativeEntries().length > 0 && !mergeInProgress) {
      log.warn(
        { count: mergeNativeEntries().length },
        '[sync] persisted merge conflicts but no MERGE_HEAD — clearing stale state',
      );
      for (const entry of mergeNativeEntries()) this.conflictStore.removeConflict(entry.file);
      this.conflictCount = this.conflictStore.count();
    } else if (mergeNativeEntries().length > 0 && mergeInProgress) {
      try {
        const handle = this.gitHandle();
        const stillUnmerged = new Set(
          await listNames(handle.git, ['diff', '--name-only', '--diff-filter=U']),
        );
        const before = this.conflictCount;
        for (const entry of mergeNativeEntries()) {
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

    if (mergeInProgress && mergeNativeEntries().length === 0) {
      log.warn({}, '[sync] stale MERGE_HEAD detected with no tracked conflicts — aborting merge');
      try {
        const handle = this.gitHandle();
        await handle.git.raw(['merge', '--abort']);
      } catch (e) {
        log.warn({ err: e }, '[sync] git merge --abort for stale MERGE_HEAD failed');
      }
    }

    if (mergeNativeEntries().length > 0) {
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
    const workingTreeEntries = this.conflictStore
      .list()
      .filter((e) => e.variant === 'working-tree');
    if (workingTreeEntries.length > 0) {
      await this.notifyContentConflictsDetected(workingTreeEntries.map((entry) => entry.file));
    }

    if (this.mode === 'follow') await this.refreshAuthTier();

    const pullRemainingMs = computeRemainingMs(
      this.lastFetchUtc,
      this.currentPullIntervalSeconds(),
    );
    const pushRemainingMs = computeRemainingMs(this.lastPushOkUtc, this.pushIntervalSeconds);
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

  setIntervals(pullIntervalSeconds: number, pushIntervalSeconds: number): void {
    const pullChanged = this.pullIntervalSeconds !== pullIntervalSeconds;
    const pushChanged = this.pushIntervalSeconds !== pushIntervalSeconds;
    if (!pullChanged && !pushChanged) return;
    log.info(
      {
        pullFrom: this.pullIntervalSeconds,
        pullTo: pullIntervalSeconds,
        pushFrom: this.pushIntervalSeconds,
        pushTo: pushIntervalSeconds,
      },
      '[sync] cycle intervals changed',
    );
    this.pullIntervalSeconds = pullIntervalSeconds;
    this.pushIntervalSeconds = pushIntervalSeconds;
    if (pullChanged && this.pullTimer !== null) this.schedulePull();
    if (pushChanged && this.pushTimer !== null) this.schedulePush();
  }

  async setMode(mode: SyncMode, source: SyncModeChangeSource = 'config'): Promise<void> {
    if (this.mode === mode) return;
    const from = this.mode;
    this.mode = mode;
    log.info({ from, to: mode, source }, '[sync] mode changed');

    if (mode === 'off') {
      this.cancelScheduledCycles();
      await this.drainInFlightCycles();
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
    this.consecutivePullFailures = 0;
    this.consecutivePushFailures = 0;
    this.pushStreakIsConnectivity = false;

    if (!this.hasRemote) {
      this.transitionTo('dormant');
      this.saveStateNow();
      return;
    }

    if (mode === 'follow') {
      await this.drainInFlightCycles();
      this.cancelScheduledCycles();
      await this.convertStrandedCommitsToOverlay();
    }

    this.transitionTo('idle');
    this.schedulePull(0);
    this.schedulePush(0);
    this.saveStateNow();
    void this.probePushPermissionInternal('refresh');
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.setMode(enabled ? 'full' : 'off');
  }

  private cancelScheduledCycles(): void {
    if (this.pullTimer !== null) {
      clearTimeout(this.pullTimer);
      this.pullTimer = null;
    }
    if (this.pushTimer !== null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
  }

  private async drainInFlightCycles(): Promise<void> {
    const DRAIN_TIMEOUT_MS = 30_000;
    const drainStartMs = Date.now();
    while (this.pullInFlight || this.pushInFlight) {
      if (Date.now() - drainStartMs > DRAIN_TIMEOUT_MS) {
        log.warn(
          { pullInFlight: this.pullInFlight, pushInFlight: this.pushInFlight },
          '[sync] drain: timed out waiting for in-flight cycle',
        );
        break;
      }
      await wait(50);
    }
  }

  async probeUnpushedCommitCount(): Promise<number> {
    if (!this.hasRemote || isUnbornHead(this.projectDir)) return 0;
    return this.unpushedCommitCount(this.gitHandle());
  }

  private async unpushedCommitCount(handle: GitHandle): Promise<number> {
    try {
      const status = await handle.git.status();
      if (status.tracking) return status.ahead;
    } catch {}
    try {
      const out = (
        await handle.git.raw(['rev-list', '--count', `origin/${this.currentBranch}..HEAD`])
      ).trim();
      const n = Number.parseInt(out, 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  private async convertStrandedCommitsToOverlay(): Promise<void> {
    if (!this.hasRemote || isUnbornHead(this.projectDir)) return;
    const handle = this.gitHandle();

    let ahead: number;
    try {
      ahead = await this.unpushedCommitCount(handle);
    } catch (e) {
      log.warn(
        { err: e },
        '[sync] pull-only: could not probe stranded commits — skipping conversion',
      );
      return;
    }
    if (ahead === 0) return;

    try {
      await this.checkpointBeforeStrandedConversion?.({ branch: this.currentBranch, ahead });
    } catch (e) {
      log.warn({ err: e }, '[sync] pull-only: stranded-commit checkpoint failed — proceeding');
    }

    try {
      const base = (
        await handle.git.raw(['merge-base', 'HEAD', `origin/${this.currentBranch}`])
      ).trim();
      this.setBatchInProgress?.(true);
      try {
        await withParentLock(() => handle.git.raw(['reset', '--mixed', base]));
      } finally {
        this.setBatchInProgress?.(false);
      }
      const status = await handle.git.status();
      this.ahead = status.ahead;
      this.behind = status.behind;
      this.pausedReason = undefined;
      log.info(
        { ahead, behind: this.behind },
        '[sync] pull-only: folded stranded local commits into a working-tree overlay',
      );
    } catch (e) {
      this.pausedReason = 'diverged-local-commits';
      log.warn(
        { err: e },
        '[sync] pull-only: stranded-commit conversion failed — leaving branch as-is',
      );
    }
  }

  async notifyCredentialsChanged(): Promise<void> {
    if (this.mode === 'off') return;

    this.ghTokenSource.invalidate();
    this.ghAccountResolver.invalidate();

    if (this.state !== 'auth-error' && this.pausedReason !== 'auth-error') return;

    this.pausedReason = undefined;
    this.clearPushError();
    this.clearPullError();
    this.consecutivePullFailures = 0;
    this.consecutivePushFailures = 0;
    this.pushStreakIsConnectivity = false;

    this.hasRemote = await this.probeRemote();
    if (!this.hasRemote) {
      this.transitionTo('dormant');
      this.saveStateNow();
      return;
    }

    this.transitionTo('idle');
    this.schedulePull(0);
    this.schedulePush(0);
    this.saveStateNow();
    void this.probePushPermissionInternal('refresh');
  }

  async trigger(op: 'sync' | 'push' | 'pull' | 'fetch' = 'sync'): Promise<void> {
    if (op === 'fetch') {
      await this.fetchOnly();
      return;
    }
    this.consecutivePullFailures = 0;
    this.consecutivePushFailures = 0;
    this.pushStreakIsConnectivity = false;
    this.consecutiveContentions = 0;
    if (
      this.pausedReason === 'dirty-tree' ||
      this.pausedReason === 'external-changes-pending' ||
      this.pausedReason === 'non-content-merge-failure'
    ) {
      this.pausedReason = undefined;
      this.clearPullError();
    }
    if (this.parkedOnAmbiguousNotFound()) {
      this.ghTokenSource.invalidate();
      this.ghAccountResolver.invalidate();
      this.pausedReason = undefined;
      this.clearPushError();
      this.clearPullError();
      this.transitionTo('idle');
      this.schedulePull();
      this.schedulePush();
    }
    void this.probePushPermissionInternal('refresh');

    if (op === 'pull') {
      await this.pullOnce();
      return;
    }

    if (op === 'push') {
      await this.pushOnce();
      return;
    }

    if (this.state === 'dormant' || this.state === 'conflict' || this.state === 'auth-error') {
      log.warn(
        {
          op,
          state: this.state,
          mode: this.mode,
          hasRemote: this.hasRemote,
          pausedReason: this.pausedReason,
          conflictCount: this.conflictCount,
        },
        `[sync] trigger(${op}) ignored — state=${this.state}`,
      );
    } else {
      log.info({ op, state: this.state }, `[sync] trigger(${op}) running`);
    }
    await this.pushOnce();
    await this.pullOnce('sync');
  }

  async pushOnce(): Promise<void> {
    if (this.mode === 'full') {
      await this.runPushCycle();
      return;
    }
    await this.runOneShotPush();
  }

  private async runOneShotPush(): Promise<void> {
    if (this.pushInFlight || this.pullInFlight) {
      log.info(
        { pushInFlight: this.pushInFlight, pullInFlight: this.pullInFlight },
        '[sync] one-shot push refused — a cycle is already in flight',
      );
      return;
    }
    if (this.state === 'conflict' || this.state === 'auth-error') {
      log.info({ state: this.state }, `[sync] one-shot push refused — state=${this.state}`);
      return;
    }
    if (this.conflictCount > 0) {
      log.info(
        { conflictCount: this.conflictCount },
        '[sync] one-shot push refused — unresolved conflicts hold the tree',
      );
      return;
    }

    if (!this.hasRemote || isUnbornHead(this.projectDir)) {
      log.info(
        { hasRemote: this.hasRemote },
        '[sync] one-shot push refused — no remote, or no commits yet',
      );
      return;
    }

    const restingState = this.state;
    this.pushInFlight = true;
    try {
      await this.doPushCycle(1);
    } finally {
      this.pushInFlight = false;
      if (this.pushCycleLanded) this.markRun();
      const settled = this.currentState();
      if (settled !== 'conflict' && settled !== 'auth-error') {
        this.transitionTo(restingState);
      }
      this.cc1Broadcaster?.signal('sync-status');
    }
  }

  async fetchOnly(): Promise<boolean> {
    if (!this.hasRemote || isUnbornHead(this.projectDir)) return false;
    if (this.pullInFlight || this.pushInFlight || this.fetchOnlyInFlight) return false;

    this.fetchOnlyInFlight = true;
    const handle = this.gitHandle();
    try {
      await handle.git.fetch('origin');
      this.lastFetchUtc = new Date().toISOString();
      this.scheduleSaveState();
    } catch (err) {
      log.debug({ err }, '[sync] panel-open fetch failed — counts left as they were');
      return false;
    } finally {
      this.fetchOnlyInFlight = false;
    }
    await this.refreshDivergenceCounts(handle);
    this.cc1Broadcaster?.signal('sync-status');
    return true;
  }

  private async refreshDivergenceCounts(handle: GitHandle): Promise<void> {
    try {
      const status = await handle.git.status();
      this.ahead = status.ahead;
      this.behind = status.behind;
    } catch (err) {
      log.debug({ err }, '[sync] divergence-count refresh failed — keeping previous counts');
    }
  }

  async pullOnce(invocation: PullInvocation = 'explicit'): Promise<PullOutcome> {
    const mode = this.mode;
    const outcome = await this.runOneShotPull(invocation);
    log.info({ mode, outcome }, '[sync] one-shot pull complete');
    return outcome;
  }

  private async runOneShotPull(invocation: PullInvocation): Promise<PullOutcome> {
    if (this.pullInFlight || this.pushInFlight) {
      log.info(
        { pullInFlight: this.pullInFlight, pushInFlight: this.pushInFlight },
        '[sync] one-shot pull refused — a cycle is already in flight',
      );
      return this.recordPullOutcome('refused');
    }
    if (this.state === 'conflict') {
      log.info(
        { state: this.state },
        '[sync] one-shot pull refused — the conflict resolver holds the tree',
      );
      return this.recordPullOutcome('refused');
    }
    if (!this.hasRemote || isUnbornHead(this.projectDir)) {
      log.info(
        { hasRemote: this.hasRemote },
        '[sync] one-shot pull refused — no remote, or no commits yet',
      );
      return this.recordPullOutcome('refused');
    }

    const restingMode = this.mode;
    const restingState = this.state;
    const restingPausedReason = this.pausedReason;
    this.pullInFlight = true;
    try {
      return this.recordPullOutcome(await this.doPullCycle(invocation));
    } finally {
      this.pullInFlight = false;
      if (restingMode === 'off') {
        if (!FORWARD_ONLY_PAUSES.has(this.pausedReason)) {
          if (!FORWARD_ONLY_PAUSES.has(restingPausedReason)) {
            this.pausedReason = restingPausedReason;
          }
        }
        this.transitionTo(restingState);
      } else {
        this.schedulePull();
      }
    }
  }

  private recordPullOutcome(outcome: PullOutcome): PullOutcome {
    this.lastPullUtc = new Date().toISOString();
    this.lastPullOutcome = outcome;
    if (outcome === 'succeeded' || outcome === 'up-to-date' || outcome === 'conflict') {
      this.lastPullOkUtc = new Date().toISOString();
    }
    this.cc1Broadcaster?.signal('sync-status');
    return outcome;
  }

  getStatus(): SyncStatus {
    return {
      state: this.state,
      lastSyncUtc: this.lastSyncUtc,
      lastRunUtc: this.lastRunUtc,
      lastPullOkUtc: this.lastPullOkUtc,
      lastPushOkUtc: this.lastPushOkUtc,
      lastFetchUtc: this.lastFetchUtc,
      lastPushedSha: this.lastPushedSha,
      lastPullUtc: this.lastPullUtc,
      lastPullOutcome: this.lastPullOutcome,
      ahead: this.ahead,
      behind: this.behind,
      consecutiveFailures: this.consecutivePullFailures,
      consecutivePushFailures: this.consecutivePushFailures,
      conflictCount: this.conflictCount,
      hasRemote: this.hasRemote,
      syncEnabled: this.mode !== 'off',
      syncMode: this.mode,
      identityUnresolved: this.identityUnresolved,
      remote: this.hasRemote ? readSyncRemoteInfo(this.projectDir) : null,
      ...(this.pushError !== undefined ? { pushError: this.pushError } : {}),
      ...(this.pushErrorCode !== undefined ? { pushErrorCode: this.pushErrorCode } : {}),
      ...(this.pullError !== undefined ? { pullError: this.pullError } : {}),
      ...(this.pullErrorCode !== undefined ? { pullErrorCode: this.pullErrorCode } : {}),
      pausedReason: this.pausedReason,
      ...(this.blockingPathsForStatus().length > 0
        ? { blockingPaths: this.blockingPathsForStatus() }
        : {}),
      ...(this.pushPermission !== null ? { pushPermission: this.pushPermission } : {}),
    };
  }

  private blockingPathsForStatus(): string[] {
    if (this.pausedReason !== 'external-changes-pending') return [];
    return this.blockingPaths.slice(0, BLOCKING_PATHS_CAP);
  }

  getBlockingPaths(): string[] {
    return this.pausedReason === 'external-changes-pending' ? [...this.blockingPaths] : [];
  }

  async commitBlockingPaths(): Promise<string | null> {
    const paths = this.getBlockingPaths();
    if (paths.length === 0) return null;
    const handle = this.gitHandle();
    return withParentLock(async () => {
      await this.applyCommitIdentity(handle);
      try {
        await handle.git.raw(['add', '--', ...paths]);
        const staged = await listNames(handle.git, [
          'diff',
          '--cached',
          '--name-only',
          '--',
          ...paths,
        ]);
        if (staged.length === 0) return null;
        await handle.git.raw(['commit', '-m', COMMIT_BLOCKING_MESSAGE, '--', ...paths]);
      } catch (err) {
        await handle.git.raw(['reset', '--', ...paths]).catch(() => {});
        log.error({ err, files: paths.length }, '[sync] commit of blocking paths failed');
        throw err;
      }
      const sha = (await handle.git.revparse('HEAD')).trim();
      this.clearBlockingPause();
      log.info({ files: paths.length }, '[sync] committed overlapping paths at user request');
      return sha;
    });
  }

  private clearBlockingPause(): void {
    this.blockingPaths = [];
    this.pausedReason = undefined;
    this.clearPullError();
    this.consecutivePullFailures = 0;
    this.consecutivePushFailures = 0;
    this.pushStreakIsConnectivity = false;
    this.cc1Broadcaster?.signal('sync-status');
    this.scheduleSaveState();
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

  private async applyCommitIdentity(handle: GitHandle): Promise<void> {
    const identity = await resolveGitIdentity(this.projectDir);
    const nextUnresolved = identity === null;
    if (this.identityUnresolved !== nextUnresolved) {
      this.identityUnresolved = nextUnresolved;
      this.cc1Broadcaster?.signal('sync-status');
    }
    const name = identity?.name ?? 'OpenKnowledge';
    const email = identity?.email ?? 'sync@open-knowledge.local';
    applyGitEnv(handle, {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    });
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
        host: origin.host,
        hasDetectGh: this.detectGh !== undefined,
        hasTokenStore: this.tokenStore !== undefined && this.tokenStore !== null,
      },
      '[sync] push-permission probe dispatching',
    );
    const { account } = this.syncGhTarget();
    let outcome: PushPermission;
    try {
      outcome = await this.checkPushPermissionFn({
        owner: origin.owner,
        repo: origin.repo,
        host: origin.host,
        transport: origin.transport,
        account,
        detectGh: this.detectGh,
        detectGhAccounts: this.detectGhAccounts,
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
    if (next.checkStatus === 'denied' && this.mode === 'full' && this.parkedOnAmbiguousNotFound()) {
      log.info(
        { reason: next.deniedReason, caller },
        '[sync] probe denial not applied — repository-not-found park is the more specific diagnosis',
      );
    }
    if (
      next.checkStatus === 'denied' &&
      this.mode === 'full' &&
      !this.parkedOnAmbiguousNotFound()
    ) {
      if (this.pausedReason !== 'no-push-permission' || this.state !== 'disabled') {
        this.pausedReason = 'no-push-permission';
        this.transitionTo('disabled');
        transitioned = true;
        log.info(
          { reason: next.deniedReason, caller },
          '[sync] paused — no push permission on origin',
        );
      }
    } else if (next.checkStatus === 'allowed' && this.pausedReason === 'no-push-permission') {
      this.pausedReason = undefined;
      if (this.state === 'disabled' && this.mode === 'full') {
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
    log.info({ mode: this.mode }, '[sync] remote detected post-boot — re-evaluating state');

    if (this.mode !== 'off') {
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
    const mergeNative = this.conflictStore.list().filter((e) => e.variant !== 'working-tree');
    if (mergeNative.length === 0) return;
    const before = this.conflictCount;
    const gitDir = resolveGitDir(this.projectDir);
    const mergeHeadPath = gitDir ? join(gitDir, 'MERGE_HEAD') : null;
    const mergeInProgress = mergeHeadPath !== null && existsSync(mergeHeadPath);

    if (!mergeInProgress) {
      log.info(
        { cleared: mergeNative.length },
        '[sync] external resolve detected (no MERGE_HEAD) — clearing merge-native conflicts',
      );
      for (const entry of mergeNative) this.conflictStore.removeConflict(entry.file);
      this.conflictCount = this.conflictStore.count();
    } else {
      try {
        const handle = this.gitHandle();
        const stillUnmerged = new Set(
          await listNames(handle.git, ['diff', '--name-only', '--diff-filter=U']),
        );
        for (const entry of mergeNative) {
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
    if (this.conflictCount === 0) {
      this.transitionTo('idle');
      this.pausedReason = undefined;
      this.schedulePull();
      this.schedulePush(0);
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
    const wasWorkingTree =
      this.conflictStore.list().find((c) => c.file === file)?.variant === 'working-tree';
    this.setBatchInProgress?.(true);
    try {
      try {
        await this.conflictStore.resolveConflict(file, strategy, content);
      } catch (e) {
        this.conflictCount = this.conflictStore.count();
        this.scheduleSaveState();
        throw e;
      }
      if (wasWorkingTree) {
        log.info({ choice: strategy }, '[sync] pull-only: conflict resolved by choice');
      }
      await this.notifyContentConflictsResolved([file]);
      this.conflictCount = this.conflictStore.count();
      if (this.conflictCount === 0) {
        this.transitionTo('idle');
        this.pausedReason = undefined;
        this.schedulePull();
        this.schedulePush(0);
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
        this.schedulePush(0);
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
    if (this.mode !== 'full') return;
    if (this.pushTimer !== null) clearTimeout(this.pushTimer);
    const delayMs = overrideDelayMs ?? this.effectivePushDelayMs();
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.runPushCycle().catch((e) => {
        log.error({ err: e }, '[sync] push cycle uncaught error');
      });
    }, delayMs);
  }

  private async resolveAuthTier(): Promise<PullAuthTier> {
    if (this.resolveRelayGhToken() !== null) return 'authenticated';
    if (this.tokenStore) {
      try {
        const entry = await this.tokenStore.get(this.syncGhTarget().host);
        if (entry?.token) return 'authenticated';
      } catch (err) {
        log.warn({ err }, '[sync] auth-tier token-store lookup threw — treating as anonymous');
      }
    }
    return 'anonymous';
  }

  private async refreshAuthTier(): Promise<void> {
    this.authTier = await this.resolveAuthTier();
  }

  private currentPullIntervalSeconds(): number {
    if (this.mode !== 'follow') return this.pullIntervalSeconds;
    return pullIntervalSecondsForAuthTier(
      this.pullIntervalSeconds,
      this.authTier === 'anonymous' ? 'anonymous' : 'authenticated',
    );
  }

  private effectivePullDelayMs(): number {
    const bkoff = backoffMs(this.consecutivePullFailures);
    const backoffSeconds = bkoff > 0 ? bkoff / 1000 : 0;
    return jitteredMs(Math.max(backoffSeconds, this.currentPullIntervalSeconds()));
  }

  private effectivePushDelayMs(): number {
    const bkoff = backoffMs(this.consecutivePushFailures);
    const backoffSeconds = bkoff > 0 ? bkoff / 1000 : 0;
    return jitteredMs(Math.max(backoffSeconds, this.pushIntervalSeconds));
  }

  private logContention(): void {
    const fields = {
      consecutiveContentions: this.consecutiveContentions,
      consecutivePushFailures: this.consecutivePushFailures,
      releasedConnectivityStreak: this.pushStreakIsConnectivity,
    };
    if (this.consecutiveContentions >= CONTENTION_WARN_THRESHOLD) {
      log.warn(
        fields,
        '[sync] push repeatedly losing to remote contention — not backing off by design',
      );
    } else {
      log.info(
        fields,
        '[sync] push still rejected after retry (contention) — scheduling next push at base cadence',
      );
    }
  }

  private bumpFailureCount(op: 'push' | 'pull', connectivityClass = false): void {
    if (op === 'push') {
      this.consecutiveContentions = 0;
      this.consecutivePushFailures++;
      this.pushStreakIsConnectivity =
        this.consecutivePushFailures === 1
          ? connectivityClass
          : this.pushStreakIsConnectivity && connectivityClass;
    } else this.consecutivePullFailures++;
  }

  private async runPullCycle(): Promise<void> {
    if (this.pullInFlight) return;
    if (this.state === 'dormant' || this.state === 'disabled' || this.state === 'auth-error')
      return;
    if (this.state === 'conflict') {
      this.schedulePull();
      return;
    }
    if (isUnbornHead(this.projectDir)) {
      this.schedulePull();
      return;
    }

    if (this.mode === 'follow') await this.refreshAuthTier();

    this.pullInFlight = true;
    try {
      this.recordPullOutcome(await this.doPullCycle(this.mode === 'full' ? 'sync' : 'explicit'));
    } finally {
      this.pullInFlight = false;
      this.schedulePull();
    }
  }

  private async doPullCycle(invocation: PullInvocation): Promise<PullOutcome> {
    const handle = this.gitHandle();

    let branch: string;
    try {
      const b = (await handle.git.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
      if (!b || b === 'HEAD') {
        this.transitionTo('disabled');
        this.pausedReason = 'detached-head';
        log.warn({}, '[sync] detached HEAD — pausing sync');
        return 'refused';
      }
      branch = b;
      this.currentBranch = branch;
    } catch (e) {
      this.handleError(classifyGitError(e instanceof Error ? e : new Error(String(e))), 'pull');
      return 'error';
    }

    this.transitionTo('fetching');
    try {
      await handle.git.fetch('origin');
      this.lastFetchUtc = new Date().toISOString();
      this.consecutivePullFailures = 0;
      this.clearPullError();
      if (this.consecutivePushFailures > 0 && this.pushStreakIsConnectivity) {
        log.info(
          { cleared: this.consecutivePushFailures },
          '[sync] fetch succeeded — releasing connectivity-class push backoff',
        );
        this.consecutivePushFailures = 0;
        this.pushStreakIsConnectivity = false;
        this.schedulePush();
      }
    } catch (e) {
      const classified = classifyGitError(e instanceof Error ? e : new Error(String(e)));
      this.handleError(classified, 'pull');
      return 'error';
    }

    await this.refreshDivergenceCounts(handle);

    if (this.behind > 0 && invocation === 'explicit') {
      const outcome = await this.doPullCycleB1(handle, branch);
      this.scheduleSaveState();
      return outcome;
    }
    if (this.behind > 0 && this.conflictCount === 0) {
      if (this.pausedReason === 'diverged-local-commits') this.pausedReason = undefined;
      this.transitionTo('pulling');
      this.setBatchInProgress?.(true);
      try {
        await this.commitDirtyContentFilesToHead(handle);
        const mergePrep = await this.prepareForMerge(handle, branch);
        if (!mergePrep.proceed) return 'refused';
        let stashRestored = true;
        let overlaysRestored = true;
        try {
          await this.applyCommitIdentity(handle);
          await handle.git.merge([`origin/${branch}`]);
          this.lastSyncUtc = new Date().toISOString();
          this.behind = 0;
          if (this.pausedReason === 'external-changes-pending') this.clearBlockingPause();
          this.transitionTo('idle');
        } finally {
          if (mergePrep.needsStashPop) {
            stashRestored = await this.popPreMergeStash(handle);
          }
          overlaysRestored = this.restoreReconciledMcpOverlays(mergePrep.reconciled);
        }
        if (!stashRestored) throw new Error('failed to replay pre-merge working-tree state');
        if (!overlaysRestored) throw new Error('failed to restore reconciled MCP overlays');
        await this.persistReconciledMcpEntries(mergePrep.reconciled);
        this.scheduleSaveState();
        return 'succeeded';
      } catch (e) {
        const classified = classifyGitError(e instanceof Error ? e : new Error(String(e)));
        if (classified.class === 'semantic' && classified.subclass === 'merge-conflict') {
          await this.handleMergeConflict();
          if (this.state === 'conflict') return 'conflict';
          return this.pullError ? 'error' : 'succeeded';
        }
        this.handleError(classified, 'pull');
        return 'error';
      } finally {
        this.setBatchInProgress?.(false);
      }
    }
    this.transitionTo('idle');
    this.scheduleSaveState();
    return this.behind === 0 ? 'up-to-date' : 'conflict';
  }

  private async doPullCycleB1(handle: GitHandle, branch: string): Promise<PullOutcome> {
    this.transitionTo('pulling');

    if (this.ahead > 0) {
      this.clearPullError();
      this.pausedReason = 'diverged-local-commits';
      this.transitionTo('idle');
      log.warn(
        { ahead: this.ahead, behind: this.behind },
        '[sync] pull-only: local history diverged — not fast-forwardable, skipping cycle',
      );
      return 'refused';
    }

    let oldHead: string;
    let overlapping: string[];
    try {
      oldHead = (await handle.git.revparse(['HEAD'])).trim();
      const overlayPaths = await listNames(handle.git, ['diff-index', '--name-only', 'HEAD']);
      const incoming = new Set(
        await listNames(handle.git, ['diff', '--name-only', `HEAD..origin/${branch}`]),
      );
      overlapping = overlayPaths.filter((p) => incoming.has(p));
    } catch (e) {
      this.handleError(classifyGitError(e instanceof Error ? e : new Error(String(e))), 'pull');
      return 'error';
    }

    const existing = new Map<string, ConflictEntry>();
    for (const e of this.conflictStore.list()) {
      if (e.variant === 'working-tree') existing.set(e.file, e);
    }

    let plan: Awaited<ReturnType<typeof this.planOverlapReconciliation>>;
    try {
      plan = await this.planOverlapReconciliation(handle, branch, oldHead, overlapping, existing);
    } catch (e) {
      this.handleError(classifyGitError(e instanceof Error ? e : new Error(String(e))), 'pull');
      return 'error';
    }

    this.setBatchInProgress?.(true);
    try {
      if (overlapping.length > 0) {
        try {
          await this.checkpointBeforeOverlayRestore?.({ branch, paths: overlapping.length });
        } catch (e) {
          log.warn(
            { err: e, paths: overlapping.length },
            '[sync] pull-only: overlay checkpoint failed before restore — proceeding',
          );
        }
        try {
          await handle.git.raw([
            'restore',
            '--source=HEAD',
            '--staged',
            '--worktree',
            '--',
            ...overlapping,
          ]);
        } catch (e) {
          log.warn(
            { err: e },
            '[sync] pull-only: failed to restore overlay before fast-forward — skipping cycle',
          );
          this.handleError(classifyGitError(e instanceof Error ? e : new Error(String(e))), 'pull');
          return 'error';
        }
      }

      const ff = await this.fastForwardOnly(handle, branch);
      if (!ff.ok) {
        try {
          this.applyOverlayPlan(plan.mineRestore, plan.deletions);
        } catch (e) {
          log.error(
            { err: e, refusal: ff.refusal },
            '[sync] pull-only: failed to restore overlay after fast-forward refusal',
          );
          this.handleError(classifyGitError(e instanceof Error ? e : new Error(String(e))), 'pull');
          return 'error';
        }
        if (ff.timedOut) {
          log.warn({}, '[sync] pull-only: fast-forward timed out — backing off');
          this.handleError(
            classifyGitError(
              new Error(`git merge --ff-only timed out after ${FF_ONLY_TIMEOUT_MS}ms`),
            ),
            'pull',
          );
          return 'error';
        }
        if (ff.refusal === 'divergence') this.pausedReason = 'diverged-local-commits';
        this.transitionTo('idle');
        log.warn(
          { refusal: ff.refusal, stderr: ff.stderr.slice(0, 200) },
          '[sync] pull-only: fast-forward refused — skipping cycle',
        );
        return 'refused';
      }

      try {
        this.applyOverlayPlan(plan.writes, plan.deletions);
      } catch (e) {
        log.error({ err: e }, '[sync] pull-only: failed to apply overlay after fast-forward');
        this.handleError(classifyGitError(e instanceof Error ? e : new Error(String(e))), 'pull');
        return 'error';
      }
      let conflictsPersisted = true;
      for (const entry of plan.upserts) {
        conflictsPersisted = this.conflictStore.addConflict(entry) && conflictsPersisted;
      }
      for (const file of plan.dissolved) {
        conflictsPersisted = this.conflictStore.removeConflict(file) && conflictsPersisted;
      }
      this.conflictCount = this.conflictStore.count();
      if (!conflictsPersisted) {
        log.error(
          {},
          '[sync] pull-only: failed to persist conflict state after fast-forward — surfacing as error',
        );
        this.handleError(
          classifyGitError(new Error('failed to persist conflict state after fast-forward')),
          'pull',
        );
        return 'error';
      }

      this.lastSyncUtc = new Date().toISOString();
      this.behind = 0;
      this.clearPullError();
      this.pausedReason = undefined;
      this.blockingPaths = [];
      this.transitionTo('idle');

      if (plan.newConflicts.length > 0) {
        await this.notifyContentConflictsDetected(plan.newConflicts);
      }
      if (plan.dissolved.length > 0) {
        await this.notifyContentConflictsResolved(plan.dissolved);
      }
      if (plan.newConflicts.length > 0 || plan.dissolved.length > 0) {
        this.cc1Broadcaster?.signal('sync-status');
      }

      const overlayStock = await this.countStandingOverlay(handle);
      log.info(
        {
          created: plan.newConflicts.length,
          autoCombined: plan.autoCombined.length,
          autoDissolved: plan.dissolved.length,
          autoRestored: plan.autoRestored.length,
          overlayStock,
        },
        '[sync] pull-only: fast-forwarded to origin tip',
      );

      return plan.newConflicts.length > 0 ? 'conflict' : 'succeeded';
    } finally {
      this.setBatchInProgress?.(false);
    }
  }

  private async fastForwardOnly(
    handle: GitHandle,
    branch: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        refusal: FastForwardRefusal;
        stderr: string;
        exitCode: number | null;
        timedOut: boolean;
      }
  > {
    try {
      await execFileAsync(
        'git',
        ['-c', 'core.autocrlf=false', 'merge', '--ff-only', `origin/${branch}`],
        { cwd: this.projectDir, env: handle.env, windowsHide: true, timeout: FF_ONLY_TIMEOUT_MS },
      );
      return { ok: true };
    } catch (e) {
      const err = e as {
        code?: number | string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };
      const timedOut = err.killed === true || err.signal === 'SIGTERM';
      const exitCode = typeof err.code === 'number' ? err.code : null;
      const stderr =
        typeof err.stderr === 'string' ? err.stderr : e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        refusal: classifyFastForwardRefusal({ exitCode, stderr }),
        stderr,
        exitCode,
        timedOut,
      };
    }
  }

  private async planOverlapReconciliation(
    handle: GitHandle,
    branch: string,
    oldHead: string,
    overlapping: string[],
    existing: Map<string, ConflictEntry>,
  ): Promise<{
    writes: Array<{ path: string; bytes: Buffer }>;
    mineRestore: Array<{ path: string; bytes: Buffer }>;
    deletions: string[];
    upserts: ConflictEntry[];
    dissolved: string[];
    newConflicts: string[];
    autoCombined: string[];
    autoRestored: string[];
  }> {
    const writes: Array<{ path: string; bytes: Buffer }> = [];
    const mineRestore: Array<{ path: string; bytes: Buffer }> = [];
    const deletions: string[] = [];
    const upserts: ConflictEntry[] = [];
    const dissolved: string[] = [];
    const newConflicts: string[] = [];
    const autoCombined: string[] = [];
    const autoRestored: string[] = [];

    for (const p of overlapping) {
      const priorEntry = existing.get(p);
      const hadEntry = priorEntry !== undefined;

      if (!existsSync(join(this.projectDir, p))) {
        try {
          await handle.git.revparse([`origin/${branch}:${p}`]);
        } catch (e) {
          if (this.classifyRefReadFailure(e) === 'error') {
            deletions.push(p);
            log.warn(
              { err: e, path: p },
              '[sync] pull-only: unexpected error probing origin for a deleted overlay — deferring reconcile',
            );
            continue;
          }
          deletions.push(p);
          if (hadEntry) dissolved.push(p);
          continue;
        }
        if (!this.isContentConflictPath(p)) {
          deletions.push(p);
          continue;
        }
        autoRestored.push(p);
        if (hadEntry) dissolved.push(p);
        continue;
      }

      let mineBuf: Buffer;
      try {
        mineBuf = readFileSync(join(this.projectDir, p));
      } catch {
        continue;
      }
      mineRestore.push({ path: p, bytes: mineBuf });
      const mineStr = mineBuf.toString('utf-8');

      let theirsStr: string | null = null;
      try {
        theirsStr = await handle.git.raw(['show', `origin/${branch}:${p}`]);
      } catch (e) {
        if (this.classifyRefReadFailure(e) === 'error') {
          log.warn(
            { err: e, path: p },
            '[sync] pull-only: unexpected error reading origin blob — keeping overlay, deferring reconcile',
          );
        }
        theirsStr = null;
      }

      if (theirsStr !== null && theirsStr === mineStr) {
        if (hadEntry) dissolved.push(p);
        continue;
      }

      if (theirsStr !== null && TRACKED_MCP_CONFIG_TARGET_SET.has(p)) {
        const head = await this.readMcpGitBlob(handle, oldHead, p);
        const index = await this.readMcpGitBlob(handle, '', p);
        const mcpPlan = reconcileTrackedMcpConfig({
          target: p,
          layers: {
            base: head,
            head,
            index,
            worktree: mineStr,
            incoming: theirsStr,
          },
          tomlEditor: this.mcpTomlEditor,
        });
        if (mcpPlan.kind === 'resolved') {
          if (mcpPlan.raw !== theirsStr) {
            writes.push({ path: p, bytes: Buffer.from(mcpPlan.raw, 'utf8') });
          }
          log.info(
            { event: 'mcp-config-reconcile', target: p, outcome: 'auto-resolved' },
            '[sync] pull-only: auto-resolved OpenKnowledge MCP entry overlap',
          );
          continue;
        }
        if (mcpPlan.kind === 'declined') {
          log.warn(
            {
              event: 'mcp-config-reconcile',
              target: p,
              outcome: 'declined',
              reason: mcpPlan.reason,
            },
            '[sync] pull-only: declined OpenKnowledge MCP entry reconciliation',
          );
        }
      }

      if (theirsStr === null || !this.isContentConflictPath(p)) {
        writes.push({ path: p, bytes: mineBuf });
        continue;
      }

      const baseSha = hadEntry
        ? priorEntry.baseSha
        : await this.gitBlobSha(handle, `${oldHead}:${p}`);
      const baseStr = baseSha ? await this.gitBlobContent(handle, baseSha) : '';
      const combined = tryLineLevelCombine(baseStr, mineStr, theirsStr);
      if (combined.clean) {
        writes.push({ path: p, bytes: Buffer.from(combined.merged, 'utf-8') });
        autoCombined.push(p);
        if (hadEntry) dissolved.push(p);
        continue;
      }

      writes.push({ path: p, bytes: mineBuf });
      const theirsSha = await this.gitBlobSha(handle, `origin/${branch}:${p}`);
      if (theirsSha === undefined) {
        log.warn(
          { path: p },
          '[sync] pull-only: could not pin origin blob for a collision — keeping overlay, deferring',
        );
        continue;
      }
      upserts.push({
        file: p,
        detectedAt: priorEntry?.detectedAt ?? new Date().toISOString(),
        variant: 'working-tree',
        theirsSha,
        baseSha,
      });
      if (!hadEntry) newConflicts.push(p);
    }

    return {
      writes,
      mineRestore,
      deletions,
      upserts,
      dissolved,
      newConflicts,
      autoCombined,
      autoRestored,
    };
  }

  private applyOverlayPlan(
    writes: Array<{ path: string; bytes: Buffer }>,
    deletions: string[],
  ): void {
    const guardOpts = { allowShareableOkArtifact: isShareableOkArtifact };
    for (const { path, bytes } of writes) {
      const abs = join(this.projectDir, path);
      assertRealpathWithinDir(abs, this.projectDir, guardOpts);
      tracedWriteFileSync(abs, bytes);
    }
    for (const path of deletions) {
      const abs = join(this.projectDir, path);
      assertRealpathWithinDir(abs, this.projectDir, guardOpts);
      try {
        tracedUnlinkSync(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }

  private isContentConflictPath(file: string): boolean {
    const absPath = join(this.projectDir, file);
    const contentRelPath = toPosix(relative(this.contentDir, absPath));
    return (
      !contentRelPath.startsWith('..') &&
      isSupportedDocFile(contentRelPath) &&
      !this.contentFilter.isExcluded(contentRelPath)
    );
  }

  private async gitBlobSha(handle: GitHandle, ref: string): Promise<string | undefined> {
    try {
      return (await handle.git.revparse([ref])).trim();
    } catch {
      return undefined;
    }
  }

  private classifyRefReadFailure(err: unknown): 'absent' | 'error' {
    const msg = err instanceof Error ? err.message : String(err);
    return /does not exist in|exists on disk, but not in/i.test(msg) ? 'absent' : 'error';
  }

  private async gitBlobContent(handle: GitHandle, sha: string): Promise<string> {
    return handle.git.raw(['cat-file', 'blob', sha]);
  }

  private async countStandingOverlay(handle: GitHandle): Promise<number | null> {
    try {
      const overlayPaths = await listNames(handle.git, ['diff-index', '--name-only', 'HEAD']);
      return overlayPaths.filter((p) => this.isContentConflictPath(p)).length;
    } catch {
      return null;
    }
  }

  private async runPushCycle(): Promise<void> {
    if (this.pushInFlight) return;
    if (this.mode !== 'full') return;
    if (this.state === 'dormant' || this.state === 'disabled') return;
    if (this.state === 'conflict' || this.state === 'auth-error') return;
    if (this.conflictCount > 0) {
      this.schedulePush();
      return;
    }
    if (isUnbornHead(this.projectDir)) {
      this.schedulePush();
      return;
    }
    if (this.pullInFlight) {
      log.info({ pullInFlight: true }, '[sync] push cycle deferred — a pull cycle holds the tree');
      if (this.pushTimer === null) this.schedulePush();
      return;
    }

    this.pushInFlight = true;
    try {
      await this.doPushCycle(1);
    } finally {
      this.pushInFlight = false;
      if (this.pushCycleLanded) this.markRun();
      this.schedulePush();
    }
  }

  private async doPushCycle(retriesLeft = 0): Promise<void> {
    this.pushCycleLanded = false;
    const tmpIndexPath = join(tmpdir(), `ok-sync-idx-${process.pid}-${Date.now()}.idx`);
    let commitSha: string | null = null;

    this.transitionTo('pushing');

    try {
      const contentFiles = this.gatherContentFilesSync();
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
          return;
        }

        await handle.git.raw(['read-tree', headSha]);

        const headContentSet = await this.listHeadContentPaths(handle, headSha);

        const staged = await this.stageContentFiles(handle, contentFiles);

        const onDiskSet = new Set(staged.map((f) => f.projectRelPath));
        const deleted = [...headContentSet].filter((f) => !onDiskSet.has(f));
        await this.removePathsFromIndex(handle, deleted);

        const newTreeSha = (await handle.git.raw(['write-tree'])).trim();

        let headTreeSha = '';
        try {
          headTreeSha = (await handle.git.raw(['rev-parse', `${headSha}^{tree}`])).trim();
        } catch {}
        if (headTreeSha && headTreeSha === newTreeSha) {
          let upstreamSha: string | null = null;
          try {
            upstreamSha = (
              await handle.git.raw(['rev-parse', `origin/${this.currentBranch}`])
            ).trim();
          } catch {}

          if (upstreamSha === headSha) {
            log.info(
              { contentFileCount: contentFiles.length, headSha },
              '[sync] push cycle: nothing to commit (tree unchanged, origin matches HEAD)',
            );
            this.lastPushedSha = headSha;
            this.lastSyncUtc = new Date().toISOString();
            this.pushCycleLanded = true;
            this.consecutivePushFailures = 0;
            this.consecutiveContentions = 0;
            this.pushStreakIsConnectivity = false;
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
          const diffPaths = await listNames(handle.git, [
            'diff-tree',
            '--name-only',
            '-r',
            headSha,
            newTreeSha,
          ]);
          if (diffPaths.length > 0) {
            const contentFileByProjRel = new Map(
              contentFiles.map((f) => [f.projectRelPath, f.contentRelPath]),
            );
            for (const projRelPath of diffPaths) {
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

        await this.applyCommitIdentity(handle);

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
        this.pushCycleLanded = true;
        this.ahead = 0;
        this.consecutivePushFailures = 0;
        this.consecutiveContentions = 0;
        this.pushStreakIsConnectivity = false;
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
      if (err instanceof ShareableOkEnumerationError) {
        log.warn({ err }, '[sync] push cycle: staging error detail');
      }
      const classified = classifyGitError(err);
      if (classified.class === 'semantic' && classified.subclass === 'non-fast-forward') {
        if (retriesLeft > 0) {
          log.info({}, '[sync] push rejected (non-fast-forward) — fetching, merging, retrying');
          const retryHandle = this.gitHandle();
          this.setBatchInProgress?.(true);
          let retryStage: 'fetch' | 'merge' | 'push' = 'fetch';
          try {
            await retryHandle.git.fetch('origin');
            retryStage = 'push';
            await this.commitDirtyContentFilesToHead(retryHandle);
            const mergePrep = await this.prepareForMerge(retryHandle, this.currentBranch);
            if (!mergePrep.proceed) {
              this.setBatchInProgress?.(false);
              return;
            }
            let stashRestored = true;
            let overlaysRestored = true;
            try {
              await this.applyCommitIdentity(retryHandle);
              retryStage = 'merge';
              await retryHandle.git.merge([`origin/${this.currentBranch}`]);
              retryStage = 'push';
            } finally {
              if (mergePrep.needsStashPop) {
                stashRestored = await this.popPreMergeStash(retryHandle);
              }
              overlaysRestored = this.restoreReconciledMcpOverlays(mergePrep.reconciled);
            }
            if (!stashRestored) throw new Error('failed to replay pre-merge working-tree state');
            if (!overlaysRestored) throw new Error('failed to restore reconciled MCP overlays');
            await this.persistReconciledMcpEntries(mergePrep.reconciled);
          } catch (mergeErr) {
            const mc = classifyGitError(
              mergeErr instanceof Error ? mergeErr : new Error(String(mergeErr)),
            );
            if (mc.class === 'semantic' && mc.subclass === 'merge-conflict') {
              await this.handleMergeConflict();
            } else {
              const leg = retryStage === 'merge' || retryStage === 'fetch' ? 'pull' : 'push';
              log.warn({ err: mergeErr, stage: retryStage }, '[sync] push retry error detail');
              this.handleError(mc, leg);
            }
            this.scheduleSaveState();
            return;
          } finally {
            this.setBatchInProgress?.(false);
          }
          await this.doPushCycle(0);
          return;
        }
        this.consecutiveContentions++;
        this.logContention();
        if (this.pushStreakIsConnectivity) {
          this.consecutivePushFailures = 0;
          this.pushStreakIsConnectivity = false;
          this.clearPushError();
        }
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
      const staged = await this.stageContentFiles(isoHandle, contentFiles);
      const onDiskSet = new Set(staged.map((f) => f.projectRelPath));
      const deleted = [...headContentSet].filter((f) => !onDiskSet.has(f));
      await this.removePathsFromIndex(isoHandle, deleted);
      const newTreeSha = (await isoHandle.git.raw(['write-tree'])).trim();
      const headTreeSha = (await isoHandle.git.raw(['rev-parse', `${headSha}^{tree}`])).trim();
      if (newTreeSha === headTreeSha) return null;
      let changedProjectRelPaths: string[] = [];
      try {
        changedProjectRelPaths = await listNames(isoHandle.git, [
          'diff-tree',
          '--name-only',
          '-r',
          headSha,
          newTreeSha,
        ]);
      } catch {
        changedProjectRelPaths = contentFiles.map((f) => f.projectRelPath).concat(deleted);
      }

      await this.applyCommitIdentity(isoHandle);

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

  private async readMcpGitBlob(
    handle: GitHandle,
    revision: string,
    path: string,
  ): Promise<string | null> {
    try {
      await handle.git.raw(['cat-file', '-e', `${revision}:${path}`]);
      return await handle.git.raw(['show', `${revision}:${path}`]);
    } catch {
      return null;
    }
  }

  private async planTrackedMcpOverlap(
    handle: GitHandle,
    branch: string,
    path: string,
  ): Promise<ReturnType<typeof reconcileTrackedMcpConfig>> {
    let baseRevision: string;
    try {
      baseRevision = (await handle.git.raw(['merge-base', 'HEAD', `origin/${branch}`])).trim();
    } catch (err) {
      log.warn(
        { err, branch, path },
        '[sync] MCP reconciliation merge-base unavailable — declining',
      );
      return { kind: 'declined', reason: 'merge-base-unavailable' };
    }
    const [base, head, index, incoming] = await Promise.all([
      this.readMcpGitBlob(handle, baseRevision, path),
      this.readMcpGitBlob(handle, 'HEAD', path),
      this.readMcpGitBlob(handle, '', path),
      this.readMcpGitBlob(handle, `origin/${branch}`, path),
    ]);
    let worktree: string | null = null;
    try {
      worktree = readFileSync(join(this.projectDir, path), 'utf8');
    } catch {}
    return reconcileTrackedMcpConfig({
      target: path,
      layers: { base, head, index, worktree, incoming },
      tomlEditor: this.mcpTomlEditor,
    });
  }

  private async prepareForMerge(handle: GitHandle, branch: string): Promise<MergePreparation> {
    const reconciled: PreparedMcpReconciliation[] = [];
    let dirtyPaths: string[];
    try {
      dirtyPaths = await listNames(handle.git, ['diff-index', '--name-only', 'HEAD']);
    } catch (err) {
      log.warn({ err, branch }, '[sync] diff-index failed — allowing merge attempt');
      return { proceed: true, needsStashPop: false, reconciled };
    }
    if (dirtyPaths.length === 0) return { proceed: true, needsStashPop: false, reconciled };

    let mergePaths: Set<string>;
    try {
      mergePaths = new Set(
        await listNames(handle.git, ['diff', '--name-only', `HEAD..origin/${branch}`]),
      );
    } catch (err) {
      log.warn({ err, branch }, '[sync] merge-path diff failed — allowing merge attempt');
      return { proceed: true, needsStashPop: false, reconciled };
    }
    let blocking = dirtyPaths.filter((p) => mergePaths.has(p));

    const trackedTargets = TRACKED_MCP_CONFIG_TARGET_SET;
    const mcpOverlaps = blocking.filter((path) => trackedTargets.has(path));
    if (mcpOverlaps.length > 0) {
      const plans = await Promise.all(
        mcpOverlaps.map(async (path) => ({
          path,
          plan: await this.planTrackedMcpOverlap(handle, branch, path),
        })),
      );
      const declined = plans.find(({ plan }) => plan.kind === 'declined');
      const hasOtherBlockingPath = blocking.some((path) => !trackedTargets.has(path));
      if (!declined && !hasOtherBlockingPath) {
        for (const { path, plan } of plans) {
          if (plan.kind !== 'resolved') continue;
          reconciled.push({ path, raw: plan.raw, winnerEntry: plan.winnerEntry });
          log.info(
            { event: 'mcp-config-reconcile', target: path, outcome: 'auto-resolved' },
            '[sync] auto-resolved OpenKnowledge MCP entry overlap',
          );
        }
        blocking = blocking.filter((path) => !trackedTargets.has(path));
      } else if (declined) {
        log.warn(
          {
            event: 'mcp-config-reconcile',
            target: declined.path,
            outcome: 'declined',
            reason: declined.plan.kind === 'declined' ? declined.plan.reason : undefined,
          },
          '[sync] declined OpenKnowledge MCP entry reconciliation',
        );
      } else if (hasOtherBlockingPath) {
        log.info(
          {
            event: 'mcp-config-reconcile',
            targets: mcpOverlaps,
            outcome: 'suppressed',
            reason: 'other-blocking-path',
          },
          '[sync] suppressed MCP entry reconciliation because another path blocks the merge',
        );
      }
    }

    if (blocking.length > 0) {
      const display = blocking.slice(0, 3).join(', ');
      const rest = blocking.length > 3 ? `, +${blocking.length - 3} more` : '';
      this.blockingPaths = blocking;
      this.pullErrorCode = undefined;
      this.pullError = `Sync paused — your local changes to ${display}${rest} conflict with incoming changes. Commit, stash, or discard them before syncing.`;
      this.pausedReason = 'external-changes-pending';
      this.consecutivePullFailures = 0;
      this.transitionTo('idle');
      this.scheduleSaveState();
      log.warn({ files: blocking }, '[sync] paused — dirty paths overlap incoming merge');
      return { proceed: false, needsStashPop: false, reconciled: [] };
    }

    if (reconciled.length > 0) {
      try {
        await handle.git.raw([
          'restore',
          '--source=HEAD',
          '--staged',
          '--worktree',
          '--',
          ...reconciled.map((item) => item.path),
        ]);
      } catch (err) {
        log.warn({ err }, '[sync] could not isolate reconciled MCP paths from pre-merge stash');
        this.pullError =
          'Sync paused — OpenKnowledge could not safely isolate local MCP launcher changes before merging.';
        this.pausedReason = 'external-changes-pending';
        this.blockingPaths = [];
        this.transitionTo('idle');
        this.scheduleSaveState();
        return { proceed: false, needsStashPop: false, reconciled: [] };
      }
    }

    const reconciledPaths = new Set(reconciled.map((item) => item.path));
    if (dirtyPaths.every((path) => reconciledPaths.has(path))) {
      return { proceed: true, needsStashPop: false, reconciled };
    }

    const stashMessage = `ok-sync: pre-merge stash @ ${new Date().toISOString()}`;
    try {
      await handle.git.raw(['stash', 'push', '-m', stashMessage]);
    } catch (err) {
      log.warn({ err }, '[sync] stash push failed — proceeding without stash');
      return { proceed: true, needsStashPop: false, reconciled };
    }
    return { proceed: true, needsStashPop: true, reconciled };
  }

  private restoreReconciledMcpOverlays(reconciled: PreparedMcpReconciliation[]): boolean {
    let restored = true;
    for (const item of reconciled) {
      try {
        const absolutePath = join(this.projectDir, item.path);
        assertRealpathWithinDir(absolutePath, this.projectDir);
        let existing: string | null = null;
        try {
          existing = readFileSync(absolutePath, 'utf8');
        } catch (err) {
          log.warn(
            { err, path: item.path },
            '[sync] could not read MCP config before restoring reconciled overlay',
          );
        }
        if (existing !== item.raw) tracedWriteFileSync(absolutePath, item.raw, 'utf8');
      } catch (err) {
        restored = false;
        log.warn({ err, path: item.path }, '[sync] could not restore reconciled MCP overlay');
      }
    }
    return restored;
  }

  private async popPreMergeStash(handle: GitHandle): Promise<boolean> {
    try {
      await handle.git.raw(['stash', 'pop']);
      return true;
    } catch (err) {
      log.warn({ err }, '[sync] stash pop failed — stash remains on stack');
      return false;
    }
  }

  private hasGitOperationInProgress(): boolean {
    const gitDir = resolveGitDir(this.projectDir);
    if (!gitDir) return true;
    return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some(
      (marker) => existsSync(join(gitDir, marker)),
    );
  }

  private async persistReconciledMcpEntries(
    reconciled: PreparedMcpReconciliation[],
  ): Promise<void> {
    if (reconciled.length === 0) return;
    if (this.hasGitOperationInProgress()) {
      throw new Error('refusing MCP entry commit while a Git operation is in progress');
    }

    await withParentLock(async () => {
      const tmpIndex = join(tmpdir(), `ok-mcp-sync-idx-${process.pid}-${Date.now()}.idx`);
      const tempBlobs: string[] = [];
      try {
        const realHandle = this.gitHandle();
        const isolated = this.gitHandle(tmpIndex);
        const headSha = (await isolated.git.revparse('HEAD')).trim();
        const branch = (await isolated.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
        if (branch === 'HEAD') throw new Error('refusing MCP entry commit on detached HEAD');
        await isolated.git.raw(['read-tree', headSha]);

        const replayEntries: Array<{ path: string; mode: string; blobSha: string; raw: string }> =
          [];
        for (let i = 0; i < reconciled.length; i++) {
          const item = reconciled[i];
          if (!item) continue;
          const headRaw = await this.readMcpGitBlob(isolated, headSha, item.path);
          if (headRaw === null) throw new Error(`tracked MCP path disappeared: ${item.path}`);
          const commitRaw = applyManagedMcpEntry({
            target: item.path,
            raw: headRaw,
            entry: item.winnerEntry,
            tomlEditor: this.mcpTomlEditor,
          });
          if (commitRaw === null) throw new Error(`cannot edit tracked MCP path: ${item.path}`);

          const treeLine = await isolated.git.raw(['ls-tree', headSha, '--', item.path]);
          const mode = treeLine.match(/^(100644|100755)\s/)?.[1];
          if (!mode) throw new Error(`unsafe tracked MCP mode: ${item.path}`);

          const commitBlobPath = `${tmpIndex}.commit-${i}`;
          tempBlobs.push(commitBlobPath);
          writeFileSync(commitBlobPath, commitRaw, 'utf8');
          const commitBlobSha = (
            await isolated.git.raw(['hash-object', '-w', commitBlobPath])
          ).trim();
          await isolated.git.raw([
            'update-index',
            '--add',
            '--cacheinfo',
            `${mode},${commitBlobSha},${item.path}`,
          ]);

          const committedShell = getMcpUnownedShell({
            target: item.path,
            raw: commitRaw,
            tomlEditor: this.mcpTomlEditor,
          });
          const overlayShell = getMcpUnownedShell({
            target: item.path,
            raw: item.raw,
            tomlEditor: this.mcpTomlEditor,
          });
          const replayRaw =
            committedShell !== null && committedShell === overlayShell ? commitRaw : item.raw;
          const replayBlobPath = `${tmpIndex}.replay-${i}`;
          tempBlobs.push(replayBlobPath);
          writeFileSync(replayBlobPath, replayRaw, 'utf8');
          const replayBlobSha = (
            await isolated.git.raw(['hash-object', '-w', replayBlobPath])
          ).trim();
          replayEntries.push({ path: item.path, mode, blobSha: replayBlobSha, raw: replayRaw });
        }

        const newTree = (await isolated.git.raw(['write-tree'])).trim();
        const headTree = (await isolated.git.raw(['rev-parse', `${headSha}^{tree}`])).trim();
        if (newTree === headTree) return;

        await this.applyCommitIdentity(isolated);
        const commitSha = (
          await isolated.git.raw([
            'commit-tree',
            newTree,
            '-p',
            headSha,
            '-m',
            'Update OpenKnowledge MCP launcher',
          ])
        ).trim();
        if (!SHA_HEX_40.test(commitSha)) throw new Error('commit-tree returned an invalid SHA');
        try {
          await isolated.git.raw(['update-ref', `refs/heads/${branch}`, commitSha, headSha]);
        } catch (err) {
          log.info(
            { event: 'mcp-config-reconcile', outcome: 'ref-race', branch, err },
            '[sync] skipped MCP launcher commit because the branch moved',
          );
          return;
        }

        try {
          for (const replay of replayEntries) {
            await realHandle.git.raw([
              'update-index',
              '--add',
              '--cacheinfo',
              `${replay.mode},${replay.blobSha},${replay.path}`,
            ]);
            const absolutePath = join(this.projectDir, replay.path);
            assertRealpathWithinDir(absolutePath, this.projectDir);
            if (readFileSync(absolutePath, 'utf8') !== replay.raw) {
              tracedWriteFileSync(absolutePath, replay.raw, 'utf8');
            }
          }
        } catch (err) {
          log.warn(
            { event: 'mcp-config-reconcile', outcome: 'overlay-replay-failed', err },
            '[sync] MCP overlay replay failed; resetting the affected index entries',
          );
          await this.resetRealIndexForPaths(replayEntries.map((entry) => entry.path));
          this.restoreReconciledMcpOverlays(reconciled);
        }
        log.info(
          { event: 'mcp-config-reconcile', outcome: 'persisted-entry-commit' },
          '[sync] persisted OpenKnowledge MCP launcher entry commit',
        );
      } finally {
        for (const path of tempBlobs) {
          try {
            unlinkSync(path);
          } catch {}
        }
        try {
          unlinkSync(tmpIndex);
        } catch {}
      }
    });
  }

  /**
   * Stage content files into the handle's index, dropping ignored-AND-untracked
   * paths first. Content scope is broader than git scope: the content filter
   * admits `<folder>/.ok/templates/*.md` regardless of ignore state so templates
   * stay visible in the editor, but a local-only-sharing project excludes `.ok/`
   * in `.git/info/exclude`, and naming such a path in `git add` fatals with
   * `addIgnoredFile`, wedging every push cycle. Precedent #55 (walker and
   * `git add` agree on scope) is enforced here rather than in content admission.
   *
   * Tracked files are exempt from ignore rules and must keep syncing, but
   * `git add` (Apple git 2.39.5) still refuses a named path under an ignored
   * directory even when tracked — so paths carrying a `.ok/` segment (the only
   * carve-out shape content admission holds above git scope) are added with
   * `-f`. Everything else keeps the plain fail-loud `add`: if the probe and the
   * add ever disagree (a future git version, a `.gitattributes` edge), an
   * unexpected refusable path surfaces as an error instead of being silently
   * force-added. On probe failure, stage unfiltered WITHOUT `-f` and let the
   * old error surface.
   *
   * Call only after the caller's `read-tree` seed: against an empty index a
   * tracked-but-ignored file reads as refusable and its HEAD entry would be
   * committed as a deletion. Returns the staged files for deletion-set pairing.
   */
  private async stageContentFiles(
    handle: GitHandle,
    files: ContentFileEntry[],
  ): Promise<ContentFileEntry[]> {
    if (files.length === 0) return files;
    const BATCH = 100;
    const refused = new Set<string>();
    let probeOk = true;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH).map((f) => f.projectRelPath);
      try {
        const ignored = await listNames(handle.git, [
          'ls-files',
          '--others',
          '--ignored',
          '--exclude-standard',
          '--',
          ...batch,
        ]);
        for (const p of ignored) refused.add(p);
      } catch (err) {
        probeOk = false;
        log.warn({ err }, '[sync] ignored-path probe failed — staging unfiltered without -f');
      }
    }
    if (refused.size > 0) {
      log.info(
        { count: refused.size, sample: [...refused].slice(0, 5) },
        '[sync] skipping gitignored untracked path(s) — in content scope but excluded from git',
      );
    }
    const stageable = probeOk ? files.filter((f) => !refused.has(f.projectRelPath)) : files;
    const hasOkSegment = (p: string) => p.startsWith(`${OK_DIR}/`) || p.includes(`/${OK_DIR}/`);
    const forced = probeOk ? stageable.filter((f) => hasOkSegment(f.projectRelPath)) : [];
    const plain = probeOk ? stageable.filter((f) => !hasOkSegment(f.projectRelPath)) : stageable;
    for (const [addArgs, group] of [
      [['add', '--'], plain],
      [['add', '-f', '--'], forced],
    ] as const) {
      for (let i = 0; i < group.length; i += BATCH) {
        const batch = group.slice(i, i + BATCH).map((f) => f.projectRelPath);
        await handle.git.raw([...addArgs, ...batch]);
      }
    }
    return stageable;
  }

  private gatherContentFilesSync(): ContentFileEntry[] {
    const results: ContentFileEntry[] = [];
    const failUnreadableOkSubtree = (err: unknown, dir: string) => {
      const relDir = toPosix(relative(this.projectDir, dir)) || '.';
      throw new ShareableOkEnumerationError(relDir, err);
    };

    const walk = (
      dir: string,
      filterBase: string,
      stagingScope: SyncStagingScope,
      onError?: (err: unknown, dir: string) => void,
    ) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        onError?.(err, dir);
        return;
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const dirRelPath = toPosix(relative(filterBase, fullPath));
          if (
            !dirRelPath.startsWith('..') &&
            this.contentFilter.isDirExcluded(dirRelPath, stagingScope)
          )
            continue;
          const entersOkSubtree = dirRelPath
            .split('/')
            .some((segment) => segment.toLowerCase() === OK_DIR);
          walk(
            fullPath,
            filterBase,
            stagingScope,
            onError ?? (entersOkSubtree ? failUnreadableOkSubtree : undefined),
          );
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          const filterRelPath = toPosix(relative(filterBase, fullPath));
          if (
            !filterRelPath.startsWith('..') &&
            !this.contentFilter.isExcluded(filterRelPath, stagingScope)
          ) {
            const contentRelPath = toPosix(relative(this.contentDir, fullPath));
            const projectRelPath = toPosix(relative(this.projectDir, fullPath));
            results.push({ contentRelPath, projectRelPath });
          }
        }
      }
    };

    if (existsSync(this.contentDir)) {
      walk(this.contentDir, this.contentDir, CONTENT_SYNC_STAGING_SCOPE);
    }
    if (this.rootOkOutsideContentWalk) {
      const rootOkDir = join(this.projectDir, OK_DIR);
      if (
        existsSync(rootOkDir) &&
        !this.contentFilter.isDirExcluded(OK_DIR, PROJECT_SYNC_STAGING_SCOPE)
      ) {
        walk(rootOkDir, this.projectDir, PROJECT_SYNC_STAGING_SCOPE, failUnreadableOkSubtree);
      }
    }
    return results;
  }

  /**
   * Whether a project-relative path is inside the set this engine will commit.
   *
   * The staging walk, HEAD deletion tracking, and the working-tree status
   * surface must all answer this identically — a path one admits and another
   * refuses is precedent #55's failure mode (a HEAD path the gather walk
   * refuses gets committed as a spurious deletion every cycle). Public because
   * the status endpoint marks out-of-scope paths in the UI, and a second
   * predicate for that marking would be free to drift.
   */
  isSyncScopedPath(projRelPath: string): boolean {
    const absPath = join(this.projectDir, projRelPath);
    const contentRelPath = toPosix(relative(this.contentDir, absPath));
    const inContentWalk =
      !contentRelPath.startsWith('..') &&
      !this.contentFilter.isExcluded(contentRelPath, CONTENT_SYNC_STAGING_SCOPE);
    const inRootOkWalk =
      this.rootOkOutsideContentWalk &&
      projRelPath.startsWith(`${OK_DIR}/`) &&
      !this.contentFilter.isExcluded(projRelPath, PROJECT_SYNC_STAGING_SCOPE);
    return inContentWalk || inRootOkWalk;
  }

  private async listHeadContentPaths(handle: GitHandle, headSha: string): Promise<Set<string>> {
    const paths = new Set<string>();
    try {
      const headPaths = await listNames(handle.git, ['ls-tree', '-r', '--name-only', headSha]);
      for (const projRelPath of headPaths) {
        if (this.isSyncScopedPath(projRelPath)) {
          paths.add(projRelPath);
        }
      }
    } catch {}
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
      } catch {}
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
      conflictedFiles = await listNames(handle.git, ['diff', '--name-only', '--diff-filter=U']);
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
      if (this.isContentConflictPath(file)) {
        contentConflicts.push(file);
      } else {
        nonContentConflicts.push(file);
      }
    }

    const nonContentResolveFailures: Array<{ file: string; err: unknown }> = [];
    const projectConfigRelPath = toPosix(
      relative(this.projectDir, resolveConfigPath('project', this.projectDir)),
    );
    for (const file of nonContentConflicts) {
      try {
        await handle.git.raw(['checkout', '--theirs', '--', file]);
        await handle.git.raw(['add', '--', file]);
        if (file.toLowerCase() === projectConfigRelPath.toLowerCase()) {
          log.warn(
            { file },
            '[sync] auto-resolved .ok/config.yml conflict with theirs: local project config edits were overwritten by the remote version',
          );
        } else {
          log.info({ file }, '[sync] auto-resolved non-content conflict with theirs');
        }
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
      this.consecutivePullFailures = 0;
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
      let committed = false;
      try {
        await this.applyCommitIdentity(handle);
        await handle.git.raw(['commit', '--no-edit']);
        const gitDir = resolveGitDir(this.projectDir);
        committed = gitDir === null || !existsSync(join(gitDir, 'MERGE_HEAD'));
      } catch (e) {
        log.warn({ err: e }, '[sync] failed to commit after auto-resolving conflicts');
      }
      if (committed) {
        this.lastSyncUtc = new Date().toISOString();
        this.behind = 0;
        this.transitionTo('idle');
        log.info({}, '[sync] all conflicts auto-resolved — merge committed');
      } else {
        try {
          await handle.git.raw(['merge', '--abort']);
        } catch (abortErr) {
          log.warn({ err: abortErr }, '[sync] git merge --abort failed during cleanup');
        }
        this.pullError = 'Sync paused — could not finalize the merge. Retry sync to try again.';
        this.transitionTo('idle');
        log.warn(
          {},
          '[sync] could not finalize merge after auto-resolving conflicts — merge aborted',
        );
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

  private async notifyContentConflictsResolved(files: string[]): Promise<void> {
    if (files.length === 0) return;
    try {
      await this.onContentConflictsResolved?.(files);
    } catch (err) {
      log.warn({ err, files }, '[sync] content conflict resolved callback failed');
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
      this.ghAccountResolver.invalidate();
      this.transitionTo('auth-error');
      this.pausedReason = 'auth-error';
    } else if (classified.class === 'semantic' && classified.subclass === 'protected-branch') {
      this.mode = 'off';
      this.transitionTo('disabled');
      this.pausedReason = 'protected-branch';
      void this.onAutoDisable?.('protected-branch');
    } else if (classified.class === 'local' && classified.subclass === 'dirty-tree') {
      this.bumpFailureCount(op);
      this.transitionTo('idle');
      this.pausedReason = 'dirty-tree';
      this.schedulePush(0);
    } else if (classified.retryable) {
      this.bumpFailureCount(op, isFetchDisprovableFailure(classified));
      this.transitionTo('offline');
    } else {
      this.bumpFailureCount(op);
      this.transitionTo('idle');
    }
  }

  private currentState(): SyncState {
    return this.state;
  }

  private markRun(): void {
    this.lastPushOkUtc = new Date().toISOString();
    this.cc1Broadcaster?.signal('sync-status');
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
    if (this.stateSaveTimer !== null) return;
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
        lastPullOkUtc: this.lastPullOkUtc,
        lastPushOkUtc: this.lastPushOkUtc,
        lastFetchUtc: this.lastFetchUtc,
        lastPushedSha: this.lastPushedSha,
        consecutiveFailures: this.consecutivePullFailures,
        consecutivePushFailures: this.consecutivePushFailures,
        pushStreakIsConnectivity: this.pushStreakIsConnectivity,
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
      this.lastPullOkUtc = data.lastPullOkUtc ?? null;
      this.lastPushOkUtc = data.lastPushOkUtc ?? null;
      this.lastFetchUtc = data.lastFetchUtc ?? null;
      this.lastPushedSha = data.lastPushedSha ?? null;
      this.consecutivePullFailures = data.consecutiveFailures ?? 0;
      this.consecutivePushFailures = data.consecutivePushFailures ?? 0;
      this.pushStreakIsConnectivity = data.pushStreakIsConnectivity ?? false;
      this.pausedReason =
        data.pausedReason === 'no-push-permission' ||
        data.pausedReason === 'auth-error' ||
        data.pausedReason === 'external-changes-pending'
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
