const SIGN_IN_TERMINAL_EXIT_EVENT = 'open-knowledge:sign-in-terminal-exit';

interface SignInTerminalExitDetail {
  readonly threadId: string;
}

export function notifySignInTerminalExited(
  threadId: string,
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  target.dispatchEvent(
    new CustomEvent<SignInTerminalExitDetail>(SIGN_IN_TERMINAL_EXIT_EVENT, {
      detail: { threadId },
    }),
  );
}

export function subscribeToSignInTerminalExits(
  onExit: (threadId: string) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const listener = (event: Event) => {
    const detail =
      event instanceof CustomEvent
        ? (event as CustomEvent<SignInTerminalExitDetail>).detail
        : undefined;
    if (detail && typeof detail.threadId === 'string') onExit(detail.threadId);
  };
  target.addEventListener(SIGN_IN_TERMINAL_EXIT_EVENT, listener as EventListener);
  return () => target.removeEventListener(SIGN_IN_TERMINAL_EXIT_EVENT, listener as EventListener);
}
