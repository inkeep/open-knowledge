/**
 * Install the subscriber for `ok:project:recent-removed-missing`. Main fires
 * this at the window that initiated a recents open of a folder that no longer
 * exists on disk — VS Code "Open Recent" parity: opening a vanished recent
 * prunes it from the (single) recents list rather than spawning a broken
 * window. Surface a lightweight toast so the user learns the stale entry was
 * cleaned up. The Navigator additionally drops the row from its own list — that
 * list-mutation lives in NavigatorApp, which owns the React state; this module
 * only owns the toast, so both window kinds get identical feedback.
 *
 * Registered imperatively during `main.tsx` module init so the listener is in
 * place before the event can fire. No-op in web / CLI distribution
 * (`window.okDesktop` undefined). Copy is wrapped in the Lingui `t` macro
 * inside the callback so it resolves against the active locale at fire time
 * (this module has no React context; it relies on the global `i18n` singleton
 * activated by `@/lib/i18n`, imported before this listener in `main.tsx`).
 */

import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

/** Toast copy for a lazily-pruned missing recent. Pure — exported for tests. */
export function recentRemovedMissingMessage(projectName: string): string {
  return t`Removed "${projectName}" from recent projects. Its folder no longer exists.`;
}

export function installRecentRemovedListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  const bridge = opts.bridge;
  if (!bridge) return undefined;
  return bridge.onRecentRemovedMissing(({ projectName }) => {
    toast(recentRemovedMissingMessage(projectName));
  });
}
