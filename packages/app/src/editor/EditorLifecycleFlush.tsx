import { useEffect } from 'react';
import { useConfigContext } from '@/lib/config-context';
import { getPool, useDocumentContext } from './DocumentContext';
import { installEditorLifecycleFlush } from './install-editor-lifecycle-flush';

/**
 * Wires tab-lifecycle background flush / resync to the provider pool and
 * honors the `bridge.flushOnHide.enabled` kill-switch. Renders nothing.
 *
 * Mounted under both DocumentProvider (for `collabUrl` → the pool) and
 * ConfigProvider (for the project config). The kill-switch defaults ON until
 * the config doc syncs (`projectConfig` null), matching the schema default.
 */
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
