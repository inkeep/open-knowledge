import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { getVisibleEditorForDoc, subscribeEditorRegistry } from '@/editor/active-editor';
import { hashFromDocName } from '@/lib/doc-hash';
import { type AnchorContext, findQuoteRange } from './anchor-search';
import { scrollAnchorIntoView } from './scroll-to-anchor';
import { emitFocusThread, emitOpenThread } from './store';

const REVEAL_WAIT_MS = 10_000;

const RETRY_MS = 80;

const SETTLE_MS = 1_500;

const INTENT_EVENTS = ['wheel', 'touchstart', 'mousedown', 'keydown'] as const;

export function revealComment(input: {
  docName: string;
  quote: string;
  threadId: string;
  context?: AnchorContext;
}): void {
  let announced = false;
  let landedAt: number | null = null;
  let range: { from: number; to: number } | null = null;
  let sizeAtLastFind = -1;

  const attempt = (): boolean => {
    const editor = getVisibleEditorForDoc(input.docName);
    if (!editor || editor.isDestroyed) return false;
    if (!announced) {
      announced = true;
      emitFocusThread(input.threadId);
    }
    if (input.quote === '') {
      if (landedAt === null) {
        landedAt = Date.now();
        emitOpenThread(input.threadId);
      }
      return true;
    }
    const size = editor.state.doc.content.size;
    if (range === null || size !== sizeAtLastFind) {
      range = findQuoteRange(editor.state.doc, input.quote, input.context);
      sizeAtLastFind = size;
    }
    if (!range) return false;
    if (!scrollAnchorIntoView(editor, range, input.docName, { instant: true })) return false;
    if (landedAt === null) {
      landedAt = Date.now();
      emitOpenThread(input.threadId);
    }
    return true;
  };

  requestDocPanelTab('comments');
  attempt();

  if (getVisibleEditorForDoc(input.docName) === null) {
    window.location.assign(hashFromDocName(input.docName));
  }

  let settled = false;
  const stop = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    window.clearInterval(ticker);
    window.clearTimeout(deadline);
    for (const event of INTENT_EVENTS) window.removeEventListener(event, onIntent, true);
  };
  const onIntent = (): void => stop();
  const tick = (): void => {
    if (attempt() && landedAt !== null && Date.now() - landedAt >= SETTLE_MS) stop();
  };
  const unsubscribe = subscribeEditorRegistry(tick);
  const ticker = window.setInterval(tick, RETRY_MS);
  const deadline = window.setTimeout(() => {
    if (landedAt === null) {
      toast.error(
        announced
          ? t`Couldn't find that passage — the text it was on may have changed.`
          : t`That document didn't open in time. Try again once it has synced.`,
      );
    }
    stop();
  }, REVEAL_WAIT_MS);
  for (const event of INTENT_EVENTS) window.addEventListener(event, onIntent, true);
  tick();
}
