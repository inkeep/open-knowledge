/**
 * Jump from a comment to the passage it is anchored to.
 *
 * The queue is project-wide, so the target doc is often NOT the one on screen.
 * That makes this two steps rather than one: navigate if needed, then wait for
 * that document's editor to actually mount before selecting the passage — a
 * jump issued during navigation would land on an editor that doesn't exist yet
 * and silently do nothing.
 *
 * The passage is located by its quoted text, the same durable record the anchor
 * itself is built on, so this keeps working after the text has moved.
 */

import { requestDocPanelTab } from '@/components/doc-panel-events';
import { getEditorForDoc, subscribeEditorRegistry } from '@/editor/active-editor';
import { hashFromDocName } from '@/lib/doc-hash';
import { type AnchorContext, findQuoteRange } from './anchor-search';
import { scrollAnchorIntoView } from './scroll-to-anchor';
import { emitFocusThread } from './store';

/** Give up waiting for an editor that never mounts (bad docName, failed load). */
const EDITOR_WAIT_MS = 10_000;

/**
 * Select + scroll to a comment's passage, navigating to its document first when
 * it isn't the one open. Also opens the Comments tab so the thread is visible
 * beside the passage it belongs to.
 */
export function revealComment(input: {
  docName: string;
  quote: string;
  threadId: string;
  /** Stored context — disambiguates a quote that appears more than once. */
  context?: AnchorContext;
}): void {
  const focusInEditor = (): boolean => {
    const editor = getEditorForDoc(input.docName);
    if (!editor || editor.isDestroyed) return false;
    const range = findQuoteRange(editor.state.doc, input.quote, input.context);
    // The doc is open but the words are gone (an orphaned anchor). Still count
    // it as handled — navigation succeeded; there is simply nothing to select.
    if (range) {
      editor.chain().focus().setTextSelection(range).run();
      scrollAnchorIntoView(editor, range);
    }
    emitFocusThread(input.threadId);
    return true;
  };

  requestDocPanelTab('comments');
  if (focusInEditor()) return;

  window.location.assign(hashFromDocName(input.docName));

  // The editor registers itself once mounted; retry on each registry change
  // rather than guessing at a fixed delay.
  let settled = false;
  const stop = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    window.clearTimeout(timer);
  };
  const unsubscribe = subscribeEditorRegistry(() => {
    if (focusInEditor()) stop();
  });
  const timer = window.setTimeout(stop, EDITOR_WAIT_MS);
  // The editor may already have been registered between the two calls above.
  if (focusInEditor()) stop();
}
