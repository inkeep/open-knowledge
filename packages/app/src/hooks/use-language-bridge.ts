import type { LanguagePreference } from '@inkeep/open-knowledge-core';
import { useEffect } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export function useLanguageBridge(
  bridge: OkDesktopBridge | undefined,
  preference: LanguagePreference | undefined,
  synced: boolean,
): void {
  useEffect(() => {
    if (!bridge || !synced) return;
    if (typeof bridge.setLanguagePreference !== 'function') return;
    bridge.setLanguagePreference(preference ?? 'system').catch((err: unknown) => {
      console.warn(
        JSON.stringify({
          event: 'language-preference-push-failed',
          preference: preference ?? 'system',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }, [bridge, preference, synced]);
}
