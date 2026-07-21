/**
 * Window-scoped pub/sub carrying an "open an agent thread" launch from the
 * handoff menus to the dock (whose open-state + launch intent live in
 * EditorPane) — the ACP twin of `terminal-launch-events.ts`.
 *
 * The payload names a catalog agent (registry manifest id or custom entry id)
 * plus the composed prompt (never a command). Works on BOTH hosts — agent
 * threads are server-hosted, so unlike the terminal channel this one has no
 * desktop gate.
 */

const THREAD_LAUNCH_EVENT = 'open-knowledge:agent-thread-launch';

export interface AgentThreadLaunchDetail {
  readonly agentSource: 'registry' | 'custom';
  readonly agentId: string;
  /** Composed scope prompt, or null for a promptless "new chat". */
  readonly prompt: string | null;
  /** Extension-less docName context the launch came from, when any. */
  readonly docName: string | null;
  /**
   * The user's raw typed text (create brief / instruction) for title
   * derivation — kept out of `prompt` so the composed handoff preamble never
   * becomes the tab label. Null when the launch carried no typed text.
   */
  readonly titleHint: string | null;
}

export function requestAgentThreadLaunch(
  detail: AgentThreadLaunchDetail,
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
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
