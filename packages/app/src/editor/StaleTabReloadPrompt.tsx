import { useEffect } from 'react';
import {
  installStaleTabReloadPrompt,
  waitForSavedWork,
  watchForSavedWork,
} from '@/lib/install-stale-tab-reload-prompt';
import { getPool, useDocumentContext } from './DocumentContext';

const SAVE_BEFORE_RELOAD_TIMEOUT_MS = 10_000;

export function StaleTabReloadPrompt(): null {
  const { collabUrl } = useDocumentContext();

  useEffect(() => {
    if (collabUrl === null) return;
    const pool = getPool(collabUrl);
    return installStaleTabReloadPrompt({
      bridge: window.okDesktop,
      waitForSavedWork: () => waitForSavedWork(pool, SAVE_BEFORE_RELOAD_TIMEOUT_MS),
      watchForSavedWork: (onSaved) => watchForSavedWork(pool, onSaved),
      docNamesToOpen: () => pool.docNamesToOpenForReplay(),
      reload: () => window.location.reload(),
    });
  }, [collabUrl]);

  return null;
}
