import { useEffect } from 'react';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { getSelectedQueue, getSelectedQueueForDoc } from './store';
import { useSendQueue } from './use-send-queue';
import { getVisibleCommentScope } from './visible-scope';

export function CommentQueueShortcut() {
  const sendQueue = useSendQueue();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!matchesKeyboardShortcut(event, 'send-comment-queue')) return;
      if (isOverlayLayerOpen()) return;
      const visible = getVisibleCommentScope();
      if (visible === null) return;
      const ids =
        visible.scope === 'doc' ? getSelectedQueueForDoc(visible.docName) : getSelectedQueue();
      if (ids.length === 0) return;
      event.preventDefault();
      sendQueue(ids);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sendQueue]);

  return null;
}
