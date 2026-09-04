import { getMeter, withSpanSync } from '@inkeep/open-knowledge-server';
import type { OkSlidesOpenResult } from '../shared/ipc-channels.ts';

let _deckOpenFailureCounterCache: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function deckOpenFailureCounter() {
  _deckOpenFailureCounterCache ||= getMeter().createCounter('ok.slides.deck_open.failures', {
    description: 'Count of Slidev deck-open failures, labeled by reason',
  });
  return _deckOpenFailureCounterCache;
}

export function recordDeckOpen(result: OkSlidesOpenResult): void {
  if (result.ok) {
    withSpanSync(
      'ok.slides.deckOpen',
      { attributes: { 'ok.slides.outcome': 'ok' } },
      () => undefined,
    );
    return;
  }
  withSpanSync(
    'ok.slides.deckOpen',
    { attributes: { 'ok.slides.outcome': 'failure', 'ok.slides.reason': result.reason } },
    () => undefined,
  );
  deckOpenFailureCounter().add(1, { 'ok.slides.reason': result.reason });
}
