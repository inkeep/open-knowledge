import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { useEffect, useRef, useState } from 'react';

const INSTALLING_SHOW_DELAY_MS = 200;
const INSTALLING_MIN_VISIBLE_MS = 300;

export function useDelayedInstallStatus(status: ThreadInfo['status']): ThreadInfo['status'] {
  const [installVisible, setInstallVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (status === 'installing') {
      if (shownAt.current !== null) return;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setInstallVisible(true);
      }, INSTALLING_SHOW_DELAY_MS);
      return () => {
        clearTimeout(timer);
      };
    }
    if (shownAt.current === null) return;
    if (status !== 'spawning') {
      shownAt.current = null;
      setInstallVisible(false);
      return;
    }
    const remaining = Math.max(0, INSTALLING_MIN_VISIBLE_MS - (Date.now() - shownAt.current));
    const timer = setTimeout(() => {
      shownAt.current = null;
      setInstallVisible(false);
    }, remaining);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);

  if (status === 'installing') return installVisible ? 'installing' : 'spawning';
  if (status === 'spawning' && installVisible) return 'installing';
  return status;
}
