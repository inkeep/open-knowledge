
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
