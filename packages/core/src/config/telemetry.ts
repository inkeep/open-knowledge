/**
 * Browser-safe OTel helpers for config-edit spans.
 *
 * Imports only `@opentelemetry/api` (no SDK deps) so this module is reachable
 * from both the server (Bun + Node, real SDK initialized in
 * `packages/server/src/telemetry.ts`) and the app (browser, real SDK
 * initialized in `packages/app/src/telemetry-impl.ts`).
 *
 * The `@opentelemetry/api` package returns a no-op tracer when no SDK is
 * registered — spans are inert with zero overhead when OTel is off. The
 * server's `OTEL_SDK_DISABLED=false` gate and the app's
 * `VITE_OTEL_ENABLED=true` gate decide whether real SDKs register.
 *
 * Span set:
 *   `config.bind`     — every `bindConfigDoc` invocation (binding lifetime)
 *   `config.patch`    — every `ConfigBinding.patch` and `writeConfigPatch`
 *   `config.validate` — each Zod safeParse pass (L1 / L2 / L3)
 *   `config.persist`  — server persistence-hook write
 *   `config.revert`   — L3 revert-to-LKG transaction
 *
 * Bounded enum attributes ONLY — Zod issue paths go in span events, never
 * attributes (cardinality risk on histograms / high-volume span attributes).
 */
import type { Attributes, Span, SpanOptions } from '@opentelemetry/api';
import { SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = 'open-knowledge-config';

export type ConfigScopeAttr = 'project' | 'user' | 'project-local';
export type ConfigValidationLayer = 'L1' | 'L2' | 'L3';
export type ConfigOutcome = 'success' | 'rejected' | 'reverted';
export type ConfigTransport = 'ytext' | 'fs';

export interface ConfigSpanAttributes extends Attributes {
  'config.scope'?: ConfigScopeAttr;
  'config.validation.layer'?: ConfigValidationLayer;
  'config.outcome'?: ConfigOutcome;
  'config.transport'?: ConfigTransport;
}

/** Run `fn` inside a span; returns the function's result; ends the span on
 * resolve/reject. Async + sync supported via `await`. */
export async function withConfigSpan<T>(
  name: string,
  attributes: ConfigSpanAttributes | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const opts: SpanOptions = attributes ? { attributes } : {};
  return tracer.startActiveSpan(name, opts, async (span) => {
    try {
      const result = await fn(span);
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Synchronous variant — same shape, no await. */
export function withConfigSpanSync<T>(
  name: string,
  attributes: ConfigSpanAttributes | undefined,
  fn: (span: Span) => T,
): T {
  const tracer = trace.getTracer(TRACER_NAME);
  const opts: SpanOptions = attributes ? { attributes } : {};
  return tracer.startActiveSpan(name, opts, (span) => {
    try {
      const result = fn(span);
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Add an event with structured attributes to the active span. Used to
 * surface Zod issue paths without paying the cardinality cost of attribute
 * pivoting. No-op when no active span. */
export function addConfigSpanEvent(name: string, attributes?: Attributes): void {
  const span = trace.getActiveSpan();
  if (span) span.addEvent(name, attributes);
}

/** Record an outcome attribute on the currently active span. */
export function setConfigOutcome(outcome: ConfigOutcome): void {
  const span = trace.getActiveSpan();
  if (span) span.setAttribute('config.outcome', outcome);
}
