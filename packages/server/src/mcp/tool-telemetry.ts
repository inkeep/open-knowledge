/**
 * OpenTelemetry instrumentation for MCP tool dispatch.
 *
 * One wrapper at the registration spine (`createLoggedServer` in
 * tool-logging.ts) instruments every tool without per-tool edits:
 *
 *   - a `mcp.tool.<name>` span around each invocation
 *   - `ok.mcp.tool.duration` histogram (ms)
 *   - `ok.mcp.tool.errors` counter, split by `kind` (exception vs isError
 *     result — MCP handlers report most failures as `isError: true` results
 *     rather than throws, and a throw-only counter would miss them)
 *
 * The `tool` label is bounded: tool names are static string literals at the
 * registration sites in tools/index.ts (~21 names), never caller-supplied.
 * No doc names, paths, or argument content reach span attributes or metric
 * labels.
 *
 * Instruments live in the same process the tools run in. In the collab
 * server (`ok start` HTTP MCP endpoint) they bind to the provider
 * `initTelemetry` registered; in the stdio `ok mcp` proxy no SDK is
 * registered, so the no-op tracer/meter make every call here a no-op —
 * matching the zero-overhead-when-disabled contract.
 *
 * Cached instruments drop on telemetry shutdown so the next tool call
 * rebinds against the fresh meter (same lifecycle contract as
 * server-workload-telemetry.ts).
 */
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

/**
 * Wrap an MCP tool handler with a dispatch span + duration/error metrics.
 * Applied unconditionally at registration (unlike logging, which needs a
 * logger); with no OTel SDK registered every instrument is the API no-op.
 */
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
        // withSpan records the exception and sets ERROR status on rethrow.
        errorCounter().add(1, { tool: name, kind: 'exception' });
        throw err;
      } finally {
        durationHistogram().record(performance.now() - startedAt, { tool: name });
      }
    });
}
