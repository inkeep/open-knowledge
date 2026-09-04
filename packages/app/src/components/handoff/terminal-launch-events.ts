import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { routeNoteWindowActionToMain } from '@/lib/note-window-main-actions';

const TERMINAL_LAUNCH_EVENT = 'open-knowledge:terminal-launch';

interface TerminalLaunchDetail {
  readonly prompt: string;
  readonly cli: TerminalCli;
  readonly stage: boolean;
}

export interface TerminalLaunchOptions {
  readonly stage?: boolean;
}

export function requestTerminalLaunch(
  prompt: string,
  cli: TerminalCli,
  options?: TerminalLaunchOptions,
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  if (
    routeNoteWindowActionToMain(
      {
        kind: 'terminal-launch',
        prompt,
        cli,
        stage: options?.stage === true,
      },
      target,
    )
  )
    return;
  target.dispatchEvent(
    new CustomEvent<TerminalLaunchDetail>(TERMINAL_LAUNCH_EVENT, {
      detail: { prompt, cli, stage: options?.stage === true },
    }),
  );
}

export function subscribeToTerminalLaunchRequests(
  onRequest: (prompt: string, cli: TerminalCli, options: { stage: boolean }) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const listener = (event: Event) => {
    const detail =
      event instanceof CustomEvent
        ? (event as CustomEvent<TerminalLaunchDetail>).detail
        : undefined;
    if (detail && typeof detail.prompt === 'string') {
      onRequest(detail.prompt, detail.cli, { stage: detail.stage === true });
    }
  };
  target.addEventListener(TERMINAL_LAUNCH_EVENT, listener as EventListener);
  return () => target.removeEventListener(TERMINAL_LAUNCH_EVENT, listener as EventListener);
}
