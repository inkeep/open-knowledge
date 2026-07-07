/**
 * Single source of truth for `GET /api/server-info` fetch + dispatch.
 *
 * Used by both:
 *   - `DocumentContext` boot fetch (one-shot when the pool first opens)
 *   - `SystemDocSubscriber` reconnect refresh (every subsequent
 *     `__system__` sync event)
 *
 * The two callers exist because CC1 stateless broadcasts (`server-info`,
 * `branch-switched`, `disk-ack`) have no replay — a client briefly
 * offline during a server-side state change misses the broadcast and
 * needs an alternate recovery path. The auth-token claim defense
 * covers `serverInstanceId` and `currentBranch` (the next reconnect's
 * mismatched claim triggers the recycle), but `disk-ack` has no
 * equivalent backstop because the SV is per-document and not in the
 * auth token. This refresher is the late-join recovery path for
 * disk-ack: every `__system__` reconnect re-syncs the per-doc
 * `lastDiskAckedSV` watermark so the mismatch-recycle baseline-
 * selection always operates on fresh data.
 *
 * Idempotent: every dispatch path no-ops on unchanged inputs
 * (`setExpectedServerInstanceId` early-returns on matching IDs;
 * `compareAndUpdateObservedBranch` returns false unless the branch
 * actually changed; `observeDiskAckBatch` overwrites in-place). Safe
 * to call on every `synced` event without producing redundant
 * recycles.
 *
 * Silent on failure: endpoint unavailability falls back to the
 * existing recovery paths (auth-token-claim mismatch on next provider
 * connect, CC1 broadcasts when reachable).
 */

import { ServerInfoSuccessSchema } from '@inkeep/open-knowledge-core';
import { handleBranchSwitched } from '../editor/branch-invalidation';
import type { ProviderPool } from '../editor/provider-pool';
import { emitBranchChanged } from './documents-events';
import { setServerInstanceId } from './server-instance-store';

/**
 * Single-source-of-truth gate for "fire on every `synced` event AFTER
 * the first." Used by both `SystemDocSubscriber` (production) and
 * `attachSystemDocSubscriber` (integration harness) so the trigger
 * semantics for `__system__` reconnect-refresh are identical across
 * both surfaces and testable as a pure function.
 *
 * Why a separate helper: a real WebSocket reconnect manifests as a
 * second `synced` event WITHIN THE SAME `HocuspocusProvider` lifetime
 * (provider's built-in exponential-backoff reconnect re-emits
 * `synced` on each successful re-handshake). Disposing the provider
 * and creating a new one is NOT a reconnect — it's a fresh provider
 * whose first-synced is the cold boot, and the gate correctly skips
 * a refresh in that case (the boot path already does its own fetch).
 *
 * The returned closure is the only side-effect the consumer needs to
 * wire — call it inside the `provider.on('synced', ...)` handler and
 * `onReconnect` fires for the second-and-beyond syncs.
 */
export function createSyncedReconnectGate(onReconnect: () => void): () => void {
  let hadFirstSynced = false;
  return () => {
    if (hadFirstSynced) {
      onReconnect();
    } else {
      hadFirstSynced = true;
    }
  };
}

/**
 * Decode a base64 string to `Uint8Array`. Browser-safe (uses `atob`).
 * Throws on invalid base64 — callers wrap in try/catch to honor the
 * helper's "never throws" contract.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Fetch `/api/server-info` and dispatch every recognized field into
 * the pool. Returns silently on any failure (network error, non-2xx,
 * malformed JSON, schema mismatch); the caller does not need a
 * `try`/`catch`.
 *
 * `baseUrl` is empty for production (relative URL uses the current
 * page's origin) and the test-server URL for integration tests.
 */
export async function refreshServerInfo(pool: ProviderPool, baseUrl = ''): Promise<void> {
  let response: Response;
  try {
    // 5s timeout matches sibling AbortController-using fetch sites
    // (lib/use-collab-url.ts, lib/api-config.ts). Without a timeout, a
    // hung response (proxy tarpit, network blackhole) leaks the call
    // indefinitely — a real concern because this fires on every
    // `__system__` reconnect and holds the branch-mismatch in-flight
    // gate via setOnBranchMismatch.
    response = await fetch(`${baseUrl}/api/server-info`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return;
  }
  if (!response.ok) return;
  let info: unknown;
  try {
    info = await response.json();
  } catch {
    return;
  }
  const result = ServerInfoSuccessSchema.safeParse(info);
  if (!result.success) {
    // Schema mismatch is a programmer-actionable signal (server-client
    // version skew), distinct from the silent network-error class above.
    // Warn once with the Zod issue list so a sustained skew is visible
    // in the console without flooding (no rate-limit needed today
    // because mismatches are deploy-time / version-bump events, not
    // per-frame).
    console.warn(
      JSON.stringify({ event: 'ok-server-info-schema-mismatch', issues: result.error.issues }),
    );
    return;
  }

  pool.setExpectedServerInstanceId(result.data.serverInstanceId);
  // Mirror the epoch into the shared store the config-doc providers read.
  // HTTP-only sink: a respawn drops the socket → reconnect → this path fires,
  // so the CC1-push epoch path need not feed the store (see server-instance-store.ts).
  setServerInstanceId(result.data.serverInstanceId);

  if (result.data.currentBranch !== undefined) {
    if (pool.compareAndUpdateObservedBranch(result.data.currentBranch)) {
      void handleBranchSwitched(pool, result.data.currentBranch);
      // Mirror DocumentContext's `onBranchSwitched`/`observeBranch` so the
      // `current-branch-store` (sidebar branch label, editor footer) refreshes
      // alongside the CRDT recycle. Without this, a renderer whose cold-start
      // `/api/server-info` fetch raced `initAsync` (read `'main'` default)
      // would stay pinned to `'main'` even after a reconnect surfaces the
      // real branch into the pool.
      emitBranchChanged(result.data.currentBranch);
    }
  }

  if (result.data.currentDiskAckSVs !== undefined) {
    const decoded: Record<string, Uint8Array> = {};
    for (const [docName, svBase64] of Object.entries(result.data.currentDiskAckSVs)) {
      try {
        decoded[docName] = base64ToBytes(svBase64);
      } catch {
        // Skip malformed entries — same "never throws" discipline as
        // `parseCC1DiskAck`. A misbehaving emitter or downgraded WS
        // frame can't take down the dispatch path.
      }
    }
    pool.observeDiskAckBatch(decoded);
  }
}
