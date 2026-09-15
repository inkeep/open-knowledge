import type { GitWorktreeStatusSuccess } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import { triggerSync } from '@/lib/trigger-sync';

export type GitWorktreeStatus = GitWorktreeStatusSuccess;

const WORKTREE_POLL_MS = 5_000;

const WORKTREE_READ_TIMEOUT_MS = 15_000;

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

type WorktreeReadFailure = 'http' | 'aborted' | 'network';

type WorktreeRead =
  | { kind: 'ok'; status: GitWorktreeStatus }
  | { kind: 'unreadable' }
  | { kind: 'failed'; reason: WorktreeReadFailure };

async function fetchWorktreeStatus(signal: AbortSignal): Promise<WorktreeRead> {
  try {
    const res = await fetch('/api/git/worktree-status', { signal });
    if (!res.ok) {
      console.warn('[sync] worktree status read failed: http', res.status);
      return { kind: 'failed', reason: 'http' };
    }
    const body = (await res.json()) as GitWorktreeStatus;
    if (body.readable === false) return { kind: 'unreadable' };
    return { kind: 'ok', status: body };
  } catch (err) {
    if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
    console.warn(
      '[sync] worktree status read failed: network',
      err instanceof Error ? err.message : err,
    );
    return { kind: 'failed', reason: 'network' };
  }
}

type WorktreeReadState = {
  status: GitWorktreeStatus | null;
  unreadable: boolean;
  stale: boolean;
  lastReadAt: number | null;
};

const INITIAL_READ: WorktreeReadState = {
  status: null,
  unreadable: false,
  stale: false,
  lastReadAt: null,
};

export function useGitWorktreeStatus(enabled: boolean): {
  status: GitWorktreeStatus | null;
  loading: boolean;
  unreadable: boolean;
  stale: boolean;
  lastReadAt: number | null;
} {
  const [read, setRead] = useState<WorktreeReadState>(INITIAL_READ);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    let inFlight = false;
    let rerunQueued = false;
    let activeController: AbortController | null = null;
    function refresh() {
      if (inFlight) {
        rerunQueued = true;
        return;
      }
      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      const timeout = setTimeout(() => controller.abort(), WORKTREE_READ_TIMEOUT_MS);
      void fetchWorktreeStatus(controller.signal)
        .then((result) => {
          if (cancelled) return;
          if (result.kind === 'ok') {
            setRead({
              status: result.status,
              unreadable: false,
              stale: false,
              lastReadAt: Date.now(),
            });
            return;
          }
          if (result.kind === 'unreadable') {
            setRead((prev) => ({ ...prev, unreadable: true, stale: false }));
            return;
          }
          setRead((prev) => {
            if (prev.status === null) {
              return prev.unreadable ? prev : { ...prev, unreadable: true, stale: false };
            }
            if (prev.unreadable) return prev;
            return prev.stale ? prev : { ...prev, stale: true };
          });
        })
        .finally(() => {
          clearTimeout(timeout);
          if (activeController === controller) activeController = null;
          inFlight = false;
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
      activeController?.abort();
    };
  }, [enabled]);

  return {
    status: read.status,
    loading: enabled && read.status === null && !read.unreadable,
    unreadable: read.unreadable,
    stale: read.stale,
    lastReadAt: read.lastReadAt,
  };
}
