import { desktopChannelLabel } from '@inkeep/open-knowledge-core/constants/product';
import { t } from '@lingui/core/macro';
import type { OkDesktopBridge, OkServerRestartFailure } from '@/lib/desktop-bridge-types';

export function restartServerFailureMessage(failure: OkServerRestartFailure): string {
  switch (failure.reason) {
    case 'other-channel':
      return otherChannelRestartMessage(failure.holderChannel);
    case 'eperm':
      return t`Couldn't restart the server — another process owns it. Quit other OpenKnowledge windows for this project, then try again.`;
    case 'other':
      return t`Couldn't restart the server. Try \`ok start\` in this folder.`;
  }
}

export function otherChannelRestartMessage(holderChannel: string): string {
  const holder = desktopChannelLabel(holderChannel);
  return t`${holder} is serving this project, so this app won't stop it. Close this window and open the project again to stop ${holder}'s server and open the project here.`;
}

export async function restartCollabServer(
  bridge: Pick<OkDesktopBridge, 'restartServer' | 'config'>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const outcome = await bridge.restartServer(bridge.config.projectPath);
  if (outcome.ok) return { ok: true };
  return { ok: false, message: restartServerFailureMessage(outcome) };
}
