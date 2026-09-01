import { routeNoteWindowActionToMain } from '@/lib/note-window-main-actions';

const THREAD_LAUNCH_EVENT = 'open-knowledge:agent-thread-launch';

export interface AgentThreadLaunchDetail {
  readonly agentSource: 'registry' | 'custom';
  readonly agentId: string;
  readonly prompt: string | null;
  readonly docName: string | null;
  readonly titleHint: string | null;
}

export function requestAgentThreadLaunch(
  detail: AgentThreadLaunchDetail,
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  if (routeNoteWindowActionToMain({ kind: 'agent-thread', ...detail }, target)) return;
  target.dispatchEvent(new CustomEvent<AgentThreadLaunchDetail>(THREAD_LAUNCH_EVENT, { detail }));
}

export function subscribeToAgentThreadLaunchRequests(
  onRequest: (detail: AgentThreadLaunchDetail) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const listener = (event: Event) => {
    const detail =
      event instanceof CustomEvent
        ? (event as CustomEvent<AgentThreadLaunchDetail>).detail
        : undefined;
    if (detail && typeof detail.agentId === 'string') onRequest(detail);
  };
  target.addEventListener(THREAD_LAUNCH_EVENT, listener as EventListener);
  return () => target.removeEventListener(THREAD_LAUNCH_EVENT, listener as EventListener);
}
