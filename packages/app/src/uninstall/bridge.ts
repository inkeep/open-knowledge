/**
 * `window.okUninstall` — the uninstall renderer's only channel to the main
 * process. Exposed by `packages/desktop/src/preload/uninstall.ts`; the contract
 * types are declared once in core and imported here as types only, so nothing
 * from that package reaches this entry's runtime graph.
 *
 * Absent outside Electron (a browser opening `uninstall.html` directly, a dom
 * test rendering a screen), so every accessor tolerates its absence — there is
 * no meaningful uninstall to drive without a main process behind it.
 */

import type {
  OkUninstallBridge,
  UninstallIntent,
  UninstallScreenSpec,
} from '@inkeep/open-knowledge-core';

declare global {
  interface Window {
    okUninstall?: OkUninstallBridge;
  }
}

/**
 * Ask main which screen this window is. `null` when there is no bridge, when
 * the `ready` invoke rejects (an IPC-level failure), or when main refused — a
 * refusal means this window is not one main is waiting on, which no amount of
 * retrying changes.
 */
export async function requestUninstallScreen(): Promise<UninstallScreenSpec | null> {
  const bridge = typeof window === 'undefined' ? undefined : window.okUninstall;
  if (bridge === undefined) return null;
  try {
    const result = await bridge.ready();
    return result.kind === 'screen' ? result.screen : null;
  } catch {
    // A rejected invoke (the channel torn down, or a future throw in main) is
    // as unrecoverable as a `refused`, and the caller does not `.catch()`.
    // Return null so the window keeps its loading placeholder rather than
    // hanging on a discarded rejection.
    return null;
  }
}

/**
 * Report a user action. Fire-and-forget by design: an intent that settles a
 * screen makes main destroy this window, which tears the channel down under the
 * in-flight invoke, so a rejection here says nothing about whether main acted.
 * The screen's own teardown is the acknowledgement.
 */
export function sendUninstallIntent(intent: UninstallIntent): void {
  const bridge = typeof window === 'undefined' ? undefined : window.okUninstall;
  if (bridge === undefined) return;
  void bridge.send(intent).catch(() => undefined);
}
