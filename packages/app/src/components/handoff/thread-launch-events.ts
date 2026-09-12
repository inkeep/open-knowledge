import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { OkNoteWindowMainAction } from '@inkeep/open-knowledge-core/desktop-bridge';
import { routeNoteWindowActionToMain } from '@/lib/note-window-main-actions';

const THREAD_LAUNCH_EVENT = 'open-knowledge:agent-thread-launch';

export interface AgentThreadLaunchDetail {
  readonly agentSource: 'registry' | 'custom';
  readonly agentId: string;
  readonly prompt: string | null;
  readonly docName: string | null;
  readonly titleHint: string | null;
  readonly attachments: readonly AttachmentPart[] | null;
}

type NoteWindowAgentThreadAction = Extract<OkNoteWindowMainAction, { kind: 'agent-thread' }>;

function toNoteWindowAgentThreadAction(
  detail: AgentThreadLaunchDetail,
): NoteWindowAgentThreadAction {
  const { agentSource, agentId, prompt, docName, titleHint } = detail;
  return { kind: 'agent-thread', agentSource, agentId, prompt, docName, titleHint };
}

function warnDroppedByNoteWindowChannel(
  detail: AgentThreadLaunchDetail,
  forwarded: NoteWindowAgentThreadAction,
): void {
  const forwardedKeys = new Set(Object.keys(forwarded));
  for (const [key, value] of Object.entries(detail)) {
    if (forwardedKeys.has(key)) continue;
    const droppedCount = Array.isArray(value) ? value.length : value == null ? 0 : 1;
    if (droppedCount > 0) {
      console.warn(
        `[agent-threads] the note-window launch channel carries no ${key} — dropping`,
        droppedCount,
        'value(s) from the forwarded launch',
      );
    }
  }
}

export function requestAgentThreadLaunch(
  detail: AgentThreadLaunchDetail,
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  const action = toNoteWindowAgentThreadAction(detail);
  if (routeNoteWindowActionToMain(action, target)) {
    warnDroppedByNoteWindowChannel(detail, action);
    return;
  }
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
