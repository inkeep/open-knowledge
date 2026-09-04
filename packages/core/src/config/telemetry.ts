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

export function addConfigSpanEvent(name: string, attributes?: Attributes): void {
  const span = trace.getActiveSpan();
  if (span) span.addEvent(name, attributes);
}

export function setConfigOutcome(outcome: ConfigOutcome): void {
  const span = trace.getActiveSpan();
  if (span) span.setAttribute('config.outcome', outcome);
}
