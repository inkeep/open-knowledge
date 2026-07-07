/**
 * Mount-stalled affordance — surfaces a "Cancel" link when a mount has
 * stalled past `MOUNT_STALLED_THRESHOLD_MS` (10s default).
 *
 * Subscribes to `subscribeMountStalled` (mount-promise.ts). The substrate
 * emits the stalled signal once per mount; this component's local state
 * tracks per-docName stalled status so the affordance hides + re-shows
 * cleanly across rapid-nav cycles.
 *
 * Cancel calls `getMountAbortController(docName)?.abort()` which:
 *   1. Rejects the consumer promise with `MountAbortError`
 *   2. DocumentErrorBoundary surfaces the "Cancelled" errorCopy ("You
 *      cancelled loading 'docName'") — user-action framing, NOT system
 *      fault
 *   3. Retry is the existing re-open-doc path — no new entry point. The
 *      consumer just navigates back to the doc and the substrate runs a
 *      fresh mount.
 *
 * Test strategy: this component is a thin hook wrapper around
 * `subscribeMountStalled` (substrate-pinned in mount-promise.test.ts:
 * fan-out, late-subscriber replay) and `getMountAbortController` (also
 * substrate-pinned: explicit-abort path produces MountAbortError +
 * removes cache entry). The DOM shape is trivial. A hook-aware test
 * harness for the 40-LOC glue layer would either duplicate substrate
 * tests or require a render-engine dep the codebase doesn't carry.
 * Verification surfaces: substrate unit tests + the manual smoke — set
 * `MOUNT_STALLED_THRESHOLD_MS` to 50 via `__okPerfOverrides` on `window`
 * in the dev console, then open a doc that takes longer than 50ms.
 */

import { Trans } from '@lingui/react/macro';
import { type ReactElement, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getMountAbortController, subscribeMountStalled } from '@/editor/mount-promise';

interface MountStalledAffordanceProps {
  /** The doc the user is currently viewing — only show the affordance for THIS doc. */
  docName: string;
}

export function MountStalledAffordance({
  docName,
}: MountStalledAffordanceProps): ReactElement | null {
  const [stalledDocs, setStalledDocs] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    // subscribeMountStalled replays existing stalled-but-pending entries
    // immediately on registration so a late-mounted affordance doesn't
    // miss a stall that fired during rapid-nav.
    const unsubscribe = subscribeMountStalled((stalledDocName) => {
      setStalledDocs((prev) => {
        if (prev.has(stalledDocName)) return prev;
        const next = new Set(prev);
        next.add(stalledDocName);
        return next;
      });
    });
    return unsubscribe;
  }, []);

  if (!stalledDocs.has(docName)) return null;

  function handleCancel(): void {
    const controller = getMountAbortController(docName);
    controller?.abort();
    // Local state cleanup happens implicitly: abort triggers cache.delete in
    // the substrate, the next stalled-set read won't see this docName, and
    // a future stall on the same docName re-fires the subscriber.
    setStalledDocs((prev) => {
      if (!prev.has(docName)) return prev;
      const next = new Set(prev);
      next.delete(docName);
      return next;
    });
  }

  return (
    <div className="absolute inset-x-0 bottom-8 z-20 flex justify-center text-xs text-muted-foreground">
      <span>
        <Trans>Still loading</Trans>
      </span>
      <Button variant="link" size="sm" className="h-auto px-2 py-0 text-xs" onClick={handleCancel}>
        <Trans>Cancel</Trans>
      </Button>
    </div>
  );
}
