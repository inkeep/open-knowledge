/**
 * Hook for subscribing to the sync engine state via CC1 `sync-status` channel.
 *
 * Fetches `GET /api/sync/status` on mount and whenever the server emits a
 * `ch:'sync-status'` CC1 signal. Returns null until the first response arrives.
 */
import type {
  PushPermissionWire as GitPushPermission,
  PullOutcome,
  SyncErrorCode,
  SyncMode,
  SyncStatusSchema,
} from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';

type GitSyncState =
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
 * Push-permission probe outcome carried in the sync-status payload. Type is
 * imported from `@inkeep/open-knowledge-core` (single source of truth — wire
 * schema `PushPermissionSchema`); absent (`undefined`) when the engine hasn't
 * completed a probe for this project (no remote, non-github origin, or probe
 * in flight). UI consumers treat absent as "no gate" and render current
 * behavior — the read+write parity invariant. The local alias preserves the
 * narrower `GitPushPermission` name used elsewhere in the app.
 */

/**
 * Compile-time drift guard between this hand-maintained interface and the
 * server's wire schema.
 *
 * The two are not aliases — `GitSyncStatus` deliberately narrows (it omits
 * server-only bookkeeping like `lastPushedSha` and `consecutiveFailures`, which
 * no UI reads) and relaxes required-ness where a version-skewed engine may omit
 * a field. What it must NEVER do is declare a field the server does not send:
 * that reads as `undefined` at runtime with no type error at the use site, so
 * the UI silently renders a fallback forever. `Exclude` resolves to `never`
 * while every key here exists on the wire, and to the offending key names
 * otherwise — which fails assignment and names them in the error.
 *
 * Keyed off `SyncStatusSchema.shape`, NOT `keyof SyncStatusWire`: the schema is
 * `.loose()`, so the inferred type carries an index signature and `keyof` on it
 * includes `string` — which makes `Exclude` resolve to `never` unconditionally
 * and turns this guard into decoration. The shape has only the declared keys.
 */
type ClientFieldsNotOnWire = Exclude<keyof GitSyncStatus, keyof typeof SyncStatusSchema.shape>;
// Annotate-with-conditional, not `= null as never`: `never` is assignable to
// EVERY type, so annotating the offending union and assigning `never` type-checks
// no matter what drifts. Here the annotation collapses to `true` only while the
// union is empty; otherwise it becomes the offending key names and rejects `true`.
const _noClientOnlyFields: [ClientFieldsNotOnWire] extends [never] ? true : ClientFieldsNotOnWire =
  true;
void _noClientOnlyFields;

export interface GitSyncStatus {
  state: GitSyncState;
  lastSyncUtc: string | null;
  /**
   * When a sync op last completed successfully — a push or pull that reached
   * the remote, whether or not content moved. NOT the panel-open fetch, which
   * fires whenever the user looks and would pin this to "just now". The
   * fallback behind the freshness line when the per-direction legs are absent.
   * Optional for version-skew safety; absent from an engine that predates it.
   */
  lastRunUtc?: string | null;
  /**
   * The same successful-run signal split by direction, so the panel can say
   * WHICH leg ran rather than collapsing both into one "Updated". Same
   * version-skew optionality as `lastRunUtc`; an older engine sends neither and
   * the panel falls back to the combined stamp.
   */
  lastPullOkUtc?: string | null;
  lastPushOkUtc?: string | null;
  lastFetchUtc: string | null;
  /**
   * Completion timestamp + bounded outcome of the last pull (background or
   * one-shot). Optional for version-skew safety — absent from a payload emitted
   * by an engine that predates the outcome contract. A surface that triggers a
   * pull reads status first, then waits for `lastPullUtc` to change and reads
   * `lastPullOutcome`.
   */
  lastPullUtc?: string | null;
  lastPullOutcome?: PullOutcome | null;
  ahead: number;
  behind: number;
  conflictCount: number;
  /** True when a git remote exists, even if sync is dormant/disabled. */
  hasRemote: boolean;
  /**
   * True when sync is on at all (both `pull` and `full`), false for `off`.
   * Read `syncMode` to branch on push capability — this boolean cannot tell
   * pull-only from full.
   */
  syncEnabled: boolean;
  /**
   * Project sync mode. Optional for version-skew safety — absent from a status
   * payload emitted by an engine that predates the field. `full` is the only
   * mode that pushes.
   */
  syncMode?: SyncMode;
  /**
   * Soft signal: the git identity chain (merged git config → OAuth)
   * returned null on the last probe. Commits still succeed under a default
   * identity — the UI surfaces a non-blocking nudge to set a real one.
   */
  identityUnresolved?: boolean;
  /**
   * Origin remote resolved for display. `webUrl` is non-null only for
   * recognized GitHub origins (rendered as a link); non-GitHub remotes carry
   * a readable `label` with `webUrl: null`. Null/absent when no remote exists.
   */
  remote?: { label: string; webUrl: string | null } | null;
  /**
   * Per-direction error surfaces. `push*` = sending commits out; `pull*` =
   * bringing remote changes in (fetch + merge). Tracked separately so a
   * success on one leg never clears the other's error — a failed push stays
   * visible even after a successful fetch (the popover-flash fix). Within a
   * direction the bounded `*ErrorCode` (Lingui-localized) wins at render, else
   * the raw `*Error` message.
   */
  pushError?: string;
  pushErrorCode?: SyncErrorCode;
  pullError?: string;
  pullErrorCode?: SyncErrorCode;
  pausedReason?: string;
  /**
   * Tracked paths whose local edits overlap the incoming merge, present only
   * while `pausedReason` is `external-changes-pending`. The sync popover lists
   * them and offers commit/discard; absent (never empty) when nothing blocks.
   */
  blockingPaths?: string[];
  /**
   * Push-permission probe outcome. Absent when the probe hasn't resolved
   * yet (cold start) or the origin isn't a github.com URL. UI consumers
   * treat absent as "no gate" — render current behavior unconditionally.
   */
  pushPermission?: GitPushPermission;
}

type SyncStatusFetchError = 'network' | 'server';

interface FetchSyncStatusResult {
  status: GitSyncStatus | null;
  error?: SyncStatusFetchError;
}

async function fetchSyncStatus(): Promise<FetchSyncStatusResult> {
  try {
    const res = await fetch('/api/sync/status');
    if (!res.ok) return { status: null, error: 'server' };
    return { status: (await res.json()) as GitSyncStatus };
  } catch {
    return { status: null, error: 'network' };
  }
}

/**
 * Tracks sync status via CC1 `sync-status` pushes. Backwards-compatible: the
 * primary return is still the status object (or null before the first
 * successful response). Consumers that care about "is the server reachable?"
 * can call {@link useGitSyncStatusDetailed} instead.
 */
export function useGitSyncStatus(): GitSyncStatus | null {
  return useGitSyncStatusDetailed().status;
}

/**
 * Variant of {@link useGitSyncStatus} that exposes a fetch-error classification.
 * Distinguishes "we haven't loaded yet" from "the last fetch failed" so the UI
 * can surface a connectivity warning instead of silently showing nothing.
 */
export function useGitSyncStatusDetailed(): {
  status: GitSyncStatus | null;
  fetchError: SyncStatusFetchError | null;
} {
  const [status, setStatus] = useState<GitSyncStatus | null>(null);
  const [fetchError, setFetchError] = useState<SyncStatusFetchError | null>(null);

  function refresh() {
    void fetchSyncStatus().then(({ status: s, error }) => {
      setFetchError(error ?? null);
      if (s) setStatus(s);
    });
  }

  // Initial fetch on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is intentionally stable (defined in component scope)
  useEffect(() => {
    refresh();
  }, []);

  // Re-fetch on CC1 sync-status signal
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is intentionally stable (defined in component scope)
  useEffect(() => {
    return subscribeToDocumentsChanged((channels) => {
      if (channels.includes('sync-status')) {
        refresh();
      }
    });
  }, []);

  return { status, fetchError };
}
