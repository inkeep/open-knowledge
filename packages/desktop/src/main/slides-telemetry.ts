/**
 * Slides (Slidev) deck-open telemetry — the main-side half.
 *
 * A deck-open attempt that reaches the spawn/readiness path emits one
 * `ok.slides.deckOpen` span carrying a bounded outcome, and on failure the
 * bounded reason that separates a spawn failure from a readiness timeout.
 * Failures also increment a reason-labeled counter so the failure rate reads
 * off metrics independently of trace sampling. The pre-attempt guard rejections
 * (`invalid-path` / `not-available`) are logged at the IPC boundary instead of
 * spanned here, so the span's denominator stays genuine spawn attempts.
 *
 * Attributes are bounded-cardinality only — a two-bucket outcome and the closed
 * failure-reason union; never a deck path, document name, or content. The
 * counter is created behind a lazily-cached accessor, mirroring the sibling
 * `ok.shell.trash_item` meters, so an SDK-disabled build (the default) creates
 * no instrument at module load; `withSpanSync` / `getMeter` are themselves
 * no-ops when no SDK is registered, so telemetry-off behaves identically.
 */

import { getMeter, withSpanSync } from '@inkeep/open-knowledge-server';
import type { OkSlidesOpenResult } from '../shared/ipc-channels.ts';

let _deckOpenFailureCounterCache: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function deckOpenFailureCounter() {
  _deckOpenFailureCounterCache ||= getMeter().createCounter('ok.slides.deck_open.failures', {
    // The metric NAME stays `ok.slides.*` — it is a stable telemetry key that
    // outlives the plugin's display name. Only the human-readable description
    // tracks the rename.
    description: 'Count of Slidev deck-open failures, labeled by reason',
  });
  return _deckOpenFailureCounterCache;
}

/**
 * Record one deck-open attempt. `ok.slides.outcome` partitions success from
 * failure; on failure `ok.slides.reason` carries the closed
 * `SlidevOpenFailureReason` so a spawn fault is separable from a readiness
 * timeout. SDK disabled → both the span and the counter are no-ops.
 */
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
