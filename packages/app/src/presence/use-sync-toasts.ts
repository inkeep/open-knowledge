import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { useRelaunchInFlight } from '@/lib/relaunch-store';
import { restartCollabServer } from '@/lib/restart-collab-server';
import type { SyncStatus } from './use-sync-status';

const TOAST_ID = 'sync-status';

/**
 * onClick for the disconnect toast's "Restart server" action. When a project's
 * server has actually stopped (`ok stop`, an idle-shutdown that fired while the
 * window was open), reconnecting never succeeds — there is no server to reach.
 * Restarting spawns a fresh one. Exported for unit tests. On a resolved failure
 * the warning is swapped for an error; on success main tears the window down so
 * nothing else runs.
 */
export async function runDisconnectRestart(
  bridge: Pick<OkDesktopBridge, 'restartServer' | 'config'>,
): Promise<void> {
  try {
    const result = await restartCollabServer(bridge);
    if (!result.ok) {
      toast.error(result.message, { id: TOAST_ID, duration: Infinity });
    }
  } catch {
    // The restart invoke rejects when main destroys this window mid-call (the
    // success path). The window is going away — nothing to do.
  }
}

/**
 * Fires toasts on sync-status transitions: warning on disconnect, success on reconnect.
 * Silent on the happy path (connecting → connected → synced).
 */
export function useSyncToasts(status: SyncStatus, activeDocName: string | null) {
  const { t } = useLingui();
  // A desktop auto-update relaunch tears the server down on purpose, and the
  // file sidebar already shows a calm "Relaunching…" notice — so suppress the
  // alarming infinite "Connection lost" warning during one, or the two surfaces
  // contradict each other. Kept as an effect dep so that if the relaunch aborts
  // while still disconnected, this re-runs and the warning fires for the
  // now-genuine outage.
  const relaunchInFlight = useRelaunchInFlight();
  const hasConnectedRef = useRef(false);
  const wasDisconnectedRef = useRef(false);

  const prevDocRef = useRef(activeDocName);

  useEffect(() => {
    if (prevDocRef.current !== activeDocName) {
      prevDocRef.current = activeDocName;
      hasConnectedRef.current = false;
      wasDisconnectedRef.current = false;
    }

    if (!activeDocName) return;

    if (status === 'synced') {
      hasConnectedRef.current = true;
    }

    if (status === 'disconnected' && hasConnectedRef.current) {
      if (relaunchInFlight) {
        // Intentional teardown — clear any warning already showing (covers the
        // disconnect-then-relaunch ordering) and stay silent. Don't set
        // `wasDisconnectedRef`, so no spurious "Reconnected" fires afterward.
        toast.dismiss(TOAST_ID);
        return;
      }
      wasDisconnectedRef.current = true;
      // Desktop only: offer a working recovery. "keep this tab open\u2026 will sync
      // when reconnected" is true for a transient blip but a dead end once the
      // server has actually stopped \u2014 Restart spawns a fresh one. In `ok ui`
      // (browser) mode there is no bridge, so the toast stays message-only.
      // (No `typeof window` guard \u2014 this runs inside useEffect, always client-side.)
      const bridge = window.okDesktop;
      toast.warning(
        t`Connection lost \u2014 keep this tab open, your edits will sync when reconnected`,
        {
          id: TOAST_ID,
          duration: Infinity,
          ...(bridge
            ? {
                action: {
                  label: t`Restart server`,
                  onClick: () => {
                    void runDisconnectRestart(bridge);
                  },
                },
              }
            : {}),
        },
      );
    } else if (wasDisconnectedRef.current && status === 'synced') {
      wasDisconnectedRef.current = false;
      toast.success(t`Reconnected`, { id: TOAST_ID, duration: 3000 });
    }
  }, [status, activeDocName, t, relaunchInFlight]);
}
