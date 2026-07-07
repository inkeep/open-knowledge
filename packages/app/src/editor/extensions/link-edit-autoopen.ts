/**
 * Pending "open the URL editor on mount" flags for internal-link marks,
 * keyed by mark id.
 *
 * Mirrors `setPendingAutoOpen` / `consumeAutoOpen` (component-items.tsx) for
 * inline-math: the slash-command "Link" insert lands a fresh `link` mark,
 * flags its id here, then activates its prop panel. When
 * `InternalLinkPropPanel` mounts for that id it consumes the flag and opens
 * the edit dialog immediately — so the author types the URL without first
 * hovering the chip and clicking Edit.
 *
 * A bare `Set<string>` keyed by mark id (not a boolean) so two rapid inserts
 * can't have one consume the other's flag — each insert tracks its own id,
 * and consumption is a `.delete(id)`. Effectively self-pruning: every panel
 * that mounts calls `consumePendingLinkEdit(nodeId)` once.
 */
const pendingLinkEdits = new Set<string>();

export function setPendingLinkEdit(markId: string): void {
  pendingLinkEdits.add(markId);
}

/**
 * Consume the auto-edit flag for `markId`. Returns true once; subsequent
 * calls for the same id return false.
 */
export function consumePendingLinkEdit(markId: string): boolean {
  return pendingLinkEdits.delete(markId);
}

/**
 * Test-only: clear the pending set so suites don't leak flags into each
 * other. Production code drains entries via `consumePendingLinkEdit` as
 * panels mount. Mirrors `_resetPendingAutoOpenForTest` in component-items.tsx.
 */
export function _resetPendingLinkEditForTest(): void {
  pendingLinkEdits.clear();
}
