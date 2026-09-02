import { type Counter, type Histogram, SpanStatusCode } from '@opentelemetry/api';
import { getMeter, onTelemetryShutdown, withSpan } from '../telemetry.ts';

type AnyToolHandler = (...args: unknown[]) => unknown;

let cachedDurationHistogram: Histogram | null = null;
let cachedErrorCounter: Counter | null = null;

onTelemetryShutdown(() => {
  cachedDurationHistogram = null;
  cachedErrorCounter = null;
});

function durationHistogram(): Histogram {
  cachedDurationHistogram ??= getMeter().createHistogram('ok.mcp.tool.duration', {
    description: 'MCP tool invocation duration. Bounded label: tool (static registry names).',
    unit: 'ms',
  });
  return cachedDurationHistogram;
}

function errorCounter(): Counter {
  cachedErrorCounter ??= getMeter().createCounter('ok.mcp.tool.errors', {
    description:
      'MCP tool invocation failures. Bounded labels: tool (static registry names), kind ∈ {exception, error_result}.',
    unit: '{errors}',
  });
  return cachedErrorCounter;
}

function isErrorResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

export function wrapToolHandlerForTelemetry(name: string, handler: AnyToolHandler): AnyToolHandler {
  return (...invocationArgs: unknown[]) =>
    withSpan(`mcp.tool.${name}`, { attributes: { 'mcp.tool.name': name } }, async (span) => {
      const startedAt = performance.now();
      try {
        const result = await handler(...invocationArgs);
        if (isErrorResult(result)) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'tool returned isError result' });
          errorCounter().add(1, { tool: name, kind: 'error_result' });
        }
        return result;
      } catch (err) {
        errorCounter().add(1, { tool: name, kind: 'exception' });
        throw err;
      } finally {
        durationHistogram().record(performance.now() - startedAt, { tool: name });
      }
    });
}
