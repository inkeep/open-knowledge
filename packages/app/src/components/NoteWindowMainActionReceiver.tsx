import type { OkNoteWindowMainAction } from '@inkeep/open-knowledge-core/desktop-bridge';
import { useEffect } from 'react';
import { revealQueue } from '@/comments/reveal-queue';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { requestActiveTerminalInput } from '@/components/handoff/terminal-input-events';
import { requestTerminalLaunch } from '@/components/handoff/terminal-launch-events';
import { requestAgentThreadLaunch } from '@/components/handoff/thread-launch-events';
import { hashFromDocName, isSameHash } from '@/lib/doc-hash';
import { isNoteWindow } from '@/lib/note-window-mode';

export function dispatchNoteWindowMainAction(
  action: OkNoteWindowMainAction,
  target: Window | EventTarget,
): void {
  switch (action.kind) {
    case 'active-input':
      requestActiveTerminalInput(
        action.text,
        {
          newTab: action.newTab,
          submit: action.submit,
          target: action.target,
        },
        target,
      );
      return;
    case 'agent-thread':
      requestAgentThreadLaunch(
        {
          agentSource: action.agentSource,
          agentId: action.agentId,
          prompt: action.prompt,
          docName: action.docName,
          titleHint: action.titleHint,
        },
        target,
      );
      return;
    case 'terminal-launch':
      requestTerminalLaunch(action.prompt, action.cli, { stage: action.stage }, target);
      return;
    case 'reveal-comments': {
      if (action.scope === 'queue') {
        revealQueue();
        return;
      }
      requestDocPanelTab('comments', {}, target);
      if (typeof window === 'undefined' || target !== window) return;
      const nextHash = hashFromDocName(action.docName);
      if (!isSameHash(window.location.hash, nextHash)) window.location.hash = nextHash;
      return;
    }
  }
}

export function NoteWindowMainActionReceiver() {
  useEffect(() => {
    if (isNoteWindow()) return;
    const subscribe = window.okDesktop?.noteWindow?.onMainAction;
    if (typeof subscribe !== 'function') return;
    return subscribe((action) => dispatchNoteWindowMainAction(action, window));
  }, []);

  return null;
}
