import { useEffect } from 'react';
import { useConfigContext } from '@/lib/config-context';
import { getPool, useDocumentContext } from './DocumentContext';
import { installBackgroundThrottleReporter } from './install-background-throttle-reporter';

/**
 * Reports the window's unsynced-work state to the desktop main process so main
 * keys the window's Chromium background-throttling to it. Renders nothing.
 *
 * Inert outside the Electron host (no `window.okDesktop`). Mounted under both
 * DocumentProvider (for `collabUrl` → the pool) and ConfigProvider (for the
 * `bridge.backgroundThrottle.enabled` kill-switch, default ON until the config
 * doc syncs, matching the schema default).
 */
export function BackgroundThrottleReporter(): null {
  const { collabUrl } = useDocumentContext();
  const { projectConfig } = useConfigContext();
  const enabled = projectConfig?.bridge?.backgroundThrottle?.enabled ?? true;

  useEffect(() => {
    if (collabUrl === null) return;
    const bridge = window.okDesktop;
    // Capability check, not just host check: the preload bridge is a
    // cross-process contract the renderer cannot enforce, so a shell built
    // before this channel exposes `editor` without the method. Throttling is
    // an optimization; its absence must never crash the app shell.
    const notify = bridge?.editor?.notifyBackgroundThrottle;
    if (typeof notify !== 'function') return;
    const pool = getPool(collabUrl);
    return installBackgroundThrottleReporter({
      enabled,
      hasAnyUnsyncedWork: () => pool.hasAnyUnsyncedWork(),
      addUnsyncedWorkListener: (cb) => pool.addUnsyncedWorkListener(cb),
      report: (signal) => notify(signal),
    });
  }, [collabUrl, enabled]);

  return null;
}
