import { desktopChannelLabel } from '@inkeep/open-knowledge-core/constants/product';
import { t } from '@lingui/core/macro';
import { okCliCommandName } from '@/lib/channel-cli-copy';
import type { OkDesktopBridge, OkServerRestartFailure } from '@/lib/desktop-bridge-types';

export function restartServerFailureMessage(failure: OkServerRestartFailure): string {
  switch (failure.reason) {
    case 'other-channel':
      return otherChannelRestartMessage(failure.holderChannel);
    case 'eperm':
      return t`Couldn't restart the server — another process owns it. Quit other OpenKnowledge windows for this project, then try again.`;
    case 'other': {
      const cliCommand = okCliCommandName();
      return t`Couldn't restart the server. Try \`${cliCommand} start\` in this folder.`;
    }
    case 'unverified':
      return unverifiedHolderRestartMessage(failure.sigtermSent);
  }
}

export function unverifiedHolderRestartMessage(sigtermSent: boolean): string {
  return sigtermSent
    ? t`Couldn't restart the server: OpenKnowledge asked the process holding this project's server lock to stop, but could not confirm that it is this project's server, so it did not force it to quit. If the project is still locked, stop the server where it was started, or restart your computer, then reopen this project.`
    : t`Couldn't restart the server: OpenKnowledge could not confirm that the process holding this project's server lock is still its server, so it was not stopped. Stop the server where it was started, or restart your computer, then reopen this project.`;
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
