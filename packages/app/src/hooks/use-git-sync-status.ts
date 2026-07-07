/**
 * Hook for subscribing to the sync engine state via CC1 `sync-status` channel.
 *
 * Fetches `GET /api/sync/status` on mount and whenever the server emits a
 * `ch:'sync-status'` CC1 signal. Returns null until the first response arrives.
 */
import type {
  PushPermissionWire as GitPushPermission,
  SyncErrorCode,
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

export interface GitSyncStatus {
  state: GitSyncState;
  lastSyncUtc: string | null;
  lastFetchUtc: string | null;
  ahead: number;
  behind: number;
  conflictCount: number;
  /** True when a git remote exists, even if sync is dormant/disabled. */
  hasRemote: boolean;
  /** User's sync toggle preference (false by default — disabled for safety). */
  syncEnabled: boolean;
  /**
   * Soft signal: the git identity chain (local → global → OAuth)
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
