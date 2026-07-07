/**
 * Cross-namespace mount-cycle correlation seed.
 *
 * One deterministic ID flows from prewarm/pool through mount across
 * cache/mount/sync/cold/typing namespaces — replacing fragile
 * timestamp-window joins.
 *
 * Contract:
 * - `EditorActivityPool` mints / adopts a `mountId` on each
 *   docName-promotion transition (newly entering the top-N MRU mount
 *   list) and demotes it on eviction.
 * - Adoption invariant: when the ProviderPool entry already carries a
 *   `poolEventId` (from a prior prewarm-then-click flow), the activity
 *   pool adopts THAT id as the mountId. Otherwise a fresh UUID is
 *   minted. On a later `pool.open()` for the same docName, the new
 *   pool entry's poolEventId may differ — that's fine, the next mount
 *   cycle will re-derive.
 * - Callers reading the registry MUST tolerate `undefined` (the doc
 *   may not be on the mount list yet, or the call site may execute
 *   before the activity-pool effect runs). Callers thread the result
 *   into their mark payload as `mountId` (or omit when undefined; the
 *   mark schema accepts both).
 */
const mountIdByDocName = new Map<string, string>();

export function getMountId(docName: string): string | undefined {
  return mountIdByDocName.get(docName);
}

/**
 * Set the mountId for `docName` for the duration of its current mount
 * cycle. Called by `EditorActivityPool` on promote-to-mount-list. Idempotent
 * for the same (docName, mountId) pair.
 */
export function setMountId(docName: string, mountId: string): void {
  mountIdByDocName.set(docName, mountId);
}

/**
 * Clear the mountId for `docName`. Called by `EditorActivityPool` when
 * the doc is demoted off the mount list, so the next promote-cycle
 * re-derives a fresh mountId (first-toggle repeatability).
 */
export function clearMountId(docName: string): void {
  mountIdByDocName.delete(docName);
}

/** Test-only: snapshot of all registered mountIds. */
export function __getMountIdRegistry(): ReadonlyMap<string, string> {
  return mountIdByDocName;
}

/** Test-only: clear all entries between tests. */
export function __resetMountIdRegistry(): void {
  mountIdByDocName.clear();
}
