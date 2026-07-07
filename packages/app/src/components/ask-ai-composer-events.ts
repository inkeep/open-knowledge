/**
 * Window-scoped pub/sub that asks the docked "Ask AI" composer to open and take
 * focus — the same open+focus path the ⌘L shortcut runs. Both the ⌘L handler
 * and the editor's "Ask AI" selection affordance (the WYSIWYG bubble menu) fire
 * this so the expand/reopen + focus logic lives in exactly one place
 * (`BottomComposer`'s subscriber), never duplicated at the call sites.
 *
 * Mirrors the `terminal-launch-events` / `doc-panel-events` idiom: the bubble
 * menu lives inside the editor subtree while the composer's dismissed-state +
 * input ref live in `EditorArea`/`BottomComposer`; they are siblings under the
 * app shell, so a context alone cannot thread the intent between them without
 * lifting ownership. The signal is intent-only — no payload.
 */

const OPEN_ASK_AI_COMPOSER_EVENT = 'open-knowledge:open-ask-ai-composer';

export function emitOpenAskAiComposer(
  target: Pick<Window, 'dispatchEvent'> | EventTarget = typeof window === 'undefined'
    ? new EventTarget()
    : window,
): void {
  target.dispatchEvent(new CustomEvent(OPEN_ASK_AI_COMPOSER_EVENT));
}

export function subscribeToOpenAskAiComposer(
  onRequest: () => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = typeof window ===
  'undefined'
    ? new EventTarget()
    : window,
): () => void {
  const listener = () => onRequest();
  target.addEventListener(OPEN_ASK_AI_COMPOSER_EVENT, listener as EventListener);
  return () => target.removeEventListener(OPEN_ASK_AI_COMPOSER_EVENT, listener as EventListener);
}
