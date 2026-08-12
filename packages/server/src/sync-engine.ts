/**
 * SyncEngine — background fetch/merge/push with typed state machine.
 *
 * Surface: core state machine + remote detection + lifecycle, pull cycle
 * (fetch + merge + timers + backoff), push cycle (squash-before-push +
 * content-scope), conflict + error handling integration, state persistence
 * + restart recovery.
 */

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
import { isSupportedDocFile } from './doc-extensions.ts';
import {
  type ClassifiedError,
  classifyGitError,
  type UserFacingErrorCode,
} from './error-classification.ts';
import { tracedUnlinkSync, tracedWriteFileSync } from './fs-traced.ts';
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
  originGitHubHost,
  readOriginGitHubRepo,
  readSyncRemoteInfo,
  type SyncRemoteInfo,
} from './share/git-context.ts';
import { assertRealpathWithinDir } from './symlink-guard.ts';
import {
  computeRemainingMs,
  type PullAuthTier,
  pullIntervalSecondsForAuthTier,
} from './sync-timing.ts';

const log = getLogger('sync-engine');

/**
 * Git SHA-1 object IDs are 40 lowercase hex chars. `commit-tree` and similar
 * plumbing can emit error text on stdout under failure modes (e.g. corrupt
 * objects, disk full) — a non-empty truthy string is not enough to trust as a
 * ref value, so we pattern-match before feeding it to `update-ref`.
 */
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

/**
 * Why a `git merge --ff-only` refused. `git` distinguishes the two causes by
 * both exit code and stderr severity token, and the pull-only cycle must react
 * differently to each: an overlay overlap is recoverable (restore the file and
 * retry), a divergence is not fast-forwardable at all.
 */
export type FastForwardRefusal = 'overlay-overlap' | 'divergence' | 'unknown';

/**
 * Classify a fast-forward refusal from git's exit code and stderr. Two
 * independent discriminators are available and pinned against the shipped git
 * build by a test, because the message text is locale- and version-sensitive:
 *   - divergence (local history not fast-forwardable): exit 128, `fatal:` +
 *     "Not possible to fast-forward";
 *   - overlay overlap (an uncommitted edit to a file the merge would update):
 *     exit 1, `error:` + "would be overwritten by merge".
 * The severity token is the primary signal — git prints an informational
 * `Updating <a>..<b>` line to stdout even when it then aborts, so stdout is not
 * safe to key on.
 */
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
      // Both payload unions derive structurally from the source-of-truth
      // `PushPermission` in github-permissions.ts so a code added there can't
      // silently drift from this wire shape. The Zod enum in core's
      // sync-seed.ts still needs a manual matching update; its round-trip
      // test is the runtime net for that half.
      deniedReason: Extract<PushPermission, { kind: 'denied' }>['reason'];
    }
  | {
      checkStatus: 'unknown';
      unknownError?: Extract<PushPermission, { kind: 'unknown' }>['error'];
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
  /**
   * Completion timestamp + bounded outcome of the last pull (background or
   * one-shot). `lastPullUtc` bumps at every pull completion so a downstream
   * surface can detect a fresh result by change; `lastPullOutcome` carries that
   * pull's outcome. Null until the first pull completes.
   */
  lastPullUtc: string | null;
  lastPullOutcome: PullOutcome | null;
  ahead: number;
  behind: number;
  consecutiveFailures: number;
  conflictCount: number;
  /** True when a git remote exists, even if sync is dormant/disabled. */
  hasRemote: boolean;
  /**
   * Whether sync is on at all — true for both `pull` and `full` mode, false for
   * `off`. False by default (disabled for safety). Read `syncMode` to branch on
   * push capability; this boolean cannot distinguish pull-only from full.
   */
  syncEnabled: boolean;
  /** Project sync mode. `full` is the only mode that pushes. */
  syncMode: SyncMode;
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
  /**
   * Project sync mode from resolved config. When omitted, `syncEnabled` is used
   * as the legacy back-compat source (`true`→`full`, else `off`). Prefer `mode`.
   */
  mode?: SyncMode;
  /**
   * Legacy boolean enable flag. Retained so existing callers (and tests) keep
   * working; `true` maps to `full`, anything else to `off`. Ignored when `mode`
   * is provided.
   */
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
  /**
   * Called after a content conflict clears (resolved by the user or
   * auto-dissolved when upstream converged). The server uses this to clear the
   * conflict status on already-loaded Y.Docs — for a working-tree conflict the
   * resolution may not change disk bytes (keep-mine), so the file-watcher's
   * `case 'update'` clear cannot be relied on.
   */
  onContentConflictsResolved?: (files: string[]) => void | Promise<void>;
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
   * Snapshot the working tree to the recoverable timeline just before a
   * pull-only transition folds stranded local commits into a working-tree
   * overlay (a `--mixed` reset realigns the branch to origin). Fired only when
   * there are commits to convert, and before the branch moves, so the
   * pre-conversion state is recoverable even if the process dies mid-transition.
   * The server wires this to a shadow-repo safety checkpoint; omit in tests /
   * headless boots where no shadow repo exists.
   */
  checkpointBeforeStrandedConversion?: (context: {
    branch: string;
    ahead: number;
  }) => void | Promise<void>;
  /**
   * Fired inside a pull-only cycle when an incoming fast-forward overlaps an
   * uncommitted local edit, right before the overlapping paths are reset to HEAD
   * (the reset is what lets the fast-forward land). Between that reset and the
   * overlay re-write the edit lives only in memory, so a hard crash in that
   * window would lose it for a doc with no live client. The server wires this to
   * a shadow-repo safety checkpoint so the pre-reset bytes survive on the shadow
   * timeline and stay recoverable. Best-effort — a failure only forfeits the
   * crash-window safety net, so the cycle proceeds. Omit in tests / headless
   * boots where no shadow repo exists.
   */
  checkpointBeforeOverlayRestore?: (context: {
    branch: string;
    paths: number;
  }) => void | Promise<void>;
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
  const inspected = inspectGitRepository(projectDir);
  if (inspected.kind !== 'repository') return false;
  const head = inspected.repository.readHead();
  if (head.kind !== 'branch') return false;
  return inspected.repository.readRef(head.ref).kind === 'absent';
}

// ─── Backoff thresholds ──────────────────────────────────────────────────────

function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures >= 8) return 60 * 60 * 1000; // 60 min
  if (consecutiveFailures >= 5) return 15 * 60 * 1000; // 15 min
  if (consecutiveFailures >= 3) return 5 * 60 * 1000; // 5 min
  return 0; // use normal interval
}

/**
 * Wall-clock cap for the `git merge --ff-only` subprocess. It is the one git
 * call in the engine spawned directly (not via the simple-git handle's block
 * timeout), so without this a hang — a stuck credential-helper prompt, a
 * degraded disk/NFS — would block the pull cycle forever with `pullInFlight`
 * held, wedging every future pull and push. On timeout the child is killed and
 * the cycle takes the error path so it retries with backoff.
 */
const FF_ONLY_TIMEOUT_MS = 120_000;

/**
 * Inactivity cap (simple-git `timeout.block`: ms since the last stdout/stderr
 * chunk) for every git op run through the engine's shared handle — fetch, push,
 * status, rev-parse. Without it a stuck remote or a hung credential-helper
 * prompt blocks the op forever with `pullInFlight`/`pushInFlight` held, wedging
 * every future cycle until the app restarts; pull-only amplifies this since a
 * follower has no push cycle to interleave and the one-shot "Update now" is a
 * fresh entry point onto the same fetch. A progressing transfer resets the
 * timer on each chunk, so only genuine silence trips it and the cycle then
 * falls into the existing backoff.
 */
const GIT_BLOCK_TIMEOUT_MS = 120_000;

// ─── SyncEngine ──────────────────────────────────────────────────────────────

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
  /**
   * The single source of truth for what direction (if any) this engine syncs.
   * `off` = inactive, `pull` = fetch + fast-forward only (never pushes), `full`
   * = bidirectional. Push is structurally impossible unless this is `full` (the
   * gate lives at the push routine entrance), so no scheduling path can push for
   * a pull-only project.
   */
  private mode: SyncMode;
  private credentialArgs: string[];
  private cc1Broadcaster: CC1Broadcaster | null;
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
  /**
   * Credential tier the next pull-mode cycle fetches as, resolved from the same
   * gh → token-store → anonymous order the push probe uses. Cached so the
   * scheduler can read it synchronously; refreshed before each pull-mode
   * schedule. Anonymous followers poll at a gentler cadence. `unknown` until
   * first resolved, treated as authenticated (the responsive default).
   */
  private authTier: PullAuthTier | 'unknown' = 'unknown';

  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private stateSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Runtime state
  private lastSyncUtc: string | null = null;
  private lastFetchUtc: string | null = null;
  private lastPushedSha: string | null = null;
  private lastPullUtc: string | null = null;
  private lastPullOutcome: PullOutcome | null = null;
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
    this.rootOkOutsideContentWalk = toPosix(
      relative(this.contentDir, join(this.projectDir, OK_DIR)),
    ).startsWith('..');
    this.pullIntervalSeconds = options.pullIntervalSeconds ?? 30;
    this.pushIntervalSeconds = options.pushIntervalSeconds ?? 60;
    // `mode` wins; fall back to the legacy boolean so callers that still pass
    // `syncEnabled` keep their exact prior semantics (true→full, else off).
    this.mode = options.mode ?? (options.syncEnabled === true ? 'full' : 'off');
    this.credentialArgs = options.credentialArgs ?? [];
    this.cc1Broadcaster = options.cc1Broadcaster ?? null;
    this.onStateChange = options.onStateChange;
    this.onContentConflictsDetected = options.onContentConflictsDetected;
    this.onContentConflictsResolved = options.onContentConflictsResolved;
    this.setBatchInProgress = options.setBatchInProgress;
    this.onAutoDisable = options.onAutoDisable;
    this.checkpointBeforeStrandedConversion = options.checkpointBeforeStrandedConversion;
    this.checkpointBeforeOverlayRestore = options.checkpointBeforeOverlayRestore;
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
   * Host the relayed gh token authenticates: the origin remote's GitHub host
   * (github.com or GHES), falling back to github.com when the origin is
   * missing or a non-GitHub forge (the relay is then harmless surplus).
   * Resolved per handle from `.git/config` — a few small file reads, noise
   * next to the subprocess each handle spawns — so a remote swap mid-session
   * is picked up without a restart. The token stays cached per host in
   * `ghTokenSource`.
   */
  private syncGhTokenHost(): string {
    return originGitHubHost(this.projectDir);
  }

  /**
   * Single construction point for every git handle the engine spawns. Threads
   * the credential args plus the cached gh token (scoped to the origin's
   * GitHub host) so fetch/push authenticate via gh when available. Local-only
   * handles (e.g. `remote -v`, `merge --abort`) carry the token harmlessly —
   * the cache keeps resolution to at most one `gh` spawn per minute
   * regardless of handle count.
   */
  private gitHandle(gitIndexFile?: string): GitHandle {
    return createGitInstance(this.projectDir, {
      credentialArgs: this.credentialArgs,
      gitIndexFile,
      ghToken: this.ghTokenSource.get(this.syncGhTokenHost()) ?? undefined,
      timeoutMs: GIT_BLOCK_TIMEOUT_MS,
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
    // Both `pull` and `full` are active here; only `off` stays inactive.
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

    // Reconcile persisted conflict state against git's view. The user may
    // have resolved (or aborted) the merge externally between server runs,
    // so conflicts.json can be stale — git is the source of truth.
    // Linked-worktree safety: resolve the real gitdir (the worktree's
    // `<repo>/.git/worktrees/<name>/` dir, not the literal
    // `<projectDir>/.git`) so MERGE_HEAD probes work in main + linked.
    const gitDir = resolveGitDir(this.projectDir);
    const mergeHeadPath = gitDir ? join(gitDir, 'MERGE_HEAD') : null;
    const mergeInProgress = mergeHeadPath !== null && existsSync(mergeHeadPath);

    // Align the cached count with the persisted store (conflicts.json) so the
    // reconcile below sees every entry, including working-tree variants.
    this.conflictCount = this.conflictStore.count();
    const mergeNativeEntries = () =>
      this.conflictStore.list().filter((e) => e.variant !== 'working-tree');

    if (mergeNativeEntries().length > 0 && !mergeInProgress) {
      // Merge-native entries with no merge in progress → resolved externally.
      // (Working-tree entries are MERGE_HEAD-free by design and survive.)
      log.warn(
        { count: mergeNativeEntries().length },
        '[sync] persisted merge conflicts but no MERGE_HEAD — clearing stale state',
      );
      for (const entry of mergeNativeEntries()) this.conflictStore.removeConflict(entry.file);
      this.conflictCount = this.conflictStore.count();
    } else if (mergeNativeEntries().length > 0 && mergeInProgress) {
      // Merge still in progress — drop any tracked entries git considers resolved.
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

    // Clean up stale merge state: MERGE_HEAD but no merge-native conflicts
    // tracked → a previous crash left a half-merged state; abort to recover.
    if (mergeInProgress && mergeNativeEntries().length === 0) {
      log.warn({}, '[sync] stale MERGE_HEAD detected with no tracked conflicts — aborting merge');
      try {
        const handle = this.gitHandle();
        await handle.git.raw(['merge', '--abort']);
      } catch (e) {
        log.warn({ err: e }, '[sync] git merge --abort for stale MERGE_HEAD failed');
      }
    }

    // Merge-native conflicts pause the engine (a MERGE_HEAD blocks all sync);
    // working-tree conflicts only re-flag their doc and keep the engine pulling.
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
      // Re-flag the per-doc lifecycle so the resolver mounts on open; stay idle
      // and keep scheduling pulls — the branch is already at origin tip.
      await this.notifyContentConflictsDetected(workingTreeEntries.map((entry) => entry.file));
    }

    // Resolve the follower's credential tier before scheduling so an anonymous
    // pull-only follower's first cycle already uses the gentle cadence.
    if (this.mode === 'follow') await this.refreshAuthTier();

    // Schedule with restart-aware remaining delay (max(0, lastFetchUtc+interval - now)).
    const pullRemainingMs = computeRemainingMs(
      this.lastFetchUtc,
      this.currentPullIntervalSeconds(),
    );
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
   * Set the sync mode. Soft transition — cancels scheduled cycles but lets an
   * in-flight pull/push finish cleanly to avoid leaving a partial merge. The
   * caller persists the preference to project config; sync-state.json only
   * records runtime status/history.
   *
   * Idempotent on a same-value call: the config re-apply path fires on both a
   * producer notify and a watcher echo, so this must not double-run.
   *
   * Switching between `pull` and `full` while local commits are ahead needs a
   * checkpoint + overlay conversion; that transition machinery is not wired here
   * yet, so this treats every non-`off` target as the plain enable path.
   */
  async setMode(mode: SyncMode, source: SyncModeChangeSource = 'config'): Promise<void> {
    if (this.mode === mode) return;
    const from = this.mode;
    this.mode = mode;
    log.info({ from, to: mode, source }, '[sync] mode changed');

    if (mode === 'off') {
      this.cancelScheduledCycles();
      // Drain in-flight cycles so disable is observed before the next cycle
      // mutates state. Bounded so a wedged pull/push can't hold the toggle
      // forever — disable still lands in-memory.
      await this.drainInFlightCycles();
      this.pausedReason = undefined;
      this.clearPushError();
      this.clearPullError();
      this.transitionTo(this.hasRemote ? 'disabled' : 'dormant');
      this.saveStateNow();
      return;
    }

    // Enable (pull or full). Re-detect remote in case it was added (or removed)
    // while sync was off. Unconditional — unlike refreshRemote() this handles
    // both directions, so enabling against an externally-removed remote
    // correctly demotes to dormant instead of incorrectly transitioning to idle.
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

    // Entering pull-only with local commits ahead of origin: those commits can
    // never be pushed, so fold them into the working-tree overlay and realign
    // the branch to origin. A full→pull downgrade first lets an in-flight push
    // finish (soft-disable drain) — it may land some of those commits — then
    // converts what remains; off→pull has nothing in flight to drain. Full mode
    // keeps stranded commits and pushes them, so it skips conversion entirely.
    if (mode === 'follow') {
      await this.drainInFlightCycles();
      this.cancelScheduledCycles();
      await this.convertStrandedCommitsToOverlay();
    }

    this.transitionTo('idle');
    this.schedulePull(0);
    // No-op unless mode === 'full' (the push gate lives in schedulePush +
    // runPushCycle), so a pull-only project schedules pulls only.
    this.schedulePush();
    this.saveStateNow();
    // Re-check push permission so the engine state and the probe state stay
    // consistent. For `full`, a stale `denied` probe would otherwise let this
    // reach 'idle' + schedule cycles that hit a 403; for `pull`, the probe just
    // records the (expected) denial without pausing. Matches trigger()'s pattern.
    void this.probePushPermissionInternal('refresh');
  }

  /**
   * Back-compat adapter over {@link setMode}: `true`→`full`, `false`→`off`.
   * Retained so callers that predate the mode enum keep working; the idempotent
   * same-value early-return is preserved by setMode.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.setMode(enabled ? 'full' : 'off');
  }

  /** Cancel any pending pull/push timers so no scheduled cycle fires. */
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

  /**
   * Wait for any in-flight pull/push cycle to finish before mutating state that
   * would race it. Bounded so a wedged cycle (hung network, unresponsive
   * remote) can't block the caller forever — after the cap the caller proceeds
   * and the stuck cycle logs its own outcome when it eventually resolves.
   */
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

  /**
   * Count local commits not yet on origin — the "unshared changes" figure a
   * downgrade confirm surfaces before those commits are folded into an overlay.
   * A fresh probe (not the cached `ahead`), so a UI can read it at an arbitrary
   * moment. Returns 0 when there's no remote or the branch is unborn.
   */
  async probeUnpushedCommitCount(): Promise<number> {
    if (!this.hasRemote || isUnbornHead(this.projectDir)) return 0;
    return this.unpushedCommitCount(this.gitHandle());
  }

  /**
   * Ahead count via the configured upstream (`git status`), falling back to an
   * explicit `rev-list` against `origin/<branch>` when the branch has no
   * upstream (an enable-time-divergence clone that never set tracking).
   */
  private async unpushedCommitCount(handle: GitHandle): Promise<number> {
    try {
      const status = await handle.git.status();
      if (status.tracking) return status.ahead;
    } catch {
      // Fall through to the rev-list probe below.
    }
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

  /**
   * Fold stranded local commits (ahead of origin) into a working-tree overlay
   * and realign the branch. Called when entering pull-only, where those commits
   * can never be pushed.
   *
   * A `--mixed` reset to the merge base moves the branch ref and index but never
   * touches the working tree, so the committed content survives verbatim as an
   * uncommitted overlay and nothing on screen changes. Ahead-only lands directly
   * on origin's tip (the merge base IS the tip); a diverged branch lands on the
   * common ancestor with the local edits as overlay, and the next fast-forward
   * cycle carries it to origin's tip, reconciling per B1. The pre-conversion
   * tree is checkpointed to the recoverable timeline first (before the ref
   * moves) so the stranded content is never only in the reflog.
   */
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
      // The checkpoint is a recovery convenience; the reset below still leaves
      // the stranded commits reachable via the reflog / ORIG_HEAD, so proceed.
      log.warn({ err: e }, '[sync] pull-only: stranded-commit checkpoint failed — proceeding');
    }

    try {
      const base = (
        await handle.git.raw(['merge-base', 'HEAD', `origin/${this.currentBranch}`])
      ).trim();
      // Gate the HEAD/file watchers while the ref moves. The working tree is
      // byte-identical across a `--mixed` reset, so no reconciliation is owed —
      // the gate just suppresses a spurious mid-transition pass.
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
      // Reset failed — leave the branch as-is, but surface the divergence now
      // rather than relying on the next pull: setMode continues to idle + a
      // scheduled pull, so without a paused reason the badge shows a clean idle
      // while stranded, unpushable commits remain. (transitionTo does not clear
      // pausedReason, so this survives setMode's subsequent idle transition.)
      this.pausedReason = 'diverged-local-commits';
      log.warn(
        { err: e },
        '[sync] pull-only: stranded-commit conversion failed — leaving branch as-is',
      );
    }
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
    if (this.mode === 'off') return;

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

    if (op === 'pull') {
      // A one-shot pull runs in every mode (including off/null): it never
      // commits, never enables anything, and records a bounded outcome rather
      // than a silent no-op. Its own state-gating decides refuse-vs-run.
      await this.pullOnce();
      return;
    }

    // Log why a push/sync trigger is a no-op so "Sync now returns OK but nothing
    // happens" is diagnosable from the server terminal. The cycle guards
    // silently early-return in these states; surface them here.
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
    if (op === 'push') {
      await this.runPushCycle();
    } else {
      // Push first so pending working-tree edits get committed via the
      // isolated-index path. A subsequent merge then has a clean tree
      // instead of refusing with "working tree has uncommitted changes".
      await this.runPushCycle();
      await this.runPullCycle();
    }
  }

  /**
   * Run a single pull and return its bounded outcome — the primitive a
   * downstream surface (e.g. an update button) triggers via `op: 'pull'`.
   *
   * Unlike the background cycle, this runs regardless of mode: an `off`/`null`
   * project fetches and fast-forwards via the B1 variant (never committing) and
   * is left exactly as inactive as it started — no mode flip, no scheduled loop.
   * A `pull`/`full` project runs its normal cycle variant and keeps its
   * background loop alive.
   *
   * State-gating is explicit and always recorded (never a silent no-op): the
   * pull is refused when a cycle is already in flight, an unresolved conflict
   * holds the tree, or there is nothing to pull from. Every path writes
   * `lastPullUtc` + `lastPullOutcome` and signals `sync-status`, so a consumer
   * that read status before triggering can wait for the timestamp to change and
   * read the outcome of a pull that completed after its trigger.
   */
  async pullOnce(): Promise<PullOutcome> {
    const mode = this.mode;
    const outcome = await this.runOneShotPull();
    // One-shot outcomes are the discrete, consumer-visible pull events (e.g. a
    // downstream update button); log each so their distribution is observable
    // without the per-cycle noise a background-pull log would add.
    log.info({ mode, outcome }, '[sync] one-shot pull complete');
    return outcome;
  }

  private async runOneShotPull(): Promise<PullOutcome> {
    // Single-flight: a background or concurrent one-shot cycle already owns the
    // working tree. Refuse rather than race it — the consumer retries on refused.
    if (this.pullInFlight || this.pushInFlight) return this.recordPullOutcome('refused');
    // The full-mode conflict resolver owns the tree until the user resolves.
    if (this.state === 'conflict') return this.recordPullOutcome('refused');
    // Nothing to pull from, or no commits to fast-forward against yet.
    if (!this.hasRemote || isUnbornHead(this.projectDir)) return this.recordPullOutcome('refused');

    // Snapshot the resting posture so an off/null project can be restored to it
    // afterwards — the cycle transitions through fetching/pulling/idle, which
    // must not leave a never-enabled project looking active.
    const restingMode = this.mode;
    const restingState = this.state;
    const restingPausedReason = this.pausedReason;
    this.pullInFlight = true;
    try {
      return this.recordPullOutcome(await this.doPullCycle());
    } finally {
      this.pullInFlight = false;
      if (restingMode === 'off') {
        this.pausedReason = restingPausedReason;
        this.transitionTo(restingState);
      } else {
        // A background timer that fired during this one-shot early-returned on
        // the single-flight guard without rescheduling; re-arm the loop.
        this.schedulePull();
      }
    }
  }

  /**
   * Record a pull's completion timestamp + outcome and signal `sync-status`,
   * then echo the outcome back to the caller. Called at every pull completion
   * (background and one-shot) so `lastPullUtc` changes on each — the signal the
   * change-detection consumer contract relies on.
   */
  private recordPullOutcome(outcome: PullOutcome): PullOutcome {
    this.lastPullUtc = new Date().toISOString();
    this.lastPullOutcome = outcome;
    this.cc1Broadcaster?.signal('sync-status');
    return outcome;
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  getStatus(): SyncStatus {
    return {
      state: this.state,
      lastSyncUtc: this.lastSyncUtc,
      lastFetchUtc: this.lastFetchUtc,
      lastPushedSha: this.lastPushedSha,
      lastPullUtc: this.lastPullUtc,
      lastPullOutcome: this.lastPullOutcome,
      ahead: this.ahead,
      behind: this.behind,
      consecutiveFailures: this.consecutiveFailures,
      conflictCount: this.conflictCount,
      hasRemote: this.hasRemote,
      syncEnabled: this.mode !== 'off',
      syncMode: this.mode,
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
    // `host` is bounded (one value per project) and safe to log.
    log.info(
      {
        caller,
        host: origin.host,
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
        host: origin.host,
        transport: origin.transport,
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

    // A denial only pauses `full` mode, which needs push permission it just
    // learned it lacks. A pull-only follower expects to lack push — denial is
    // its normal condition, so it keeps fetching (no pause, no state change).
    // Pausing in-memory mirrors the existing pausedReason precedent
    // ('detached-head', 'protected-branch', ...) — no disk write. The
    // persistent-write alternative was rejected at spec time because it
    // would silently mutate the user's preference.
    let transitioned = false;
    if (next.checkStatus === 'denied' && this.mode === 'full') {
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
      if (this.state === 'disabled' && this.mode === 'full') {
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
    log.info({ mode: this.mode }, '[sync] remote detected post-boot — re-evaluating state');

    if (this.mode !== 'off') {
      this.transitionTo('idle');
      this.schedulePull(0);
      // No-op unless mode === 'full' (the push gate); pull-only schedules pulls.
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
    // Working-tree conflicts (pull-only B1) have no MERGE_HEAD and are managed by
    // the pull cycle (re-pin / auto-dissolve) + the resolve path. This
    // git-index reconciliation governs merge-native entries only — leave the
    // working-tree entries untouched so the batch-end drain doesn't wipe them.
    const mergeNative = this.conflictStore.list().filter((e) => e.variant !== 'working-tree');
    if (mergeNative.length === 0) return;
    const before = this.conflictCount;
    // Linked-worktree safety (see `start()`): use the resolved gitdir.
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
    // A working-tree resolution may not change disk bytes (keep-mine), so the
    // file-watcher's `case 'update'` clear can't be relied on — fire the
    // resolved callback explicitly to clear the doc's conflict lifecycle.
    const wasWorkingTree =
      this.conflictStore.list().find((c) => c.file === file)?.variant === 'working-tree';
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
      if (wasWorkingTree) {
        // The pull-only conflict lifecycle's terminal event: a user picked a
        // side in the resolver (`strategy` is bounded — mine/theirs/content/
        // delete). Merge-native resolutions are a separate lifecycle.
        log.info({ choice: strategy }, '[sync] pull-only: conflict resolved by choice');
        await this.notifyContentConflictsResolved([file]);
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
    // Only `full` mode pushes. Skipping the timer here means a pull-only project
    // never even schedules a push cycle; runPushCycle carries the authoritative
    // consent gate for any direct caller (e.g. trigger('push')).
    if (this.mode !== 'full') return;
    if (this.pushTimer !== null) clearTimeout(this.pushTimer);
    const delayMs = overrideDelayMs ?? jitteredMs(this.pushIntervalSeconds);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.runPushCycle().catch((e) => {
        log.error({ err: e }, '[sync] push cycle uncaught error');
      });
    }, delayMs);
  }

  /**
   * Resolve which credential tier the follower fetches as, mirroring the push
   * probe's gh → token-store → anonymous order. The probe doesn't surface which
   * tier it used, so the engine resolves it from the credential sources it
   * already holds. gh resolution is cached (at most one spawn per minute); the
   * token store is read at most once per pull.
   */
  private async resolveAuthTier(): Promise<PullAuthTier> {
    const host = this.syncGhTokenHost();
    if (this.ghTokenSource.get(host) !== null) return 'authenticated';
    if (this.tokenStore) {
      try {
        const entry = await this.tokenStore.get(host);
        if (entry?.token) return 'authenticated';
      } catch (err) {
        // A token-store backend can throw on read (corrupted keyring, EACCES).
        // Degrade to the anonymous cadence rather than letting a credential-read
        // failure abort the pull cycle or sync start. Mirrors the same
        // fall-through in github-permissions' probe token resolution.
        log.warn({ err }, '[sync] auth-tier token-store lookup threw — treating as anonymous');
      }
    }
    return 'anonymous';
  }

  /** Refresh the cached {@link authTier} so the next schedule reflects it. */
  private async refreshAuthTier(): Promise<void> {
    this.authTier = await this.resolveAuthTier();
  }

  /**
   * Base pull interval (seconds) for the current mode + auth tier, before jitter
   * and backoff. Only pull-only anonymous followers deviate from the configured
   * interval; full sync and authenticated pull-only keep it unchanged.
   */
  private currentPullIntervalSeconds(): number {
    if (this.mode !== 'follow') return this.pullIntervalSeconds;
    return pullIntervalSecondsForAuthTier(
      this.pullIntervalSeconds,
      this.authTier === 'anonymous' ? 'anonymous' : 'authenticated',
    );
  }

  private effectivePullDelayMs(): number {
    const bkoff = backoffMs(this.consecutiveFailures);
    // Jitter the backoff too, not just the normal interval: anonymous followers
    // of the same public repo fail in lockstep during an outage, so an un-jittered
    // fixed backoff (5/15/60 min) would retry at identical offsets and spike read
    // pressure on the recovering origin. jitteredMs takes seconds.
    const baseSeconds = bkoff > 0 ? bkoff / 1000 : this.currentPullIntervalSeconds();
    return jitteredMs(baseSeconds);
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

    // Re-resolve the credential tier so a follower who signs in (or out)
    // mid-session picks up the matching cadence on the next reschedule.
    if (this.mode === 'follow') await this.refreshAuthTier();

    this.pullInFlight = true;
    try {
      this.recordPullOutcome(await this.doPullCycle());
    } finally {
      this.pullInFlight = false;
      this.schedulePull(); // chain: schedule next after current completes
    }
  }

  private async doPullCycle(): Promise<PullOutcome> {
    const handle = this.gitHandle();

    // Detached HEAD check
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
      return 'error';
    }

    // Check ahead/behind
    try {
      const status = await handle.git.status();
      this.ahead = status.ahead;
      this.behind = status.behind;
    } catch {
      // Non-fatal — continue with previous counts
    }

    // Merge if behind. Pull-only runs the B1 cycle even with existing
    // working-tree conflicts tracked — it re-pins them against the new tip and
    // fast-forwards the rest of the repo (the engine stays idle, not paused, so
    // followers keep updating while a single doc waits on resolution). The
    // full-sync merge still gates on `conflictCount === 0`: a MERGE_HEAD in
    // flight must be resolved before another merge starts.
    if (this.behind > 0 && this.mode !== 'full') {
      const outcome = await this.doPullCycleB1(handle, branch);
      this.scheduleSaveState();
      return outcome;
    }
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
        if (!mergePrep.proceed) return 'refused';
        try {
          await handle.git.merge([`origin/${branch}`]);
          this.lastSyncUtc = new Date().toISOString();
          this.behind = 0;
          this.transitionTo('idle');
        } finally {
          if (mergePrep.needsStashPop) await this.popPreMergeStash(handle);
        }
        this.scheduleSaveState();
        return 'succeeded';
      } catch (e) {
        const classified = classifyGitError(e instanceof Error ? e : new Error(String(e)));
        if (classified.class === 'semantic' && classified.subclass === 'merge-conflict') {
          // Conflict detected — content conflicts pause in 'conflict' state;
          // an all-non-content merge auto-resolves and returns to idle. But
          // auto-resolution can itself fail (a rejected commit, an aborted
          // merge): those paths set pullError and return to idle, so treat a
          // set pullError as the error outcome rather than reporting success.
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
    // Not behind (up-to-date), or behind but holding a conflict that blocks the
    // merge — either way the tree stays put this cycle.
    this.transitionTo('idle');
    this.scheduleSaveState();
    return this.behind === 0 ? 'up-to-date' : 'conflict';
  }

  /**
   * Pull-only fast-forward cycle. Fetch has already landed `origin/<branch>`
   * and the caller has confirmed the branch is behind. This never commits,
   * merges, stashes, or leaves a MERGE_HEAD: the branch advances only by
   * fast-forward, and uncommitted local edits ride along as a working-tree
   * overlay on the new tip.
   *
   * Git's own fast-forward guard is asymmetric, which forces the choreography:
   *   - It refuses to clobber an uncommitted edit to a file the incoming tip
   *     also changed — even a byte-identical one — so every overlapping edit is
   *     restored to HEAD first, then re-applied after the fast-forward.
   *   - It does NOT protect an uncommitted DELETION: a locally-removed file the
   *     tip modifies is silently resurrected. So a deletion overlay is
   *     re-applied explicitly afterwards.
   *
   * Overlapping edits to CONTENT files are reconciled per file:
   * different-line edits auto-combine into a new overlay; same-line collisions
   * keep the local edit and raise a working-tree conflict entry the resolver
   * serves. The engine stays idle (not paused) so the rest of the repo keeps
   * fast-forwarding while a single doc waits on resolution.
   */
  private async doPullCycleB1(handle: GitHandle, branch: string): Promise<PullOutcome> {
    this.transitionTo('pulling');

    // Local commits ahead of origin cannot fast-forward. Pull-only never merges
    // or commits to reconcile them: leave the branch where it is with the
    // overlay intact and surface a paused reason. (Converting stranded local
    // commits into an overlay is a mode-transition concern handled elsewhere.)
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

    // The overlay = tracked paths whose working tree differs from HEAD.
    // Intersect with the paths the incoming tip changes: only that intersection
    // can block the fast-forward; non-overlapping overlay files ride through.
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

    // Existing working-tree conflicts, so an overlap that already collided can
    // be re-pinned to the new tip (or dissolved when the collision disappears).
    const existing = new Map<string, ConflictEntry>();
    for (const e of this.conflictStore.list()) {
      if (e.variant === 'working-tree') existing.set(e.file, e);
    }

    // Read-only planning pass over origin's blobs — decide each overlapping
    // path's disposition before mutating the tree. A throw here (an unreadable
    // blob from `cat-file`, a corrupt object store) must route through
    // handleError so consecutiveFailures increments and the retry backs off,
    // rather than propagating uncaught and re-firing at the base interval.
    let plan: Awaited<ReturnType<typeof this.planOverlapReconciliation>>;
    try {
      plan = await this.planOverlapReconciliation(handle, branch, oldHead, overlapping, existing);
    } catch (e) {
      this.handleError(classifyGitError(e instanceof Error ? e : new Error(String(e))), 'pull');
      return 'error';
    }

    // Gate the file-watcher / HEAD-watcher reconciliation while the tree is
    // mutated, exactly as the full-sync merge path does.
    this.setBatchInProgress?.(true);
    try {
      // Restore every overlapping path to HEAD so the fast-forward isn't refused.
      if (overlapping.length > 0) {
        // Snapshot the overlay bytes before the reset destroys them on disk.
        // Between the reset and the overlay re-write below they live only in the
        // in-memory plan, so a hard crash in that window would lose them for a
        // doc with no live client; the checkpoint keeps the pre-reset content
        // recoverable. Best-effort — a failed checkpoint only forfeits the
        // crash-window net, so proceed (mirrors convertStrandedCommitsToOverlay).
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
          // Couldn't clear the overlay — abandon the cycle without mutating
          // history. The overlay is still on disk; route through handleError so
          // consecutiveFailures increments and the retry backs off instead of
          // re-firing at the base interval against a persistently locked file.
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
        // The FF didn't happen; restore the ORIGINAL overlay (not the planned
        // combine, which assumed the tip landed) so no local edit is lost. The
        // only expected refusal is a divergence the ahead-check missed (TOCTOU).
        // If even this restore fails, the overlapping paths are still reset to
        // HEAD and the user's bytes live only in the in-memory plan — surface it
        // as an error with backoff, never a clean 'refused' idle.
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
          // A wedged ff-only subprocess is an operational failure, not a
          // semantic refusal — surface it with backoff so a stuck credential
          // helper or degraded disk doesn't re-fire at the base interval.
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

      // Branch is at origin tip. Apply the reconciliation on the new base. A
      // failure here means the fast-forward landed but the user's overlay
      // didn't reach disk — surface it rather than returning a clean outcome.
      try {
        this.applyOverlayPlan(plan.writes, plan.deletions);
      } catch (e) {
        log.error({ err: e }, '[sync] pull-only: failed to apply overlay after fast-forward');
        this.handleError(classifyGitError(e instanceof Error ? e : new Error(String(e))), 'pull');
        return 'error';
      }
      // Persist the conflict-store deltas. addConflict/removeConflict mutate
      // in-memory then return false when the disk write failed: the fast-forward
      // landed and the overlay is on disk, but a restart would read a
      // conflicts.json missing these entries — the resolver would lose the
      // pinned theirs blob and the user's overlay would strand with no conflict
      // UI. Surface it as an error so the outcome isn't reported clean and the
      // next cycle retries, rather than diverging in-memory state from disk.
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

      // A newly-surfaced same-line collision is the consumer-visible "conflict"
      // signal; re-pins/dissolves of pre-known conflicts still read as a clean
      // fast-forward.
      return plan.newConflicts.length > 0 ? 'conflict' : 'succeeded';
    } finally {
      this.setBatchInProgress?.(false);
    }
  }

  /**
   * Run `git merge --ff-only` via a direct child process so the exit code is
   * observable (simple-git does not surface it reliably), and classify any
   * refusal. `core.autocrlf=false` mirrors the sync git handle so the FF's
   * working-tree update keeps the byte-exact LF round-trip.
   */
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
      // `child_process` kills the child on timeout (`killed`, SIGTERM). That is
      // an operational hang, not a semantic fast-forward refusal — flag it so
      // the caller takes the error/backoff path instead of a clean 'refused'.
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

  /**
   * Classify each overlapping path (working-tree edit ∩ incoming change) into a
   * reconciliation action, reading only origin's blobs (no tree mutation yet):
   *
   *   - byte-identical      → converge (nothing to write; the FF re-materialises it)
   *   - non-content         → keep the overlay verbatim (never line-merge configs)
   *   - content, combinable → line-level auto-combine into a new overlay
   *   - content, collision  → keep-mine + a working-tree conflict entry pinned to
   *                            the tip/base blobs the resolver serves
   *
   * Existing conflicts re-pin to the new tip, or dissolve when the tip's change
   * makes the collision combinable or byte-identical.
   *
   * `mineRestore` carries every present overlay verbatim for the fast-forward-
   * refusal path, where the planned combine (which assumed the tip landed) must
   * not be written.
   */
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
    // Content docs deleted locally that the tip modified — restored from origin
    // rather than conflicted (pull-only follower posture). Counted in the pull
    // telemetry so how often a follower's deletion yields to upstream is visible.
    const autoRestored: string[] = [];

    for (const p of overlapping) {
      const priorEntry = existing.get(p);
      const hadEntry = priorEntry !== undefined;

      if (!existsSync(join(this.projectDir, p))) {
        // Deleted locally and changed on the incoming tip.
        try {
          // Probe origin for its own throw behavior — a success means origin
          // still has the path (modify), a genuine miss means origin removed it.
          await handle.git.revparse([`origin/${branch}:${p}`]);
        } catch (e) {
          if (this.classifyRefReadFailure(e) === 'error') {
            // Unexpected failure probing origin — do NOT infer an agreed
            // deletion. Keep the deletion this cycle and re-evaluate next pull.
            deletions.push(p);
            log.warn(
              { err: e, path: p },
              '[sync] pull-only: unexpected error probing origin for a deleted overlay — deferring reconcile',
            );
            continue;
          }
          // Genuinely absent at origin — origin also removed it, deletion agreed.
          deletions.push(p);
          if (hadEntry) dissolved.push(p);
          continue;
        }
        if (!this.isContentConflictPath(p)) {
          // Non-content file (config/asset) deleted locally, modified on origin:
          // keep the deletion (these sit outside the content-doc follow model).
          deletions.push(p);
          continue;
        }
        // Content doc deleted locally, modified on origin. In pull-only the
        // follower tracks upstream, so accept the remote's change and let the
        // fast-forward restore the file rather than surfacing a delete/modify
        // conflict. Nothing authored is lost — the local side was a deletion —
        // so the deletion intent yields to upstream: do NOT re-apply the
        // deletion (leave `p` out of `deletions` so the FF resurrects it) and
        // dissolve any prior conflict entry for this path.
        autoRestored.push(p);
        if (hadEntry) dissolved.push(p);
        continue;
      }

      // Modified overlay.
      let mineBuf: Buffer;
      try {
        mineBuf = readFileSync(join(this.projectDir, p));
      } catch {
        continue; // vanished between status and read — treat as non-overlap
      }
      mineRestore.push({ path: p, bytes: mineBuf });
      const mineStr = mineBuf.toString('utf-8');

      let theirsStr: string | null = null;
      try {
        theirsStr = await handle.git.raw(['show', `origin/${branch}:${p}`]);
      } catch (e) {
        // `null` covers both "origin removed the path" (a modify/delete the
        // overlay keeps-mine over) and an unexpected read failure. Only the
        // latter is worth a log — a transient failure that keeps the overlay
        // but leaves a real collision un-surfaced this cycle should be
        // diagnosable rather than invisible.
        if (this.classifyRefReadFailure(e) === 'error') {
          log.warn(
            { err: e, path: p },
            '[sync] pull-only: unexpected error reading origin blob — keeping overlay, deferring reconcile',
          );
        }
        theirsStr = null;
      }

      if (theirsStr !== null && theirsStr === mineStr) {
        // Byte-identical: the FF re-materialises the identical bytes. Converged.
        if (hadEntry) dissolved.push(p);
        continue;
      }

      if (theirsStr === null || !this.isContentConflictPath(p)) {
        // Non-content or unreadable tip blob: keep the overlay verbatim, never
        // line-merge or escalate (matches adjacent-config behavior).
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
        if (hadEntry) dissolved.push(p); // the tip's change dissolved the collision
        continue;
      }

      // Same-line collision: keep-mine on disk, pin theirs+base for the resolver.
      writes.push({ path: p, bytes: mineBuf });
      const theirsSha = await this.gitBlobSha(handle, `origin/${branch}:${p}`);
      if (theirsSha === undefined) {
        // The tip blob was readable moments ago (theirsStr is non-null), so a
        // missing SHA here is a transient git failure, not a semantic absence.
        // A working-tree entry with no pinned theirs blob can't offer the
        // 'theirs' resolution, so keep the overlay and let the next pull
        // re-detect the collision rather than persist an unresolvable entry.
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

  /**
   * Apply a planned overlay: write the chosen bytes, then re-apply any
   * uncommitted deletions the fast-forward would otherwise resurrect (git's
   * overwrite guard does not cover a delete overlay).
   *
   * A write failure here is fatal to the cycle, not a swallowed warn. On the
   * fast-forward-refusal path the overlapping paths were already reset to HEAD,
   * so this write is the only thing restoring the user's uncommitted bytes from
   * the in-memory buffer — dropping it silently would lose the edit behind a
   * clean-looking `idle`. Each target is realpath-contained first: a git remote
   * is untrusted and could ship a symlink at a tracked path that a bare write
   * would follow out of the working tree. Writes route through the fs-traced
   * wrappers like every other server-side disk write.
   */
  private applyOverlayPlan(
    writes: Array<{ path: string; bytes: Buffer }>,
    deletions: string[],
  ): void {
    for (const { path, bytes } of writes) {
      const abs = join(this.projectDir, path);
      assertRealpathWithinDir(abs, this.projectDir);
      tracedWriteFileSync(abs, bytes);
    }
    for (const path of deletions) {
      const abs = join(this.projectDir, path);
      assertRealpathWithinDir(abs, this.projectDir);
      try {
        tracedUnlinkSync(abs);
      } catch (e) {
        // `ENOENT` is the benign converged case (origin also deleted it, or the
        // fast-forward already removed it). Any other errno (EACCES/EPERM/
        // EISDIR) is a real failure that must not be swallowed — surface it so
        // the cycle backs off instead of looking clean.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }

  /** True when a project-relative path is a resolvable OK content doc. */
  private isContentConflictPath(file: string): boolean {
    const absPath = join(this.projectDir, file);
    const contentRelPath = toPosix(relative(this.contentDir, absPath));
    return (
      !contentRelPath.startsWith('..') &&
      isSupportedDocFile(contentRelPath) &&
      !this.contentFilter.isExcluded(contentRelPath)
    );
  }

  /** Resolve a ref to its blob SHA, or `undefined` when the path is absent. */
  private async gitBlobSha(handle: GitHandle, ref: string): Promise<string | undefined> {
    try {
      return (await handle.git.revparse([ref])).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Discriminate why a `<ref>:<path>` read failed: the path is genuinely absent
   * at the ref (expected — origin deleted/never had it) vs an unexpected git
   * failure (timeout, corruption, bad ref). Conflating the two lets a transient
   * failure masquerade as a semantic fact — silently dissolving a tracked
   * conflict or suppressing a real collision. Locale-stable English fragments,
   * matching the merge-native `showStage` discipline (git messages are
   * English-only).
   */
  private classifyRefReadFailure(err: unknown): 'absent' | 'error' {
    const msg = err instanceof Error ? err.message : String(err);
    return /does not exist in|exists on disk, but not in/i.test(msg) ? 'absent' : 'error';
  }

  /** Read a blob's bytes by SHA. */
  private async gitBlobContent(handle: GitHandle, sha: string): Promise<string> {
    return handle.git.raw(['cat-file', 'blob', sha]);
  }

  /**
   * Count content docs carrying a standing overlay — tracked content paths whose
   * working tree differs from HEAD. This is the pull-only divergence surface: it
   * accumulates as a never-push follower edits locally, and per-pull conflict
   * rates don't capture the standing stock.
   */
  private async countStandingOverlay(handle: GitHandle): Promise<number | null> {
    try {
      const overlayPaths = await listNames(handle.git, ['diff-index', '--name-only', 'HEAD']);
      return overlayPaths.filter((p) => this.isContentConflictPath(p)).length;
    } catch {
      // Best-effort gauge sampled after a successful fast-forward; a transient
      // git failure here must not turn a completed pull into an error.
      return null;
    }
  }

  // ─── Push cycle ────────────────────────────────────────────────────────────

  private async runPushCycle(): Promise<void> {
    if (this.pushInFlight) return;
    // The single, authoritative push gate. Push is structurally impossible
    // unless the project is in `full` mode — no scheduling path, manual trigger,
    // or self-heal can reach the push subprocess for a pull-only or off project.
    // This is the consent guarantee: a pull-only follower is never pushed for.
    if (this.mode !== 'full') return;
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
    // Temp index file for GIT_INDEX_FILE isolation
    const tmpIndexPath = join(tmpdir(), `ok-sync-idx-${process.pid}-${Date.now()}.idx`);
    let commitSha: string | null = null;

    this.transitionTo('pushing');

    try {
      // Gather after entering the guarded cycle so an unreadable staging root
      // is surfaced as a push failure instead of escaping the state machine.
      const contentFiles = this.gatherContentFilesSync();
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
        // After the read-tree seed above, so trackedness reflects HEAD.
        const staged = await this.stageContentFiles(handle, contentFiles);

        // ── 5. Remove deleted content files from isolated index ────────────────
        const onDiskSet = new Set(staged.map((f) => f.projectRelPath));
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
        // Chain: effective merged git config → (OAuth profile, when tokenStore plumbed) →
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
      if (err instanceof ShareableOkEnumerationError) {
        log.warn({ err }, '[sync] push cycle: staging error detail');
      }
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
            } else if (mergeErr instanceof ShareableOkEnumerationError) {
              throw mergeErr;
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
      // After the read-tree seed, so trackedness reflects HEAD.
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
    const BATCH = 100; // avoid ARG_MAX
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

  /**
   * Recursively walk contentDir and return all files that pass ContentFilter
   * under the sync staging scope (regular content plus shareable `.ok`
   * artifacts). Uses synchronous FS because this runs under the
   * parentGitMutex.
   */
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
        // Ordinary content frames stay best-effort because mid-walk deletions
        // are routine. Admitted `.ok` frames carry a fatal handler because a
        // partial enumeration is indistinguishable from artifact deletion.
        onError?.(err, dir);
        return;
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const dirRelPath = toPosix(relative(filterBase, fullPath));
          // Dir-level early-skip delegates to ContentFilter (BUILTIN_SKIP_DIRS + ignore files).
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
          // Only include files inside the walk root that pass the filter
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
    // The project-root shareable `.ok` set lives outside the contentDir walk
    // when content.dir is a subfolder — enumerate it from the project root,
    // with admission still fully delegated to ContentFilter (precedent #55).
    if (this.rootOkOutsideContentWalk) {
      const rootOkDir = join(this.projectDir, OK_DIR);
      if (
        existsSync(rootOkDir) &&
        !this.contentFilter.isDirExcluded(OK_DIR, PROJECT_SYNC_STAGING_SCOPE)
      ) {
        // A partial project-root enumeration is unsafe because HEAD deletion
        // tracking cannot distinguish unreadable artifacts from deleted ones.
        walk(rootOkDir, this.projectDir, PROJECT_SYNC_STAGING_SCOPE, failUnreadableOkSubtree);
      }
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
        const inContentWalk =
          !contentRelPath.startsWith('..') &&
          !this.contentFilter.isExcluded(contentRelPath, CONTENT_SYNC_STAGING_SCOPE);
        // Mirror of the gather walk's project-root enumeration: without this
        // term, a tracked project-root artifact would be misread as deleted
        // on every push cycle in subfolder-content.dir projects.
        const inRootOkWalk =
          this.rootOkOutsideContentWalk &&
          projRelPath.startsWith(`${OK_DIR}/`) &&
          !this.contentFilter.isExcluded(projRelPath, PROJECT_SYNC_STAGING_SCOPE);
        if (inContentWalk || inRootOkWalk) {
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
      if (this.isContentConflictPath(file)) {
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
    // Theirs-resolve discards the local side. For most non-content files that
    // loss is benign, but `.ok/config.yml` holds the user's own project
    // settings, so that one file logs at warn to leave a findable breadcrumb
    // for otherwise-silent local-config loss.
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
      // All non-content conflicts auto-resolved — complete the merge. Confirm it
      // landed by checking MERGE_HEAD cleared, not by trusting the call not to
      // throw: simple-git does NOT throw on every non-zero `git commit` exit (a
      // pre-commit hook rejection returns without an error), so a rejected commit
      // would otherwise be reported as a successful pull over a half-merged tree.
      let committed = false;
      try {
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
        // Commit rejected or threw — abort so the tree isn't left half-merged,
        // and set pullError so the pull reports the error class (doPullCycle
        // treats a set pullError as the error outcome) instead of a false success.
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
      // Reachable only in `full` mode — protected-branch is a push rejection and
      // the push gate keeps pull-only/off from ever pushing. Auto-disable to
      // `off`; onAutoDisable persists the equivalent legacy `enabled: false`.
      this.mode = 'off';
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
