/**
 * SyncEngine — background fetch/merge/push with typed state machine.
 *
 * Surface: core state machine + remote detection + lifecycle, pull cycle
 * (fetch + merge + timers + backoff), push cycle (squash-before-push +
 * content-scope), conflict + error handling integration, state persistence
 * + restart recovery.
 */

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
import { listNames } from './git-paths.ts';
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

/**
 * Git SHA-1 object IDs are 40 lowercase hex chars. `commit-tree` and similar
 * plumbing can emit error text on stdout under failure modes (e.g. corrupt
 * objects, disk full) — a non-empty truthy string is not enough to trust as a
 * ref value, so we pattern-match before feeding it to `update-ref`.
 */
const SHA_HEX_40 = /^[0-9a-f]{40}$/i;

/**
 * Host the relayed gh token authenticates. The origin parser (`git-context.ts`)
 * is GitHub-only — a GHES or non-github remote classifies as `non-github` and
 * never reaches the credential paths — so the sync engine only ever
 * authenticates against github.com.
 */
const SYNC_GH_TOKEN_HOST = 'github.com';

// ─── Types ───────────────────────────────────────────────────────────────────

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

/**
 * Push-permission probe outcome the sync UI branches on. Flat shape (single
 * discriminator `checkStatus`) so the renderer can switch without runtime
 * narrowing of the underlying tagged union. Wire schema lives in
 * `packages/core/src/schemas/api/sync-seed.ts` as `PushPermissionSchema`.
 */
/**
 * Discriminated union — `checkStatus` tag determines which payload fields
 * are present. The earlier flat shape allowed illegal combinations
 * (e.g., `{ checkStatus: 'denied' }` with no `deniedReason`, or
 * `{ checkStatus: 'allowed', deniedReason: 'no-collaborator' }`); the
 * union makes both type-impossible. Mirrors the source-of-truth
 * `PushPermission` shape in `github-permissions.ts`.
 */
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

/** Flatten the tagged `PushPermission` from `github-permissions.ts` to wire shape. */
function pushPermissionStatusFrom(p: PushPermission): PushPermissionStatus {
  if (p.kind === 'allowed') return { checkStatus: 'allowed' };
  if (p.kind === 'denied') return { checkStatus: 'denied', deniedReason: p.reason };
  return { checkStatus: 'unknown', unknownError: p.error };
}

/** Structural equality on flattened push-permission status. */
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
  // 'allowed' has no payload to compare; equality is the tag match above.
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
  /** True when a git remote exists, even if sync is dormant/disabled. */
  hasRemote: boolean;
  /** User's sync toggle preference. False by default (disabled for safety). */
  syncEnabled: boolean;
  /**
   * Soft signal: `resolveGitIdentity()` returned null on the last probe.
   * The push cycle still commits under the "OpenKnowledge" default — this flag
   * tells the UI to surface a non-blocking nudge to set a real identity.
   */
  identityUnresolved: boolean;
  /** Origin remote resolved for display; null when no remote is configured. */
  remote: SyncRemoteInfo | null;
  /**
   * Errors are tracked per direction so a success on one leg never clears the
   * other's error. A failed push followed by a successful fetch (public repo,
   * or any read-allowed/write-denied remote) must keep the push error visible
   * instead of flashing it for the gap between the two broadcasts.
   *
   * `push*` = sending local commits out; `pull*` = bringing remote changes in
   * (fetch + merge). Each pairs a developer-facing `*Error` message with an
   * optional bounded `*ErrorCode`: at most one of the pair carries content per
   * direction (code wins at render; else fall back to the raw message).
   */
  pushError?: string;
  pushErrorCode?: UserFacingErrorCode;
  pullError?: string;
  pullErrorCode?: UserFacingErrorCode;
  pausedReason?: string;
  /**
   * Push-permission probe outcome. Absent when the engine hasn't reached a
   * `hasRemote === true` decision yet, or when the remote is not a github.com
   * origin (the probe only runs against github.com). UI consumers treat
   * absent as "no gate" and render current behavior.
   */
  pushPermission?: PushPermissionStatus;
}

/** A single content-scoped file entry used during push-cycle tree building. */
interface ContentFileEntry {
  /** Path relative to contentDir — used for commit messages. */
  contentRelPath: string;
  /** Path relative to projectDir (git root) — used for git add/rm commands. */
  projectRelPath: string;
}

/** Persisted state (sync-state.json). */
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
  /** Seconds between pull cycles. Default 30. */
  pullIntervalSeconds?: number;
  /** Seconds between push cycles. Default 60. */
  pushIntervalSeconds?: number;
  /** Whether sync is enabled according to project config. Undefined is treated as disabled. */
  syncEnabled?: boolean;
  /** Credential args for simple-git (e.g. ['-c', 'credential.helper=…']). */
  credentialArgs?: string[];
  /** CC1 broadcaster for sync-status channel signals. */
  cc1Broadcaster?: CC1Broadcaster | null;
  /** Called on every state transition. */
  onStateChange?: (state: SyncState) => void;
  /**
   * Called after SyncEngine records content conflicts in ConflictStore.
   * The server uses this to mark already-loaded Y.Docs as conflicted.
   */
  onContentConflictsDetected?: (files: string[]) => void | Promise<void>;
  /** Callback to gate batch-in-progress during merge operations.
   *  Prevents HEAD watcher from firing reconciliation mid-merge. */
  setBatchInProgress?: (value: boolean) => void;
  /**
   * Fires when the engine auto-disables itself due to an unrecoverable error
   * (currently only `protected-branch`). The caller is expected to persist
   * `autoSync.enabled = false` to project-local config so the disable survives
   * restart and the SettingsPane toggle reflects reality. Without this,
   * boot would re-read `enabled: true` from config and re-trigger the same
   * push failure on every restart.
   */
  onAutoDisable?: (reason: 'protected-branch') => void | Promise<void>;
  /**
   * Tier A token detector. Honors the existing three-tier model (see
   * `packages/cli/src/auth/resolve-auth.ts`) without `packages/server`
   * importing from `packages/cli` (would be a package cycle).
   *
   * Omit when no auth source is wired (tests, headless boot) — the probe
   * falls through to Tier B/C or anonymous.
   */
  detectGh?: DetectGhFn;
  /**
   * Tier B/C credential store, structurally compatible with cli's `TokenStore`.
   * Omit when no auth source is wired.
   */
  tokenStore?: ProbeTokenStore | null;
  /**
   * Probe implementation. Defaults to the real `checkPushPermission` from
   * `github-permissions.ts`. Tests inject fakes to bypass the network.
   */
  checkPushPermissionFn?: (opts: CheckPushPermissionOptions) => Promise<PushPermission>;
}

// ─── Jitter helper ───────────────────────────────────────────────────────────

/** Apply ±15% jitter to a seconds interval, returning ms. */
function jitteredMs(seconds: number): number {
  const base = seconds * 1000;
  const jitter = base * 0.15 * (2 * Math.random() - 1); // ±15%
  return Math.round(base + jitter);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the project repo has an unborn HEAD (git init with no
 * commits yet). Checks both loose refs (`.git/refs/heads/<branch>`) and
 * packed refs (`.git/packed-refs`) to avoid misclassifying a fully-committed
 * repo whose refs happen to be packed.
 */
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

// ─── Backoff thresholds ──────────────────────────────────────────────────────

function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures >= 8) return 60 * 60 * 1000; // 60 min
  if (consecutiveFailures >= 5) return 15 * 60 * 1000; // 15 min
  if (consecutiveFailures >= 3) return 5 * 60 * 1000; // 5 min
  return 0; // use normal interval
}

// ─── SyncEngine ──────────────────────────────────────────────────────────────

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
  /**
   * Resolves + caches the gh token relayed to the credential helper so sync
   * authenticates via the same source clone does (gh-first). Built from the
   * injected `detectGh`; returns null throughout when gh is unavailable.
   */
  private ghTokenSource: GhTokenSource;
  private tokenStore: ProbeTokenStore | null | undefined;
  private checkPushPermissionFn: (opts: CheckPushPermissionOptions) => Promise<PushPermission>;
  /**
   * Push-permission status. `null` until the engine has resolved one probe
   * (or determined the probe should not run for this remote). Updated by
   * `start()` post-`hasRemote` and by `refreshPushPermission()`. Never
   * persisted — the probe result is in-memory only; GitHub permission state
   * can change at any time and a stale denial would lock the user out after
   * their access is granted.
   */
  private pushPermission: PushPermissionStatus | null = null;
  /** Prevents concurrent probes — strict one-call-per-session contract. */
  private pushPermissionProbeInFlight = false;

  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private stateSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Runtime state
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

  // Concurrency guard: only one operation at a time
  private pullInFlight = false;
  private pushInFlight = false;

  /** True once a git remote has been confirmed present. */
  private hasRemote = false;

  /** Latest known state of the identity chain (null-return on resolveGitIdentity). */
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
    // ConflictStore branch is set lazily in start() after branch detection.
    // Use a placeholder here; setBranch() updates it before any conflict operations.
    this.conflictStore = new ConflictStore(this.projectDir, this.currentBranch);
  }

  /**
   * Single construction point for every git handle the engine spawns. Threads
   * the credential args plus the cached gh token (host-scoped to github.com) so
   * fetch/push authenticate via gh when available. Local-only handles (e.g.
   * `remote -v`, `merge --abort`) carry the token harmlessly — the cache keeps
   * resolution to at most one `gh` spawn per minute regardless of handle count.
   */
  private gitHandle(gitIndexFile?: string): GitHandle {
    return createGitInstance(this.projectDir, {
      credentialArgs: this.credentialArgs,
      gitIndexFile,
      ghToken: this.ghTokenSource.get(SYNC_GH_TOKEN_HOST) ?? undefined,
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.state !== 'dormant') return;

    // Restore runtime status. The enabled/disabled preference comes from
    // project config and is passed via constructor options.
    this.loadState();

    // Detect remote + branch regardless of enabled state so status is accurate.
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
        // detached HEAD — will pause when push/pull fires
      }
    } catch (e) {
      log.warn({ err: e }, '[sync] remote detection failed');
    }

    // Push-permission probe. Kicked off non-blocking after remote
    // detection so an offline/slow GitHub doesn't delay sync start.
    // The probe self-pauses sync in-memory when it resolves `denied`
    // and the user already had autoSync enabled. Probe is a no-op when
    // !hasRemote or origin is not a github.com URL.
    if (hasRemote) {
      void this.probePushPermissionInternal('start');
    }

    // Disabled by default: sync only runs when the user has explicitly opted in.
    // Protects real git repos (production code) from being mutated automatically.
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

    // Reconcile persisted conflict state against git's view. The user may
    // have resolved (or aborted) the merge externally between server runs,
    // so conflicts.json can be stale — git is the source of truth.
    // Linked-worktree safety: resolve the real gitdir (the worktree's
    // `<repo>/.git/worktrees/<name>/` dir, not the literal
    // `<projectDir>/.git`) so MERGE_HEAD probes work in main + linked.
    const gitDir = resolveGitDir(this.projectDir);
    const mergeHeadPath = gitDir ? join(gitDir, 'MERGE_HEAD') : null;
    const mergeInProgress = mergeHeadPath !== null && existsSync(mergeHeadPath);

    if (this.conflictCount > 0 && !mergeInProgress) {
      // Tracked conflicts but no merge in progress → fully resolved externally.
      log.warn(
        { count: this.conflictCount },
        '[sync] persisted conflicts but no MERGE_HEAD — clearing stale state',
      );
      this.conflictStore.clear();
      this.conflictCount = 0;
    } else if (this.conflictCount > 0 && mergeInProgress) {
      // Merge still in progress — drop any tracked entries git considers resolved.
      try {
        const handle = this.gitHandle();
        const stillUnmerged = new Set(
          await listNames(handle.git, ['diff', '--name-only', '--diff-filter=U']),
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

    // Clean up stale merge state: if MERGE_HEAD exists but no conflicts are tracked,
    // a previous crash left the repo in a half-merged state — abort to recover.
    if (mergeInProgress && this.conflictCount === 0) {
      log.warn({}, '[sync] stale MERGE_HEAD detected with no tracked conflicts — aborting merge');
      try {
        const handle = this.gitHandle();
        await handle.git.raw(['merge', '--abort']);
      } catch (e) {
        log.warn({ err: e }, '[sync] git merge --abort for stale MERGE_HEAD failed');
      }
    }

    // If we restored in-flight conflicts, re-enter conflict state (timers paused)
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

    // Schedule with restart-aware remaining delay (FR: max(0, lastFetchUtc+interval - now))
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

  // ─── User-controlled enable/disable ────────────────────────────────────────

  /**
   * Toggle sync on/off. Soft disable — cancels scheduled cycles but lets an
   * in-flight pull/push finish cleanly to avoid leaving a partial merge.
   * The caller persists the preference to project config; sync-state.json only
   * records runtime status/history.
   */
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
      // Drain in-flight cycles so disable is observed before the next cycle
      // mutates state. Cap the wait so a wedged pull/push (hung network,
      // unresponsive remote) can't hold the toggle forever — disable will
      // still land in-memory; the stuck cycle logs its own outcome when it
      // eventually resolves.
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

    // Re-detect remote in case it was added (or removed) while sync was off.
    // Unconditional — unlike refreshRemote() this handles both directions, so
    // toggling sync on against an externally-removed remote correctly demotes
    // to dormant instead of incorrectly transitioning to idle.
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
    // Re-check push permission so the engine state and the probe state stay
    // consistent. Without this, a stale `denied` probe from a prior session
    // would let setEnabled push the engine to 'idle' + schedule sync cycles
    // that hit a 403. Matches the pattern in `trigger()`.
    void this.probePushPermissionInternal('refresh');
  }

  // ─── Credential change (reconnect) ──────────────────────────────────────────

  /**
   * Resume sync after the GitHub credential changed (a reconnect / fresh login).
   *
   * The credential helper reads the token at git-invocation time, so a newly
   * stored token is picked up on the next cycle — but the engine parks in
   * `auth-error`, where both sync cycles early-return, so the engine makes no
   * useful progress while parked until something clears the state. `trigger()`
   * deliberately does NOT clear `auth-error` (retrying with the same missing
   * credential just fails again), and `setEnabled(true)` requires toggling sync
   * off first. This is the dedicated recovery entry point: the auth-login
   * success handler calls it so a reconnect resumes sync without a restart.
   * No-op unless currently parked on an auth error, so a credential change
   * during healthy operation is cheap.
   */
  async notifyCredentialsChanged(): Promise<void> {
    if (!this.syncEnabled) return;

    // A credential change is precisely when any cached gh token is stale (the
    // user just signed in / switched accounts). Drop it BEFORE the auth-error
    // gate below so an account switch during HEALTHY sync is picked up on the
    // next already-scheduled cycle, not left stale until the TTL expires. The
    // resume logic below still only runs when parked on an auth error.
    this.ghTokenSource.invalidate();

    if (this.state !== 'auth-error' && this.pausedReason !== 'auth-error') return;

    this.pausedReason = undefined;
    this.clearPushError();
    this.clearPullError();
    this.consecutiveFailures = 0;

    // Remote may have changed while the user was signed out; re-detect so we
    // demote to dormant rather than scheduling cycles against no remote.
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

  // ─── Manual trigger ────────────────────────────────────────────────────────

  /** Trigger an immediate pull + push cycle (bypasses backoff, resets consecutiveFailures). */
  async trigger(op: 'sync' | 'push' | 'pull' = 'sync'): Promise<void> {
    this.consecutiveFailures = 0;
    // Retry clears transient paused reasons; protected-branch etc. stay set.
    if (
      this.pausedReason === 'dirty-tree' ||
      this.pausedReason === 'external-changes-pending' ||
      this.pausedReason === 'non-content-merge-failure'
    ) {
      this.pausedReason = undefined;
      this.clearPullError();
    }
    // Manual sync is one of the documented refresh triggers for the
    // push-permission probe (auth-state change, manual sync, project
    // re-open). Fire-and-forget — never blocks the trigger() caller. If
    // the probe newly resolves `allowed` for a previously-denied user,
    // the engine clears `no-push-permission` and returns to idle before
    // the sync cycle runs.
    //
    // The probe-resolves-`denied`-mid-cycle race is benign: the cycle has
    // already passed the `state !== 'idle'` early-return and will attempt
    // the push, getting a 403 the user sees in `status.pushError`. That's the
    // same UX the user would have hit on push failure regardless. Don't
    // await this probe — doubling the latency of every manual sync to
    // close a single-cycle race isn't worth it.
    void this.probePushPermissionInternal('refresh');
    // Log why a trigger is a no-op so "Sync now returns OK but nothing happens"
    // is diagnosable from the server terminal. The cycle guards silently
    // early-return in these states; surface them here.
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
      // Push first so pending working-tree edits get committed via the
      // isolated-index path. A subsequent merge then has a clean tree
      // instead of refusing with "working tree has uncommitted changes".
      await this.runPushCycle();
      await this.runPullCycle();
    }
  }

  // ─── Status ────────────────────────────────────────────────────────────────

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
      // Resolve the origin label/URL only when a remote exists — keeps the
      // common no-remote dormant path free of `.git/config` reads.
      remote: this.hasRemote ? readSyncRemoteInfo(this.projectDir) : null,
      ...(this.pushError !== undefined ? { pushError: this.pushError } : {}),
      ...(this.pushErrorCode !== undefined ? { pushErrorCode: this.pushErrorCode } : {}),
      ...(this.pullError !== undefined ? { pullError: this.pullError } : {}),
      ...(this.pullErrorCode !== undefined ? { pullErrorCode: this.pullErrorCode } : {}),
      pausedReason: this.pausedReason,
      ...(this.pushPermission !== null ? { pushPermission: this.pushPermission } : {}),
    };
  }

  /**
   * Re-run the push-permission probe. Public for callers that observe an
   * auth-state change (e.g. set-identity, manual sync trigger) and want the
   * UI to reflect the new permission without waiting on the next session.
   *
   * Returns the resolved status when the probe ran, or `null` when it was
   * skipped (no remote, non-github origin, or a concurrent probe is already
   * in flight — see `pushPermissionProbeInFlight`). Never throws.
   */
  async refreshPushPermission(): Promise<PushPermissionStatus | null> {
    return this.probePushPermissionInternal('refresh');
  }

  /**
   * Re-run the identity chain and broadcast if the unresolved flag
   * changed. Called from the set-identity endpoint so the UI nudge clears
   * immediately instead of waiting for the next push cycle.
   */
  async refreshIdentity(): Promise<void> {
    const identity = await resolveGitIdentity(this.projectDir);
    const next = identity === null;
    if (this.identityUnresolved !== next) {
      this.identityUnresolved = next;
      this.cc1Broadcaster?.signal('sync-status');
    }
  }

  /**
   * Drive the push-permission probe and apply its consequences:
   *   - record the result in `this.pushPermission`
   *   - when `denied` AND the user previously enabled sync, pause the
   *     engine in-memory via `pausedReason='no-push-permission'` (no
   *     persistent `__local__/project` write — probe result + pause are
   *     in-memory only).
   *   - broadcast `sync-status` so the frontend re-renders
   *
   * `caller` is informational only (logging). The method is safe to invoke
   * before remote detection (no-op) and from concurrent paths (in-flight
   * guard prevents N parallel calls).
   */
  private async probePushPermissionInternal(
    caller: 'start' | 'refresh',
  ): Promise<PushPermissionStatus | null> {
    // Three "skip the probe" paths collapse to a single `null` return value.
    // Callers (`start`, `setEnabled(true)`, `trigger`) discard the return
    // anyway — they don't differentiate "no remote" from "already running"
    // from "non-GH origin." If a future "Re-check now" UI button needs to
    // distinguish (e.g., spinner during in-flight vs gray-out when no remote),
    // widen the return type to a discriminated union here.
    if (!this.hasRemote) return null;
    if (this.pushPermissionProbeInFlight) return null;

    const origin = readOriginGitHubRepo(this.projectDir);
    if (origin.kind !== 'ok') {
      // Non-github origin (gitlab, self-hosted, ssh-only without a parseable
      // form) or no remote URL configured — the GitHub-only probe cannot
      // run. Emit `{ checkStatus: 'unknown' }` so the UI sees `pushPermission`
      // populated (not undefined) and the AutoSync onboarding gate's
      // probe-resolved guard passes. Without this, the gate would block
      // non-GitHub users from the onboarding dialog forever (probe never
      // resolves → pushPermission stays undefined → gate fails). `'unknown'`
      // is honest semantically — we don't know whether they can push — and
      // it composes correctly with every downstream consumer: the popover's
      // `shouldOfferSignInAgain` won't fire (needs `'token-invalid'`),
      // `shouldDisableSyncSwitch` won't fire (needs `'denied'`), and the
      // onboarding gate accepts it.
      const next: PushPermissionStatus = { checkStatus: 'unknown' };
      const prev = this.pushPermission;
      this.pushPermission = next;
      if (!pushPermissionStatusEqual(prev, next)) {
        this.cc1Broadcaster?.signal('sync-status');
      }
      return next;
    }

    this.pushPermissionProbeInFlight = true;
    // Owner + repo deliberately excluded — they're unbounded-cardinality
    // attributes that would inflate downstream log indices if pino is ever
    // bridged into the OTLP pipeline (pino-opentelemetry-transport).
    // Matches the sibling cardinality discipline in github-permissions.ts.
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
      // checkPushPermission already swallows network failures into an
      // `unknown` variant — this catch is defense-in-depth in case an
      // injected fake throws.
      log.warn({ err, caller }, '[sync] push-permission probe threw — recording unknown/network');
      outcome = { kind: 'unknown', error: 'network' };
    } finally {
      this.pushPermissionProbeInFlight = false;
    }

    const next = pushPermissionStatusFrom(outcome);
    const prev = this.pushPermission;
    this.pushPermission = next;

    // If the user already has sync enabled and the probe says denied, pause
    // the engine in-memory. Mirrors the existing pausedReason precedent
    // ('detached-head', 'protected-branch', ...) — no disk write. The
    // persistent-write alternative was rejected at spec time because it
    // would silently mutate the user's preference and create a migration
    // burden when continued read-only fetch eventually lands.
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
      // Permission was granted after a prior denied probe — clear the pause.
      // Two restart-survival cases the disabled-state gate previously missed:
      //
      //   (a) Engine was `disabled` (probe denied + sync enabled) → transition
      //       back to `idle` so the UI resumes.
      //   (b) Engine reached `idle` independently (e.g. `start()` re-init that
      //       loaded a stale reason from a pre-filter state file, or a parallel
      //       re-init that flipped state without re-running this probe path)
      //       but still carries `pausedReason='no-push-permission'`. Just
      //       clear the reason; no transition needed because state is
      //       already correct.
      //
      // Either way, `transitioned = true` triggers the CC1 broadcast so the
      // popover + settings drop the disabled-with-reason copy immediately.
      this.pausedReason = undefined;
      if (this.state === 'disabled' && this.syncEnabled === true) {
        this.transitionTo('idle');
      }
      transitioned = true;
      log.info({ caller, priorState: this.state }, '[sync] push permission restored');
    }

    if (!transitioned && !pushPermissionStatusEqual(prev, next)) {
      // No state change but the payload diff matters to the UI (e.g. unknown
      // → allowed). transitionTo already broadcasts when it fires; broadcast
      // here only when it didn't.
      this.cc1Broadcaster?.signal('sync-status');
    }

    return next;
  }

  /**
   * Lazy re-detection of `git remote -v` for the dormant case. `start()`
   * snapshots `hasRemote` once at boot; without this hook, a user who runs
   * `git remote add origin <url>` after the server is up keeps seeing the
   * stale "no remote" empty state in Settings → Sync until the app restarts.
   *
   * No-op once a remote has been observed (the only useful transition is
   * false → true; remote removal is rare and resolves on next restart). The
   * gating in `handleSyncStatus` already skips the git invocation on the hot
   * path where sync is running.
   */
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

  /**
   * Run `git remote -v` once and report whether at least one remote is
   * configured. Returns false on missing `.git/` or any git failure (the
   * caller decides what to do; this never throws). Suppresses the subprocess
   * + warn when `.git/` is absent — the common pre-`git init` case would
   * otherwise log on every status poll.
   *
   * Shared by `refreshRemote()` (lazy probe, gated on `!hasRemote`) and
   * `setEnabled(true)` (unconditional re-check after sync was toggled off
   * and back on). `start()` keeps its own inline detection so it can reuse
   * the git handle for the immediately-following branch probe.
   */
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

  /** Return all current conflict entries. */
  getConflicts(): import('./conflict-storage.ts').ConflictEntry[] {
    return this.conflictStore.list();
  }

  /**
   * Reconcile in-memory conflict state against git's source of truth.
   * Public entry point for the HEAD watcher's batch-end callback so external
   * git operations — `git merge --abort`, manual `git checkout --ours/
   * --theirs && git add && git commit`, etc. — flow into the UI without
   * waiting for the next pull cycle.
   *
   *   - No MERGE_HEAD: every tracked entry is stale; clear the store.
   *   - MERGE_HEAD present: prune entries `git diff --diff-filter=U` no
   *     longer reports as unmerged.
   *
   * Emits `sync-status` via CC1 when the count changes so the sidebar
   * Conflicts list and topbar badge refresh; transitions out of the
   * `conflict` state when the last entry clears.
   */
  async reconcileConflictsFromGit(): Promise<void> {
    if (this.conflictCount === 0) return;
    const before = this.conflictCount;
    // Linked-worktree safety (see `start()`): use the resolved gitdir.
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
        const stillUnmerged = new Set(
          await listNames(handle.git, ['diff', '--name-only', '--diff-filter=U']),
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

  /**
   * Resolve a conflict by file path and strategy.
   * Delegates to ConflictStore.resolveConflict.
   */
  async resolveConflict(
    file: string,
    strategy: import('./conflict-storage.ts').ResolveStrategy,
    content?: string,
  ): Promise<void> {
    // Mirror the pull-cycle batch pattern: git checkout/add/commit emit a
    // burst of fs events; buffering and draining them under
    // setBatchInProgress keeps the file-watcher's case 'update' from
    // racing the API response, and the false-edge callback in
    // server-factory.ts flushes deferred persistence so the resolved
    // bytes land before the next sync cycle observes the state.
    this.setBatchInProgress?.(true);
    try {
      try {
        await this.conflictStore.resolveConflict(file, strategy, content);
      } catch (e) {
        // ConflictStore.resolveConflict throws on `git commit --no-edit`
        // failure AFTER re-adding the still-unmerged files. Re-sync our
        // cached count from the store before rethrowing so the next
        // /api/sync/status returns the true conflict count — otherwise
        // `conflictCount === 0` from the optimistic line below (which
        // never ran) would lie to the UI until the next pull cycle
        // refreshes it.
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
        // Partial resolution: state stays `conflict`, but conflictCount
        // dropped (e.g. 3 → 2). `transitionTo` is the only other site
        // that fires the CC1 signal — without an explicit emit here,
        // the sidebar Conflicts list and topbar conflictCount stay
        // stale until the next state transition (next sync cycle).
        this.cc1Broadcaster?.signal('sync-status');
      }
      this.scheduleSaveState();
    } finally {
      this.setBatchInProgress?.(false);
    }
  }

  /** Update the current branch (called by head-watcher callbacks). */
  updateCurrentBranch(branch: string | null): void {
    if (branch === null) {
      // Detached HEAD
      if (this.state !== 'dormant' && this.state !== 'disabled') {
        this.transitionTo('disabled');
        this.pausedReason = 'detached-head';
        this.scheduleSaveState();
      }
    } else if (this.currentBranch !== branch) {
      this.currentBranch = branch;
      this.conflictStore.setBranch(branch);
      // Resume from detached if paused for that reason
      if (this.state === 'disabled' && this.pausedReason === 'detached-head') {
        this.pausedReason = undefined;
        this.transitionTo('idle');
        this.schedulePull();
        this.schedulePush();
      }
    }
  }

  // ─── Scheduling ────────────────────────────────────────────────────────────

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

  // ─── Pull cycle ────────────────────────────────────────────────────────────

  private async runPullCycle(): Promise<void> {
    if (this.pullInFlight) return;
    // `auth-error` mirrors the push-cycle guard below. Auth errors are
    // non-retryable and don't increment `consecutiveFailures`, so without this
    // an authless fetch would re-park in `auth-error` and reschedule at the
    // base interval forever — a steady busy-loop with no backoff (and, since
    // each fetch invokes the credential helper, a recurring credential-miss
    // log line). The engine resumes via `notifyCredentialsChanged()` instead.
    if (this.state === 'dormant' || this.state === 'disabled' || this.state === 'auth-error')
      return;
    if (this.state === 'conflict') {
      this.schedulePull(); // retry after interval but don't fetch while conflicted
      return;
    }
    // Skip cleanly if the project repo has no commits yet — nothing to pull
    // against and `rev-parse HEAD` would otherwise throw an ambiguous-argument
    // error that's classified as a generic unknown-local failure.
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

    // Detached HEAD check
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

    // Fetch
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

    // Check ahead/behind
    try {
      const status = await handle.git.status();
      this.ahead = status.ahead;
      this.behind = status.behind;
    } catch {
      // Non-fatal — continue with previous counts
    }

    // Merge if behind and no unresolved conflicts
    if (this.behind > 0 && this.conflictCount === 0) {
      this.transitionTo('pulling');
      // Gate batch to suppress HEAD watcher reconciliation during SyncEngine merge
      this.setBatchInProgress?.(true);
      try {
        // Commit content-scoped dirty files first so `git merge` doesn't
        // refuse with dirty-tree. For dirty paths outside the content scope
        // (typically OK-generated configs like `.claude/`, `.cursor/`,
        // `.mcp.json`), `prepareForMerge` stashes anything non-overlapping
        // with the incoming merge — sync isn't blocked by adjacent dirt.
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
          // Conflict detected — transition to conflict state
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

  // ─── Push cycle ────────────────────────────────────────────────────────────

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

  /** @param retriesLeft - Max inline fetch+merge+retry attempts on non-fast-forward. */
  private async doPushCycle(retriesLeft = 0): Promise<void> {
    // Gather content-filtered files that exist on disk — never git add .
    const contentFiles = this.gatherContentFilesSync();

    // Temp index file for GIT_INDEX_FILE isolation
    const tmpIndexPath = join(tmpdir(), `ok-sync-idx-${process.pid}-${Date.now()}.idx`);
    let commitSha: string | null = null;

    this.transitionTo('pushing');

    try {
      await withParentLock(async () => {
        // Create handle with isolated index so we never disturb the user's real index
        const handle = this.gitHandle(tmpIndexPath);

        // ── 1. Get current HEAD SHA ────────────────────────────────────────────
        // Short-circuit unborn HEAD by checking .git/HEAD directly — more
        // reliable than catching revparse's error, since simple-git surfaces
        // the same error message for several unrelated failure modes.
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

        // ── 2. Seed isolated index from HEAD tree ──────────────────────────────
        await handle.git.raw(['read-tree', headSha]);

        // ── 3. Identify deleted content files (in HEAD but no longer on disk) ──
        const headContentSet = await this.listHeadContentPaths(handle, headSha);

        // ── 4. Stage working-tree content files into isolated index ────────────
        if (contentFiles.length > 0) {
          const BATCH = 100; // avoid ARG_MAX
          for (let i = 0; i < contentFiles.length; i += BATCH) {
            const batch = contentFiles.slice(i, i + BATCH).map((f) => f.projectRelPath);
            await handle.git.raw(['add', '--', ...batch]);
          }
        }

        // ── 5. Remove deleted content files from isolated index ────────────────
        const onDiskSet = new Set(contentFiles.map((f) => f.projectRelPath));
        const deleted = [...headContentSet].filter((f) => !onDiskSet.has(f));
        await this.removePathsFromIndex(handle, deleted);

        // ── 6. Write the tree from the isolated index ──────────────────────────
        const newTreeSha = (await handle.git.raw(['write-tree'])).trim();

        // ── 7. Skip if tree is identical to HEAD's tree (prevents empty commits) ─
        //       Authoritative "nothing changed" check: compare against HEAD
        //       rather than `lastPushedSha`, since (a) `lastPushedSha` is null
        //       on first start / fresh sync-state, and (b) HEAD may have moved
        //       via pull or external commit, in which case `lastPushedSha^{tree}`
        //       no longer reflects the parent we'd be committing on top of.
        let headTreeSha = '';
        try {
          headTreeSha = (await handle.git.raw(['rev-parse', `${headSha}^{tree}`])).trim();
        } catch {
          // Non-fatal: fall through and let commit-tree handle it
        }
        if (headTreeSha && headTreeSha === newTreeSha) {
          // Working tree matches HEAD — nothing new to commit. But local HEAD
          // may still be ahead of `origin/<branch>` (e.g. a merge commit
          // produced by conflict resolution): in that case we still need to
          // push, just without creating a new commit on top.
          let upstreamSha: string | null = null;
          try {
            upstreamSha = (
              await handle.git.raw(['rev-parse', `origin/${this.currentBranch}`])
            ).trim();
          } catch {
            // No origin/<branch> ref yet — treat as ahead so push --set-upstream runs.
          }

          if (upstreamSha === headSha) {
            // Truly synced. Logged so "Sync now returns OK but nothing happens"
            // is still diagnosable when user edits sit in the persistence
            // debounce (default 2s) and haven't landed on disk yet.
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

        // ── 8. Build commit message from files that actually changed in this
        //       commit (HEAD tree vs new tree), not from every tracked file.
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
          // Non-fatal: fall back to all-files message so we still commit.
          changedProjectRelPaths = contentFiles.map((f) => f.projectRelPath).concat(deleted);
          changedContentRelPaths = contentFiles.map((f) => f.contentRelPath);
        }
        const message = this.buildCommitMessage(changedContentRelPaths);

        // ── 9. Author identity (resolveGitIdentity chain, soft fallback) ─
        // Chain: repo-local → global → (OAuth profile, when tokenStore plumbed) →
        // hard-coded "OpenKnowledge" default. We never error on unresolved
        // identity — attribution silently degrades to the default and the UI
        // surfaces a non-blocking nudge via `status.identityUnresolved`.
        const identity = await resolveGitIdentity(this.projectDir);
        const nextUnresolved = identity === null;
        if (this.identityUnresolved !== nextUnresolved) {
          this.identityUnresolved = nextUnresolved;
          this.cc1Broadcaster?.signal('sync-status');
        }
        const authorName = identity?.name ?? 'OpenKnowledge';
        const authorEmail = identity?.email ?? 'sync@open-knowledge.local';

        // Set author/committer env vars on the handle for commit-tree
        applyGitEnv(handle, {
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_COMMITTER_NAME: authorName,
          GIT_COMMITTER_EMAIL: authorEmail,
        });

        // ── 10. Create squash commit (one parent per push cycle) ───────────────
        const newCommitSha = (
          await handle.git.raw(['commit-tree', newTreeSha, '-p', headSha, '-m', message])
        ).trim();

        // `commit-tree` may return error text on stdout under failure modes
        // (corrupt objects, disk issues). Treating that as a ref value would
        // corrupt the branch pointer in the subsequent `update-ref`.
        if (!newCommitSha || !SHA_HEX_40.test(newCommitSha)) {
          log.warn(
            { raw: newCommitSha },
            '[sync] commit-tree returned invalid SHA — aborting push',
          );
          this.transitionTo('idle');
          return;
        }

        // ── 11. Update branch ref atomically (CAS: old=headSha prevents races) ─
        await handle.git.raw([
          'update-ref',
          `refs/heads/${this.currentBranch}`,
          newCommitSha,
          headSha,
        ]);

        // ── 11b. Sync the real index with new HEAD for the paths we just
        //        committed. Uses a handle WITHOUT the isolated GIT_INDEX_FILE
        //        so the reset targets `.git/index`, not our tmp index. Without
        //        this, the real index keeps the old HEAD's tree entries and
        //        `git status` reports phantom staged changes. Reset the full
        //        changed path set, not just files still present on disk, so
        //        committed deletions are removed from the real index too.
        await this.resetRealIndexForPaths(changedProjectRelPaths);

        // ── 12. Push — set upstream if branch has none ─────────────────────────
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
        // If we were paused on dirty-tree, the commit we just made cleared
        // the working tree relative to HEAD. Clear the paused reason and
        // schedule an immediate pull so any pending merge (behind>0) lands
        // now that the tree is clean.
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
          // Inline fetch + merge + retry (one attempt)
          log.info({}, '[sync] push rejected (non-fast-forward) — fetching, merging, retrying');
          const retryHandle = this.gitHandle();
          this.setBatchInProgress?.(true);
          try {
            await retryHandle.git.fetch('origin');
            // Commit content-scoped dirty files before merging so the editor
            // racing against the outer push's `update-ref` doesn't cause
            // `git merge` to refuse with dirty-tree. `prepareForMerge` then
            // stashes any remaining non-content dirt that doesn't overlap
            // with the incoming merge.
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
          // Merge succeeded — retry push once (retriesLeft=0 prevents recursion)
          await this.doPushCycle(0);
          return;
        }
        // Retry exhausted — let the next pull cycle handle it
        log.info({}, '[sync] push still rejected after retry — waiting for next pull cycle');
        this.consecutiveFailures++;
        if (this.state === 'pushing') this.transitionTo('idle');
      } else {
        this.handleError(classified, 'push');
      }
    } finally {
      // Always clean up the temporary index file
      try {
        unlinkSync(tmpIndexPath);
      } catch {}
    }

    this.scheduleSaveState();
  }

  // ─── Push cycle helpers ───────────────────────────────────────────────────

  /**
   * Stage the current working tree's **content** files against HEAD and, if
   * the result differs from HEAD's tree, create a commit + fast-forward
   * `refs/heads/<branch>`. Content scope matches the main push cycle — only
   * files returned by `gatherContentFilesSync()` are staged.
   *
   * Returns the new commit SHA, or null if there was nothing content-scoped
   * to commit.
   *
   * Note: this does not clean the tree entirely — files outside the content
   * scope (e.g. package.json, untracked config) remain dirty. Callers that
   * need a truly clean tree (e.g. before `git merge`) must also call
   * `prepareForMerge` and pause if it's not.
   */
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
      // Same rationale as the main push path: reject error text masquerading
      // as a SHA before we feed it to `update-ref`.
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

      // Sync the real index with new HEAD for the paths we just committed
      // (see push-cycle step 11b for the full rationale). `handle` has no
      // isolated GIT_INDEX_FILE — resets the real `.git/index`.
      await this.resetRealIndexForPaths(changedProjectRelPaths, handle);

      return newCommitSha;
    } finally {
      try {
        unlinkSync(tmpIndex);
      } catch {}
    }
  }

  /**
   * Prepare the working tree for an upcoming merge from `origin/<branch>`.
   * After `commitDirtyContentFilesToHead` has cleared content-scoped dirt,
   * three states remain possible:
   *
   *   1. Tree is clean → proceed straight to merge.
   *   2. Tree is dirty AND a dirty path overlaps the incoming merge's
   *      changeset → pause; the user must resolve locally before sync can
   *      continue.
   *   3. Tree is dirty but no dirty path overlaps the merge → STASH the
   *      dirt so git's index is clean for the merge, then proceed. The
   *      caller pops the stash after the merge (regardless of whether the
   *      merge surfaced a conflict).
   *
   * Case (3) covers the common OK-generated config-file scenario
   * (`.claude/`, `.codex/`, `.cursor/`, `.mcp.json`): the user has those
   * files dirty or staged, but the remote merge doesn't touch them.
   * `git merge` refuses a non-fast-forward merge on a dirty index —
   * stashing isolates that dirt for the duration of the merge.
   *
   * If either git diff call fails, fall back to "proceed without stash" —
   * the merge will surface any real failure via its own error class.
   */
  private async prepareForMerge(
    handle: GitHandle,
    branch: string,
  ): Promise<{ proceed: boolean; needsStashPop: boolean }> {
    // `diff-index --name-only HEAD` lists only TRACKED files whose working-
    // tree OR index content differs from HEAD's. Untracked files are
    // intentionally excluded: `git merge` only refuses on untracked when
    // the merge would create the same path, which git surfaces at merge
    // time with a specific error — we don't pre-pause for build artifacts,
    // IDE state, or scratch notes.
    let dirtyPaths: string[];
    try {
      dirtyPaths = await listNames(handle.git, ['diff-index', '--name-only', 'HEAD']);
    } catch (err) {
      // Fail-open is correct (git merge will surface real conflicts), but
      // log so triage can spot a degraded pre-check (stale remote ref,
      // index corruption, etc.) rather than seeing the gate vanish silently.
      log.warn({ err, branch }, '[sync] diff-index failed — allowing merge attempt');
      return { proceed: true, needsStashPop: false };
    }
    if (dirtyPaths.length === 0) return { proceed: true, needsStashPop: false };

    // Intersect with the set of paths the incoming merge actually touches.
    // `diff --name-only HEAD..origin/<branch>` reports every path differing
    // between HEAD and the remote tip. Git's rename detection reports only the
    // rename DESTINATION, so a file dirty at its old name that the incoming
    // merge renames is not caught here — the real protection is fail-open: the
    // actual `git merge` still surfaces that conflict, this pre-check only
    // avoids pausing on the common clean cases.
    let mergePaths: Set<string>;
    try {
      mergePaths = new Set(
        await listNames(handle.git, ['diff', '--name-only', `HEAD..origin/${branch}`]),
      );
    } catch (err) {
      log.warn({ err, branch }, '[sync] merge-path diff failed — allowing merge attempt');
      return { proceed: true, needsStashPop: false };
    }
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

    // No overlap with the incoming merge, but tracked dirt remains. Stash
    // it so `git merge` sees a clean index. The caller pops in a finally
    // block. Marker message helps a future debugger spot the stash if a
    // pop ever leaves it behind.
    const stashMessage = `ok-sync: pre-merge stash @ ${new Date().toISOString()}`;
    try {
      await handle.git.raw(['stash', 'push', '-m', stashMessage]);
    } catch (err) {
      log.warn({ err }, '[sync] stash push failed — proceeding without stash');
      return { proceed: true, needsStashPop: false };
    }
    return { proceed: true, needsStashPop: true };
  }

  /**
   * Restore the stash created by `prepareForMerge` (case 3). Called from a
   * `finally` block so it runs whether the merge succeeded, surfaced a
   * conflict, or threw another error class. If `git stash pop` conflicts,
   * the stash stays on the stack — we log so the user can recover via
   * `git stash list` / `git stash pop` manually.
   */
  private async popPreMergeStash(handle: GitHandle): Promise<void> {
    try {
      await handle.git.raw(['stash', 'pop']);
    } catch (err) {
      log.warn({ err }, '[sync] stash pop failed — stash remains on stack');
    }
  }

  /**
   * Recursively walk contentDir and return all files that pass ContentFilter.
   * Uses synchronous FS because this runs under the parentGitMutex.
   */
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
          // Dir-level early-skip delegates to ContentFilter (BUILTIN_SKIP_DIRS + ignore files).
          if (!dirRelPath.startsWith('..') && this.contentFilter.isDirExcluded(dirRelPath))
            continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const contentRelPath = toPosix(relative(this.contentDir, fullPath));
          // Only include files inside contentDir that pass the filter
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
      const headPaths = await listNames(handle.git, ['ls-tree', '-r', '--name-only', headSha]);
      for (const projRelPath of headPaths) {
        const absPath = join(this.projectDir, projRelPath);
        const contentRelPath = toPosix(relative(this.contentDir, absPath));
        if (!contentRelPath.startsWith('..') && !this.contentFilter.isExcluded(contentRelPath)) {
          paths.add(projRelPath);
        }
      }
    } catch {
      // Non-fatal: callers proceed without deletion tracking.
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
        // Non-fatal: worst case is phantom index dirt until next sync cycle.
      }
    }
  }

  /**
   * Build the auto-save commit message.
   * ≤3 files: "Auto-save: Updated a.md, b.md"
   * >3 files: "Auto-save: N files changed"
   */
  private buildCommitMessage(contentRelPaths: string[]): string {
    if (contentRelPaths.length === 0) {
      return 'Auto-save: changes saved';
    }
    if (contentRelPaths.length <= 3) {
      return `Auto-save: Updated ${contentRelPaths.join(', ')}`;
    }
    return `Auto-save: ${contentRelPaths.length} files changed`;
  }

  // ─── Conflict handling ────────────────────────────────────────────────────

  private async handleMergeConflict(): Promise<void> {
    const handle = this.gitHandle();

    // List all conflicted files (those with U status in git's unmerged index).
    // If this listing fails we cannot tell content-vs-non-content conflicts
    // apart, so the downstream auto-resolve and `commit --no-edit` path would
    // silently commit a merge with unresolved files still in the index. Abort
    // the merge and surface the error so the user can retry rather than
    // produce a malformed commit.
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

    // Partition: content files pause sync; non-content files are auto-resolved with theirs.
    //
    // "Content" here = CRDT-managed markdown the editor can show in the
    // DiffView. That is a stricter predicate than `ContentFilter.isExcluded`,
    // which is the SIDEBAR/file-index predicate and ALSO admits asset files
    // (e.g. `.json`, `.png`, `.csv`) when they sit next to an `.md` via the
    // sibling-asset rule (`packages/server/src/content-filter.ts` step 3).
    // Without the `isSupportedDocFile` gate, a routine modify/modify conflict
    // on `.mcp.json` at a directory containing any `.md` would be classified
    // as content, surfacing it in the sidebar Conflicts section with no
    // editor surface to resolve from.
    //
    // The `isExcluded` check is retained so that `.gitignore` / `.okignore`
    // exclusions on a `.md` (e.g. `private-notes.md`, anything under
    // `node_modules/`) ALSO route to auto-resolve. Both gates together =
    // "user can resolve this in the OK editor", which is the only valid
    // condition for ConflictStore admission.
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

    // Auto-resolve non-content files with 'theirs' strategy.
    // Non-content files (e.g. `.mcp.json`, `.claude/*`) have no editor
    // surface — the ConflictStore + sidebar Conflicts section are
    // content-only by construction. On any failure (most commonly a
    // modify/delete conflict where `--theirs` errors with "does not have
    // their version") abort the whole merge and pause sync rather than
    // escalating into the ConflictStore. The user resolves the file in
    // their terminal; the next pull tick re-attempts cleanly.
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
      // List both common resolutions as equal alternatives. `git rm` comes
      // first because the documented primary cause (modify/delete where
      // theirs deleted) makes `--theirs` fail with "does not have their
      // version" — but framed as alternatives rather than branched on
      // git's error text, which is git-version-dependent + locale-sensitive
      // (LANG/LC_MESSAGES). The user picks based on the per-file warn log
      // emitted above and their own context.
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
      // Record in ConflictStore
      for (const file of contentConflicts) {
        this.conflictStore.addConflict({ file, detectedAt: new Date().toISOString() });
      }
      this.conflictCount = this.conflictStore.count();
      await this.notifyContentConflictsDetected(contentConflicts);

      // Pause timers — sync resumes only after manual resolution or abort
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
      // All conflicts auto-resolved — complete the merge
      try {
        await handle.git.raw(['commit', '--no-edit']);
        this.lastSyncUtc = new Date().toISOString();
        this.behind = 0;
        this.transitionTo('idle');
        log.info({}, '[sync] all conflicts auto-resolved — merge committed');
      } catch (e) {
        // Commit failed after partial auto-resolve — abort merge to clean up git index
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

  // ─── Error handling ───────────────────────────────────────────────────────

  private clearPushError(): void {
    this.pushError = undefined;
    this.pushErrorCode = undefined;
  }

  private clearPullError(): void {
    this.pullError = undefined;
    this.pullErrorCode = undefined;
  }

  /**
   * @param op - which direction failed. Errors are stored per direction so a
   *   later success on the other leg can't clear this one (see SyncStatus).
   *   `'pull'` covers fetch + merge (bringing remote changes in, including
   *   the inline merge during a push retry); `'push'` covers sending commits
   *   out.
   */
  private handleError(classified: ClassifiedError, op: 'push' | 'pull'): void {
    // Surface the error to the sync UI as either a bounded code (named
    // buckets: auth/401, auth/403, auth/scope-mismatch, semantic/protected-
    // branch) OR a developer-facing message (everything else). The UI
    // Lingui-formats the code; the dev message renders verbatim as a
    // fallback for unmapped variants. Setting exactly one of the direction's
    // {<dir>Error, <dir>ErrorCode} pair lets the UI branch without ambiguity —
    // see SyncStatusBadge's `formatPushFailureCode` / `formatPullFailureCode`.
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
      // The relayed gh token may be the stale credential that just failed
      // (revoked, or a `gh auth logout` since we cached). Drop the cache so the
      // next cycle re-resolves — picking up a fresh `gh auth login` without
      // waiting out the TTL.
      this.ghTokenSource.invalidate();
      this.transitionTo('auth-error');
      this.pausedReason = 'auth-error';
    } else if (classified.class === 'semantic' && classified.subclass === 'protected-branch') {
      this.syncEnabled = false;
      this.transitionTo('disabled');
      this.pausedReason = 'protected-branch';
      // Persist the auto-disable to project-local config so it survives restart;
      // otherwise next boot would re-read `autoSync.enabled: true` and
      // re-trigger the same push failure (restart-retry loop).
      void this.onAutoDisable?.('protected-branch');
    } else if (classified.class === 'local' && classified.subclass === 'dirty-tree') {
      // Self-heal: schedule an immediate push. The push cycle commits
      // working-tree edits via an isolated index, which reconciles the
      // tree against HEAD and lets the subsequent merge proceed.
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

  // ─── State transitions ────────────────────────────────────────────────────

  private transitionTo(newState: SyncState): void {
    if (this.state === newState) return;
    const prev = this.state;
    this.state = newState;
    log.info({ from: prev, to: newState }, `[sync] state: ${prev} → ${newState}`);
    this.onStateChange?.(newState);
    this.cc1Broadcaster?.signal('sync-status');
  }

  // ─── State persistence ────────────────────────────────────────────────────

  private scheduleSaveState(): void {
    if (this.stateSaveTimer !== null) return; // debounce
    this.stateSaveTimer = setTimeout(() => {
      this.stateSaveTimer = null;
      this.saveStateNow();
    }, 5_000);
  }

  private saveStateNow(): void {
    try {
      // `'no-push-permission'` and `'auth-error'` are in-memory only by design.
      // The push-permission probe re-establishes the former on every `start()`;
      // auth-error must NOT survive restart either, or a relaunch after the user
      // reconnects would stay stuck (the credential is read fresh per git
      // invocation, so the next cycle would succeed if we let it run). Dropping
      // both means a restart re-attempts sync and re-classifies if it still
      // fails. Every other pausedReason value persists normally.
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
        // Persist file paths of any in-flight conflicts so they survive restart
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
      // Defense-in-depth: `saveStateNow` filters `'no-push-permission'` and
      // `'auth-error'` out, but a state file written by an earlier build (or
      // hand-edited) could still contain them. Drop both on load so a restart
      // re-attempts sync rather than resurrecting a stuck auth/permission state.
      this.pausedReason =
        data.pausedReason === 'no-push-permission' || data.pausedReason === 'auth-error'
          ? undefined
          : data.pausedReason;

      // Restore in-flight conflicts into the ConflictStore
      const inflightFiles = data.inflightConflicts ?? [];
      if (inflightFiles.length > 0) {
        for (const file of inflightFiles) {
          // Only add if not already present (ConflictStore.load() may have populated it)
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
