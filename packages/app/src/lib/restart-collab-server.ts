import { t } from '@lingui/core/macro';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

/**
 * Restart a stopped collab server from the renderer.
 *
 * When a project's server exits mid-session (`ok stop`, an idle-shutdown that
 * fired while the window was open, a crash), reconnecting is futile — there is
 * no server to reach. The only recovery is to spawn a fresh one, which the
 * desktop bridge's `restartServer` does (it reads the now-absent lock and boots
 * a new server + window). Browser (`ok ui`) mode has no such bridge, so these
 * helpers are only reachable behind a `window.okDesktop` guard at the call site.
 */

/** Map a failed `restartServer` outcome reason to a user-facing message. */
export function restartServerFailureMessage(reason: 'eperm' | 'other'): string {
  return reason === 'eperm'
    ? t`Couldn't restart the server — another process owns it. Quit other OpenKnowledge windows for this project, then try again.`
    : t`Couldn't restart the server. Try \`ok start\` in this folder.`;
}

/**
 * Ask the desktop main process to restart this project's server.
 *
 * On success the main process tears this window down and recreates it, so the
 * awaited invoke may reject or never resolve; the caller treats a throw as
 * "restart in progress" and stops. Only a resolved `{ ok: false }` is a real
 * failure the user can act on.
 */
export async function restartCollabServer(
  bridge: Pick<OkDesktopBridge, 'restartServer' | 'config'>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const outcome = await bridge.restartServer(bridge.config.projectPath);
  if (outcome.ok) return { ok: true };
  return { ok: false, message: restartServerFailureMessage(outcome.reason) };
}
