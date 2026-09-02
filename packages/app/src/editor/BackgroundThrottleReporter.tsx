import { useEffect } from 'react';
import { useConfigContext } from '@/lib/config-context';
import { getPool, useDocumentContext } from './DocumentContext';
import { installBackgroundThrottleReporter } from './install-background-throttle-reporter';

export function BackgroundThrottleReporter(): null {
  const { collabUrl } = useDocumentContext();
  const { projectConfig } = useConfigContext();
  const enabled = projectConfig?.bridge?.backgroundThrottle?.enabled ?? true;

  useEffect(() => {
    if (collabUrl === null) return;
    const bridge = window.okDesktop;
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
