import { t } from '@lingui/core/macro';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export function restartServerFailureMessage(reason: 'eperm' | 'other'): string {
  return reason === 'eperm'
    ? t`Couldn't restart the server — another process owns it. Quit other OpenKnowledge windows for this project, then try again.`
    : t`Couldn't restart the server. Try \`ok start\` in this folder.`;
}

export async function restartCollabServer(
  bridge: Pick<OkDesktopBridge, 'restartServer' | 'config'>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const outcome = await bridge.restartServer(bridge.config.projectPath);
  if (outcome.ok) return { ok: true };
  return { ok: false, message: restartServerFailureMessage(outcome.reason) };
}
