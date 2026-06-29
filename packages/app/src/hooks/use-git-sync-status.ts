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

export interface GitSyncStatus {
  state: GitSyncState;
  lastSyncUtc: string | null;
  lastFetchUtc: string | null;
  ahead: number;
  behind: number;
  conflictCount: number;
  hasRemote: boolean;
  syncEnabled: boolean;
  identityUnresolved?: boolean;
  remote?: { label: string; webUrl: string | null } | null;
  pushError?: string;
  pushErrorCode?: SyncErrorCode;
  pullError?: string;
  pullErrorCode?: SyncErrorCode;
  pausedReason?: string;
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

export function useGitSyncStatus(): GitSyncStatus | null {
  return useGitSyncStatusDetailed().status;
}

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is intentionally stable (defined in component scope)
  useEffect(() => {
    refresh();
  }, []);

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
