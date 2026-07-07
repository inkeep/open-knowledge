/**
 * Hocuspocus extension that emits a `sync.handshake` span at the server-side
 * sync-handshake site.
 *
 * The persistence layer
 * already emits its own `persistence.onLoadDocument` span; this extension
 * provides a sibling correlation marker the convention-cap-graduation sweep
 * queries from Tempo to attribute per-cycle latency to a specific mountId.
 *
 * Span attributes (bounded-cardinality):
 *   - `doc.name`: the Hocuspocus documentName — pre-validated string
 *   - `mountId`: UUID-shape validated, extracted from the WS URL query
 *     params (the same `requestParameters` URLSearchParams that carry
 *     `traceparent` / `tracestate`). Omitted when absent OR when the
 *     supplied value does not match the UUID shape — a free-form string
 *     would otherwise inflate Tempo's attribute index. Legitimate
 *     mountIds always come from `crypto.randomUUID()` on the frontend.
 *
 * Skips synthetic docs (`__system__`, `__config__/project`, etc.) because
 * those bypass the markdown bridge entirely and don't participate in the
 * sweep's distribution-measurement substrate.
 *
 * Zero-overhead when OTel is disabled: `withSpan` returns a no-op
 * tracer's span when `OTEL_SDK_DISABLED !== 'false'` (see telemetry.ts).
 *
 * Span emission is wrapped in try/catch so a misbehaving OTel SDK fault
 * cannot propagate through Hocuspocus's `afterLoadDocument` chain and
 * close the WebSocket via the outer ResetConnection path (caller's
 * try/catch in `setUpNewConnection` rethrows otherwise). The OTel API
 * contract says start/end must not throw, but instrumentation failure
 * must not fail the sync handshake.
 */
import type { Extension } from '@hocuspocus/server';
import type { Attributes } from '@opentelemetry/api';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { withSpanSync } from './telemetry.ts';

/**
 * UUID v4 shape: 8-4-4-4-12 hex with the version nibble pinned to `4`
 * and the variant nibble in `[89ab]`. Matches what `crypto.randomUUID()`
 * produces on every browser / Node target the frontend runs against.
 * Case-insensitive — some platforms emit uppercase hex.
 */
const MOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSyncHandshakeSpanExtension(): Extension {
  return {
    async afterLoadDocument({ documentName, requestParameters }) {
      if (isSystemDoc(documentName) || isConfigDoc(documentName)) return;

      const mountId = requestParameters?.get('mountId') ?? undefined;
      const attributes: Attributes = { 'doc.name': documentName };
      if (mountId !== undefined && MOUNT_ID_PATTERN.test(mountId)) {
        attributes['mount.id'] = mountId;
      }

      // Marker span — duration is intentionally minimal. The actual
      // load-from-disk timing lives in `persistence.onLoadDocument` (a
      // sibling span emitted from persistence.ts). This span's role is
      // cross-cycle correlation: the sweep's Tempo query joins span trees
      // by mountId attribute to compute serverSpanTimings.syncHandshakeMs.
      //
      // `withSpanSync` (not `withSpan`) so afterLoadDocument doesn't pay an
      // awaited-Promise microtask hop per WebSocket connection even when
      // OTel is disabled and the span body is a no-op.
      try {
        withSpanSync('sync.handshake', { attributes }, () => {});
      } catch (err) {
        // Bracket-prefix `console.warn` is intentional here: this is an ad-hoc
        // ops warning meant to
        // surface a misbehaving SDK to a human reading the console, not
        // an event counted in aggregate or asserted in tests. Promoting
        // to `getLogger('sync-handshake-span').warn` would require a
        // consumer that doesn't yet exist; revisit if telemetry analysis
        // grows a need to alert on OTel SDK fault rates.
        //
        // Pass the Error through so Node renders its `.stack` — coercing to
        // `.message` discards the call-frame info needed to triage a rare
        // OTel SDK fault.
        console.warn(
          '[sync-handshake-span] emission failed:',
          err instanceof Error ? err : String(err),
        );
      }
    },
  };
}
