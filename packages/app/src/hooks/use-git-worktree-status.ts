import type { GitWorktreeStatusSuccess } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import { triggerSync } from '@/lib/trigger-sync';

export type GitWorktreeStatus = GitWorktreeStatusSuccess;

const WORKTREE_POLL_MS = 5_000;

const FETCH_THROTTLE_MS = 30_000;

let lastFetchAt = 0;

function maybeFetch(): void {
  const now = Date.now();
  if (now - lastFetchAt < FETCH_THROTTLE_MS) return;
  lastFetchAt = now;
  triggerSync('fetch').catch(() => {
    if (lastFetchAt === now) lastFetchAt = 0;
  });
}

async function fetchWorktreeStatus(): Promise<GitWorktreeStatus | null> {
  try {
    const res = await fetch('/api/git/worktree-status');
    if (!res.ok) return null;
    return (await res.json()) as GitWorktreeStatus;
  } catch {
    return null;
  }
}

export function useGitWorktreeStatus(enabled: boolean): {
  status: GitWorktreeStatus | null;
  loading: boolean;
} {
  const [status, setStatus] = useState<GitWorktreeStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    let inFlight = false;
    let rerunQueued = false;
    function refresh() {
      if (inFlight) {
        rerunQueued = true;
        return;
      }
      inFlight = true;
      void fetchWorktreeStatus().then((next) => {
        inFlight = false;
        if (!cancelled && next && next.readable !== false) setStatus(next);
        if (rerunQueued && !cancelled) {
          rerunQueued = false;
          refresh();
        }
      });
    }

    refresh();
    maybeFetch();

    const interval = setInterval(refresh, WORKTREE_POLL_MS);
    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('sync-status')) refresh();
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      unsubscribe();
    };
  }, [enabled]);

  return { status, loading: enabled && status === null };
}
