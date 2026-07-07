/**
 * Trigger a sync-engine operation. POSTs to `/api/sync/trigger`; the push/pull
 * runs server-side and reports completion over the CC1 `sync-status` channel,
 * so callers watch the sync-status hook for the result rather than awaiting a
 * meaningful body here.
 *
 * Rejects when the trigger itself did not land — a network failure (fetch
 * rejects) or a non-2xx response. A caller with UI state gated on the trigger
 * (the share popover's "Sync now" in-flight row) must `.catch` this to recover;
 * otherwise it would spin forever, since no CC1 status update follows a trigger
 * that never reached the engine. Fire-and-forget callers that only watch the
 * status channel `.catch(() => {})` to keep the rejection from going unhandled.
 *
 * Shared by the sync status badge and the share popover's "Sync now" CTA so
 * both hit the same endpoint the same way.
 */
export async function triggerSync(op: 'sync' | 'push' | 'pull'): Promise<void> {
  const res = await fetch('/api/sync/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op }),
  });
  if (!res.ok) {
    throw new Error(`sync trigger failed: ${res.status}`);
  }
}
