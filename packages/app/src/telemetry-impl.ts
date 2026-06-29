import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { UserInteractionInstrumentation } from '@opentelemetry/instrumentation-user-interaction';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions/incubating';

const TRACER_NAME = 'open-knowledge-app';

let installed = false;

function collectorUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_OTEL_COLLECTOR_URL ?? 'http://localhost:14318';
}

export function install(): void {
  if (installed) return;
  installed = true;

  let provider: WebTracerProvider | null = null;
  let registered = false;
  try {
    const baseUrl = collectorUrl();
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    provider = new WebTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'open-knowledge-app',
        [ATTR_SERVICE_VERSION]: env?.VITE_APP_VERSION ?? 'dev',
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env?.MODE ?? 'dev',
      }),
      spanProcessors: [
        new BatchSpanProcessor(new OTLPTraceExporter({ url: `${baseUrl}/v1/traces` }), {
          maxExportBatchSize: 50,
          scheduledDelayMillis: 2_000,
        }),
      ],
    });
    provider.register();
    registered = true;

    registerInstrumentations({
      instrumentations: [
        new DocumentLoadInstrumentation(),
        new UserInteractionInstrumentation({
          eventNames: ['click', 'submit'],
        }),
        new FetchInstrumentation({
          propagateTraceHeaderCorsUrls: [
            /^https?:\/\/localhost(:\d+)?\/api\//,
            /^https?:\/\/127\.0\.0\.1(:\d+)?\/api\//,
            /^\/api\//,
          ],
          clearTimingResources: true,
        }),
      ],
    });
    // eslint-disable-next-line no-console
    console.info(`[otel] frontend telemetry initialized — OTLP/HTTP → ${baseUrl}/v1/traces`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[otel] frontend telemetry init failed — continuing without', err);
    if (registered && provider) {
      void provider.shutdown().catch(() => {
      });
    }
    installed = false;
  }
}

export function getAppTracer() {
  return trace.getTracer(TRACER_NAME);
}
