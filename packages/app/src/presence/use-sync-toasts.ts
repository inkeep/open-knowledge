import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { useRelaunchInFlight } from '@/lib/relaunch-store';
import { restartCollabServer } from '@/lib/restart-collab-server';
import type { SyncStatus } from './use-sync-status';

const TOAST_ID = 'sync-status';

const DISCONNECT_PRESUMED_DEAD_MS = 10_000;

export async function runDisconnectRestart(
  bridge: Pick<OkDesktopBridge, 'restartServer' | 'config'>,
): Promise<void> {
  try {
    const result = await restartCollabServer(bridge);
    if (!result.ok) {
      toast.error(result.message, { id: TOAST_ID, duration: Infinity });
    }
  } catch {}
}

export function useSyncToasts(status: SyncStatus, activeDocName: string | null) {
  const { t } = useLingui();
  const relaunchInFlight = useRelaunchInFlight();
  const hasConnectedRef = useRef(false);
  const wasDisconnectedRef = useRef(false);
  const downgradeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downgradedRef = useRef(false);
  const outageToastStandingRef = useRef(false);
  const disconnectedSinceRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (downgradeTimerRef.current !== null) {
        clearTimeout(downgradeTimerRef.current);
        downgradeTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const clearDowngradeTimer = () => {
      if (downgradeTimerRef.current !== null) {
        clearTimeout(downgradeTimerRef.current);
        downgradeTimerRef.current = null;
      }
    };

    if (status === 'synced') {
      hasConnectedRef.current = true;
    }

    if (relaunchInFlight) {
      clearDowngradeTimer();
      downgradedRef.current = false;
      disconnectedSinceRef.current = null;
      toast.dismiss(TOAST_ID);
      outageToastStandingRef.current = false;
      return;
    }

    if (!activeDocName) {
      clearDowngradeTimer();
      return;
    }

    const bridge = window.okDesktop;
    const hasRestartButton = bridge !== undefined;
    const restartAction =
      bridge !== undefined
        ? {
            action: {
              label: t`Restart server`,
              onClick: () => {
                void runDisconnectRestart(bridge);
              },
            },
          }
        : {};
    const showToast = (message: string) => {
      outageToastStandingRef.current = true;
      toast.warning(message, { id: TOAST_ID, duration: Infinity, ...restartAction });
    };
    const showConnectionLost = () =>
      showToast(t`Connection lost — keep this tab open, your edits will sync when reconnected`);
    const showConnectedStalled = () =>
      showToast(
        hasRestartButton
          ? t`Connected, but your edits aren't reaching the server yet. Restart it if this continues.`
          : t`Connected, but your edits aren't reaching the server yet.`,
      );
    const showServerStopped = () =>
      showToast(
        hasRestartButton ? t`The server stopped. Restart it to reconnect.` : t`The server stopped.`,
      );

    if (status === 'connected') {
      clearDowngradeTimer();
      downgradedRef.current = false;
      disconnectedSinceRef.current = null;
      if (outageToastStandingRef.current) showConnectedStalled();
    }

    if (status === 'disconnected' && hasConnectedRef.current) {
      wasDisconnectedRef.current = true;
      if (downgradedRef.current) {
        showServerStopped();
        return;
      }
      if (downgradeTimerRef.current === null) {
        const now = Date.now();
        if (disconnectedSinceRef.current === null) {
          disconnectedSinceRef.current = now;
        }
        const remainingMs = Math.min(
          DISCONNECT_PRESUMED_DEAD_MS,
          DISCONNECT_PRESUMED_DEAD_MS - (now - disconnectedSinceRef.current),
        );
        if (remainingMs <= 0) {
          downgradedRef.current = true;
          showServerStopped();
          return;
        }
        downgradeTimerRef.current = setTimeout(() => {
          downgradeTimerRef.current = null;
          downgradedRef.current = true;
          showServerStopped();
        }, remainingMs);
      }
      showConnectionLost();
    } else if (wasDisconnectedRef.current && status === 'synced') {
      wasDisconnectedRef.current = false;
      clearDowngradeTimer();
      downgradedRef.current = false;
      disconnectedSinceRef.current = null;
      outageToastStandingRef.current = false;
      toast.success(t`Reconnected`, { id: TOAST_ID, duration: 3000 });
    }
  }, [status, activeDocName, t, relaunchInFlight]);
}
