import type { Extension } from '@hocuspocus/server';
import { type Attributes, context as otelContext, propagation } from '@opentelemetry/api';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { getLogger } from './logger.ts';
import { withSpanSync } from './telemetry.ts';

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

      try {
        const emitSpan = (): void => {
          withSpanSync('sync.handshake', { attributes }, () => {});
        };
        const traceparent = requestParameters?.get('traceparent');
        if (traceparent !== null && traceparent !== undefined) {
          const carrier: Record<string, string> = { traceparent };
          const tracestate = requestParameters?.get('tracestate');
          if (tracestate !== null && tracestate !== undefined) {
            carrier.tracestate = tracestate;
          }
          otelContext.with(propagation.extract(otelContext.active(), carrier), emitSpan);
        } else {
          emitSpan();
        }
      } catch (err) {
        getLogger('sync-handshake-span').warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'emission failed',
        );
      }
    },
  };
}
