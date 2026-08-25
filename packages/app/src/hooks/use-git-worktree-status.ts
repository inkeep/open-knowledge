/**
 * Hook for `GET /api/git/worktree-status` — the `git status` listing the sync
 * popover renders under its action buttons.
 *
 * Deliberately separate from `useGitSyncStatus`. That one is the engine's state
 * machine, pushed over CC1 on every transition and mounted app-wide by the
 * badge. This one is a working-tree read that only matters while the popover is
 * open, so it is `enabled`-gated and polled rather than broadcast: putting a
 * file listing on the CC1 hot path would make every engine transition ship a
 * potentially large payload to every client.
 *
 * Refreshes on three triggers: mount (when enabled), a CC1 `sync-status` signal
 * (a completed push/pull changes what is dirty), and a slow interval that
 * catches edits made outside the app while the popover sits open.
 */
import type { GitWorktreeStatusSuccess } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import { triggerSync } from '@/lib/trigger-sync';

export type GitWorktreeStatus = GitWorktreeStatusSuccess;

/**
 * Poll cadence while the popover is open. Slow on purpose — the CC1 signal
 * already covers every change the engine itself makes, so this interval exists
 * only to catch a terminal `git add` the app never hears about.
 */
const WORKTREE_POLL_MS = 5_000;

/**
 * Minimum gap between panel-open fetches. Opening, closing, and reopening the
 * popover is a normal fidget; without this it would be a network call each
 * time. The outgoing listing is read live off disk regardless, so a suppressed
 * fetch only means the ahead/behind counts and the incoming list stay as fresh
 * as the last 30 seconds.
 */
const FETCH_THROTTLE_MS = 30_000;

/**
 * Module-scoped rather than per-hook: two surfaces mounting this hook at once
 * (badge popover plus a future settings pane) should share one budget, and the
 * value has to outlive the popover's unmount to throttle a reopen at all.
 */
let lastFetchAt = 0;

/**
 * Refresh remote-tracking refs when a panel opens, at most once per throttle
 * window.
 *
 * `fetch` is the read-only op: it updates `refs/remotes/origin/*` and never
 * merges, so answering "what's waiting for me?" cannot move the user's files.
 * Rejections are swallowed — offline is the common case and the panel simply
 * shows the counts it already had.
 */
function maybeFetch(): void {
  const now = Date.now();
  if (now - lastFetchAt < FETCH_THROTTLE_MS) return;
  lastFetchAt = now;
  triggerSync('fetch').catch(() => {
    // Passive refresh: the user opened a panel, they did not ask to sync.
    // Allow an immediate retry on the next open rather than burning the window
    // on a call that never reached the engine — but only if this call still
    // owns the window: a slow rejection must not discard the throttle a newer
    // surface's successful call just claimed.
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

/**
 * Read the working tree's status while `enabled` is true.
 *
 * Returns `null` before the first successful response and keeps the last good
 * value across a failed refresh — a transient fetch failure should not blank a
 * listing the user is reading. `loading` is true only for the initial fetch, so
 * the poll never flashes a skeleton over already-rendered rows.
 */
export function useGitWorktreeStatus(enabled: boolean): {
  status: GitWorktreeStatus | null;
  loading: boolean;
} {
  const [status, setStatus] = useState<GitWorktreeStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // Single-flight: the mount call, the poll, and the CC1 subscription all
    // funnel here, and a sync cycle signals on every state transition — so an
    // open popover during a sync otherwise issues a burst of four-subprocess
    // status reads, and a slower EARLIER response could land after (and
    // overwrite) a newer listing. One request in flight; signals that arrive
    // meanwhile collapse into a single trailing re-run.
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
        // Keep the previous listing on a failed refresh rather than blanking it.
        // `readable !== false`, not `readable === true`: a server that predates
        // the field sends nothing, and treating that as unreadable would freeze
        // the panel permanently under version skew. An unreadable read keeps the
        // last good listing rather than overwriting it with a false-clean one —
        // the keep-last-good guard below could not see the difference, because a
        // 200 with empty lists is truthy.
        if (!cancelled && next && next.readable !== false) setStatus(next);
        if (rerunQueued && !cancelled) {
          rerunQueued = false;
          refresh();
        }
      });
    }

    refresh();
    // Opening the panel is the user asking about remote state; answer it with
    // current refs rather than whatever the last sync happened to leave behind.
    // The CC1 `sync-status` signal the fetch emits drives the re-render.
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

  // Derived rather than tracked: a separate `loading` flag would need clearing
  // on every refresh path, and getting that wrong flashes a skeleton over rows
  // the user is already reading. Null status while enabled IS the initial load.
  return { status, loading: enabled && status === null };
}
