/**
 * Fire a one-time toast when the engine pauses sync because the signed-in
 * user has no push permission on the project's remote.
 *
 * The engine sets `pausedReason='no-push-permission'` only when the user
 * had `autoSync.enabled === true` at probe time. Without a visible
 * notification, the in-memory pause is silent in a way the persistent
 * disable wouldn't have been — this hook closes that gap.
 *
 * Per-session dedup via `useRef<boolean>` (not `useState`) — the flag is
 * intentionally non-reactive: we want a synchronous leading-edge gate
 * inside the effect, not a re-render every time the flag flips.
 *
 * Extracted from `EditorPane` so a `.dom.test.tsx` can mount the hook in
 * isolation and pin the fire-once-on-leading-edge behavior without needing
 * to mock the editor's entire dependency tree.
 */
import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

/**
 * Subscribe to the leading edge of `pausedReason === 'no-push-permission'`.
 * Fires `toast.info(...)` once per hook lifetime; subsequent transitions
 * out and back into the reason within the same session do NOT re-fire.
 *
 * Pass `pausedReason` from the live sync-status — typically:
 *
 *   const syncStatus = useGitSyncStatus();
 *   useNoPushPermissionToast(syncStatus?.pausedReason);
 */
export function useNoPushPermissionToast(pausedReason: string | undefined): void {
  const { t } = useLingui();
  const firedRef = useRef(false);
  useEffect(() => {
    if (pausedReason === 'no-push-permission' && !firedRef.current) {
      firedRef.current = true;
      toast.info(t`Sync paused — you don't have permission to push to this repo`);
    }
  }, [pausedReason, t]);
}
