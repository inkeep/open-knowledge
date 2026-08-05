import type { LanguagePreference } from '@inkeep/open-knowledge-core';
import { useEffect } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

/**
 * Push the interface-language preference to Electron main so the native menu
 * bar tracks the picker without a restart.
 *
 * The value crosses IPC **unresolved** — `'system'` arrives as `'system'`, and
 * main re-resolves it against the OS preferred-language list on its own side.
 * Resolving here would hand main a concrete tag that silently stops following
 * the OS, which is the same one-way contract `useThemeBridge` keeps for theme.
 *
 * Only subsequent changes travel this way. Main reads the persisted preference
 * off disk at boot, because the menu is built before any renderer exists — an
 * IPC-only design would put an English menu bar on every cold start.
 *
 * No-ops in the browser build, where there is no bridge. Failure is
 * best-effort: the menu stays on the previous language and the next config
 * mutation re-fires this.
 */
export function useLanguageBridge(
  bridge: OkDesktopBridge | undefined,
  preference: LanguagePreference | undefined,
  synced: boolean,
): void {
  useEffect(() => {
    if (!bridge || !synced) return;
    // Feature-detected, not assumed: this method is newer than the bridge shape
    // itself, so a renderer can meet a preload that predates it — during a
    // version-skewed update, or in a test that stands up its own bridge stub.
    // Calling straight through would not degrade to "no menu translation"; the
    // `.catch()` on a non-function throws inside the effect, which reaches the
    // error boundary and takes the whole app shell down over a menu label.
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
