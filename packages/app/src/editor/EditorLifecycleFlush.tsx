import { useEffect } from 'react';
import { useConfigContext } from '@/lib/config-context';
import { getPool, useDocumentContext } from './DocumentContext';
import { installEditorLifecycleFlush } from './install-editor-lifecycle-flush';

export function EditorLifecycleFlush(): null {
  const { collabUrl } = useDocumentContext();
  const { projectConfig } = useConfigContext();
  const enabled = projectConfig?.bridge?.flushOnHide?.enabled ?? true;

  useEffect(() => {
    if (collabUrl === null) return;
    const pool = getPool(collabUrl);
    pool.setFlushOnHideEnabled(enabled);
    return installEditorLifecycleFlush({
      onHide: () => pool.flushOnHide(),
      onVisible: () => pool.resyncOnVisible(),
    });
  }, [collabUrl, enabled]);

  return null;
}
