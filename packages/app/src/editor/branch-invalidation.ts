/**
 * Client-side handler for the CC1 `branch-switched` broadcast.
 *
 * When the server normalizes to a new branch it emits a CC1 signal via
 * `cc1Broadcaster.emitBranchSwitched(newBranch)` on the `__system__`
 * pseudo-doc. `SystemDocSubscriber`'s `onStateless` handler parses the
 * payload and calls this module to clear every open provider's client-side
 * persistence cache and recycle the providers so they re-sync against the
 * new branch's markdown-rebuilt state.
 *
 * Contrast with the `server-instance-mismatch` flow in `provider-pool.ts`:
 * that path buffers unsynced edits and replays them post-recycle because
 * the edits are still semantically valid against the restarted server.
 * Branch switch is different — edits authored against branch A are NOT
 * valid against branch B's content, so we deliberately discard them.
 * Buffering would reintroduce stale markers from the old branch.
 */

import { z } from 'zod';
import type { ProviderPool } from './provider-pool';

/**
 * Zod schema for the structured warn event emitted when a per-entry
 * `clearData` fails during a branch-switched invalidation. Co-located
 * with the emitter so the test can import the same schema and assert
 * the parsed shape rather than hand-casting a JSON-parsed blob.
 *
 * Structured logs follow the project's `console.warn(JSON.stringify({
 * event, ... }))` convention.
 */
export const BranchSwitchedClearFailedLogSchema = z.object({
  event: z.literal('ok-branch-switched-clear-failed'),
  branch: z.string(),
  docName: z.string(),
  reason: z.string(),
});
type BranchSwitchedClearFailedLog = z.infer<typeof BranchSwitchedClearFailedLogSchema>;

/**
 * Wipe every open provider's IndexedDB persistence, drop any in-memory
 * replay buffers, and recycle the providers. Accepts a `branch` label for
 * structured observability — not acted on for dedup because the server's
 * `emitBranchSwitched` only fires on the cross-branch normalization path,
 * so every signal already represents a real branch change.
 *
 * Buffer drain is load-bearing: a prior `server-instance-mismatch` recycle
 * may have populated `pool.bufferedUpdates` for non-active docs; without
 * `clearBufferedUpdates()` those bytes (captured against branch A's Y.Doc)
 * would replay onto branch B the next time the user opened the affected
 * doc. The branch-switch policy is "discard, don't preserve" — apply it
 * to the in-memory buffer slot, not just the IDB layer.
 *
 * `clearData` failures are caught per-entry and logged as structured
 * `ok-branch-switched-clear-failed` warn events so the recycle still
 * proceeds; a transient IDB hiccup on one doc must not leave the rest of
 * the pool stranded on branch A.
 */
export async function handleBranchSwitched(pool: ProviderPool, branch: string): Promise<void> {
  const clears: Promise<void>[] = [];
  for (const [docName, entry] of pool.entries) {
    // TearingDown entries are transient and don't carry persistence.
    // Active entries opened before the live server epoch was known
    // also have null persistence (no persistent IDB attached) — skip
    // them; there's nothing to clear.
    if (entry.kind !== 'active') continue;
    if (entry.persistence === null) continue;
    clears.push(
      entry.persistence.clearData().catch((err: unknown) => {
        const log: BranchSwitchedClearFailedLog = {
          event: 'ok-branch-switched-clear-failed',
          docName,
          branch,
          reason: err instanceof Error ? err.message : String(err),
        };
        console.warn(JSON.stringify(log));
      }),
    );
  }
  await Promise.all(clears);
  pool.clearBufferedUpdates();
  pool.recycleAllEntries();
}
