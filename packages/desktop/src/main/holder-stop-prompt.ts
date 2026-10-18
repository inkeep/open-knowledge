import { desktopChannelLabel } from '@inkeep/open-knowledge-core';
import { stopCommandLine } from './stop-command.ts';
import {
  type ForceStopOutcome,
  isOtherChannelHolderError,
  type OtherChannelHolder,
  otherChannelStopOffer,
  type WindowManager,
} from './window-manager.ts';

const OTHER_CHANNEL_DIALOG_TITLE = 'This project is open in another OpenKnowledge app';

export function failedOpenHolder(
  err: unknown,
  projectPath: string,
  wm: Pick<WindowManager, 'otherChannelLockHolder'> | undefined,
): OtherChannelHolder | null {
  if (isOtherChannelHolderError(err)) return err;
  return wm === undefined ? null : wm.otherChannelLockHolder(projectPath);
}

export interface HolderStopPromptInput {
  projectPath: string;
  kind: string | undefined;
  errorMessage: string;
  dialogTitle: string;
  dialogBody: string;
  otherChannelHolder: OtherChannelHolder | null;
  warnsHolderMayBeLive: boolean;
  holderIsOwnChild: boolean;
}

export interface HolderStopPromptDeps {
  showMessageBox(options: {
    type: 'warning';
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
  }): Promise<{ response: number }>;
  forceStop(expectedHolder?: { pid: number; channel: string }): Promise<ForceStopOutcome>;
  retryOpen(): Promise<boolean>;
  reopen(): Promise<boolean>;
}

export type HolderStopPromptResult =
  | { kind: 'not-offered' }
  | { kind: 'declined' }
  | { kind: 'reopened'; opened: boolean }
  | { kind: 'stop-failed'; reason: 'eperm' | 'other' }
  | { kind: 'stop-failed'; reason: 'unverified'; sigtermSent: boolean }
  | { kind: 'retried'; opened: boolean };

export async function promptHolderStop(
  input: HolderStopPromptInput,
  deps: HolderStopPromptDeps,
): Promise<HolderStopPromptResult> {
  const holder = input.otherChannelHolder;
  const holderInTheWay =
    input.kind === 'other-channel-holder' ||
    input.kind === 'lock-collision' ||
    input.kind === 'stale-lock-holder' ||
    (input.kind === 'spawn-lock-timeout' && input.errorMessage.includes('already running'));
  if (!holderInTheWay) return { kind: 'not-offered' };
  const offer = holder === null ? null : otherChannelStopOffer(holder);
  const title = holder === null ? input.dialogTitle : OTHER_CHANNEL_DIALOG_TITLE;
  const body =
    holder === null || input.kind === 'other-channel-holder'
      ? input.dialogBody
      : `${input.projectPath}\n\n${desktopChannelLabel(holder.holderChannel)} holds ` +
        `this project's server lock (pid ${holder.holderPid}) and may still be serving it.`;
  const { response } = await deps.showMessageBox({
    type: 'warning',
    title,
    message: title,
    detail:
      `${body}\n\n` +
      (offer !== null
        ? offer.detail
        : input.warnsHolderMayBeLive
          ? `OpenKnowledge can stop that process and retry opening the project. It may still be ` +
            `running, so stop it only if you do not need it.`
          : input.holderIsOwnChild
            ? `OpenKnowledge already asked that server to stop during this open. It can make ` +
              `sure it is gone and try again.`
            : `OpenKnowledge can stop the conflicting server process and retry opening the project.`),
    buttons: [offer?.button ?? 'Stop Server & Retry', 'Cancel'],
    defaultId: input.warnsHolderMayBeLive || offer !== null ? 1 : 0,
    cancelId: 1,
  });
  if (response !== 0) return { kind: 'declined' };
  const stop = await deps.forceStop(
    holder === null ? undefined : { pid: holder.holderPid, channel: holder.holderChannel },
  );
  if (stop.ok) return { kind: 'retried', opened: await deps.retryOpen() };
  if (stop.reason === 'holder-changed') return { kind: 'reopened', opened: await deps.reopen() };
  if (stop.reason === 'unverified') {
    return { kind: 'stop-failed', reason: 'unverified', sigtermSent: stop.sigtermSent };
  }
  return { kind: 'stop-failed', reason: stop.reason };
}

export function describeStopFailure(
  failure: Extract<HolderStopPromptResult, { kind: 'stop-failed' }>,
  projectPath: string,
  platform: NodeJS.Platform,
): string {
  switch (failure.reason) {
    case 'eperm':
      return 'The conflicting server belongs to another user account and cannot be stopped from here. Quit it from that account and try again.';
    case 'unverified':
      return failure.sigtermSent
        ? "OpenKnowledge asked the process holding this project's server lock to stop, but could not confirm that it is this project's server, so it did not force it to quit. Wait a moment and try again. If the project is still locked, stop the server where it was started, or restart your computer."
        : "Could not confirm that the process holding this project's server lock is still its server, so it was not stopped. Stop the server where it was started, or restart your computer, then try again.";
    case 'other':
      return `Could not stop the conflicting server. Quit it manually (\`${stopCommandLine(projectPath, platform, { force: true })}\`) and try again.`;
    default: {
      const _exhaustive: never = failure;
      return _exhaustive;
    }
  }
}
