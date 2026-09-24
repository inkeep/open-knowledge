import type { TerminalCli, TerminalLaunchCommand } from '@inkeep/open-knowledge-core';
import { routeNoteWindowActionToMain } from '@/lib/note-window-main-actions';

const TERMINAL_LAUNCH_EVENT = 'open-knowledge:terminal-launch';

export type TerminalLaunchRequest =
  | {
      readonly kind: 'cli';
      readonly prompt: string;
      readonly cli: TerminalCli;
      readonly stage: boolean;
      readonly signInThreadId?: string;
    }
  | {
      readonly kind: 'command';
      readonly command: TerminalLaunchCommand;
      readonly label: string;
      readonly signInThreadId?: string;
    };

export interface TerminalLaunchOptions {
  readonly stage?: boolean;
  readonly signInThreadId?: string;
}

export interface TerminalCommandLaunchRequest {
  readonly command: TerminalLaunchCommand;
  readonly label: string;
  readonly signInThreadId?: string;
}

type LaunchTarget = Pick<Window, 'dispatchEvent'> | EventTarget;

function defaultTarget(): LaunchTarget {
  return typeof window === 'undefined' ? new EventTarget() : window;
}

function dispatchLaunch(target: LaunchTarget, request: TerminalLaunchRequest): void {
  target.dispatchEvent(
    new CustomEvent<TerminalLaunchRequest>(TERMINAL_LAUNCH_EVENT, { detail: request }),
  );
}

export function requestTerminalLaunch(
  prompt: string,
  cli: TerminalCli,
  options?: TerminalLaunchOptions,
  target: LaunchTarget = defaultTarget(),
): void {
  const stage = options?.stage === true;
  if (routeNoteWindowActionToMain({ kind: 'terminal-launch', prompt, cli, stage }, target)) return;
  dispatchLaunch(target, {
    kind: 'cli',
    prompt,
    cli,
    stage,
    ...(options?.signInThreadId === undefined ? {} : { signInThreadId: options.signInThreadId }),
  });
}

export function requestTerminalCommandLaunch(
  request: TerminalCommandLaunchRequest,
  target: LaunchTarget = defaultTarget(),
): void {
  dispatchLaunch(target, { kind: 'command', ...request });
}

export function subscribeToTerminalLaunchRequests(
  onRequest: (request: TerminalLaunchRequest) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const listener = (event: Event) => {
    const detail: Record<string, unknown> | undefined =
      event instanceof CustomEvent && typeof event.detail === 'object' && event.detail !== null
        ? (event.detail as Record<string, unknown>)
        : undefined;
    if (detail === undefined) return;
    const signIn =
      typeof detail.signInThreadId === 'string' ? { signInThreadId: detail.signInThreadId } : {};
    if (detail.kind === 'command') {
      const command = detail.command;
      if (
        typeof command === 'object' &&
        command !== null &&
        typeof (command as { executable?: unknown }).executable === 'string' &&
        Array.isArray((command as { args?: unknown }).args) &&
        typeof detail.label === 'string'
      ) {
        onRequest({
          kind: 'command',
          command: command as TerminalLaunchCommand,
          label: detail.label,
          ...signIn,
        });
      }
      return;
    }
    if (detail.kind !== undefined && detail.kind !== 'cli') return;
    if (typeof detail.prompt !== 'string' || typeof detail.cli !== 'string') return;
    onRequest({
      kind: 'cli',
      prompt: detail.prompt,
      cli: detail.cli as TerminalCli,
      stage: detail.stage === true,
      ...signIn,
    });
  };
  target.addEventListener(TERMINAL_LAUNCH_EVENT, listener as EventListener);
  return () => target.removeEventListener(TERMINAL_LAUNCH_EVENT, listener as EventListener);
}
