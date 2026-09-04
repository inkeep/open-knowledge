import { routeNoteWindowActionToMain } from '@/lib/note-window-main-actions';

const ACTIVE_TERMINAL_INPUT_EVENT = 'open-knowledge:active-terminal-input';

export interface ActiveTerminalInputDetail {
  readonly text: string;
  readonly newTab: boolean;
  readonly submit: boolean;
  readonly target?: 'agents';
}

export function requestActiveTerminalInput(
  text: string,
  options?: { newTab?: boolean; submit?: boolean; target?: 'agents' },
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  const detail: ActiveTerminalInputDetail = {
    text,
    newTab: options?.newTab === true,
    submit: options?.submit === true,
    ...(options?.target === 'agents' ? { target: 'agents' as const } : {}),
  };
  if (routeNoteWindowActionToMain({ kind: 'active-input', ...detail }, target)) return;
  target.dispatchEvent(
    new CustomEvent<ActiveTerminalInputDetail>(ACTIVE_TERMINAL_INPUT_EVENT, {
      detail,
    }),
  );
}

export function subscribeToActiveTerminalInput(
  onRequest: (detail: ActiveTerminalInputDetail) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const listener = (event: Event) => {
    const detail =
      event instanceof CustomEvent
        ? (event as CustomEvent<ActiveTerminalInputDetail>).detail
        : undefined;
    if (detail !== undefined && typeof detail.text === 'string') {
      onRequest({
        text: detail.text,
        newTab: detail.newTab === true,
        submit: detail.submit === true,
        ...(detail.target === 'agents' ? { target: 'agents' as const } : {}),
      });
    }
  };
  target.addEventListener(ACTIVE_TERMINAL_INPUT_EVENT, listener as EventListener);
  return () => target.removeEventListener(ACTIVE_TERMINAL_INPUT_EVENT, listener as EventListener);
}
