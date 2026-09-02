import { getTracer, initTelemetry } from '@inkeep/open-knowledge-server';
import { type Context, context, propagation, type Span, trace } from '@opentelemetry/api';
import { getLogger } from './desktop-logger.ts';

let rootSpan: Span | undefined;
let rootContext: Context | undefined;
let active = false;

export function beginRoot(): boolean {
  if (active) return true;
  if (process.env.OTEL_SDK_DISABLED !== 'false') return false;
  try {
    initTelemetry();
    const span = getTracer().startSpan('ok.app-startup');
    if (!span.isRecording()) {
      span.end();
      return false;
    }
    rootSpan = span;
    rootContext = trace.setSpan(context.active(), span);
    active = true;
    return true;
  } catch (err) {
    getLogger('startup-trace').warn(
      { err },
      'OTel root init failed in main — degrading to waterfall-log-only (Plan B)',
    );
    rootSpan = undefined;
    rootContext = undefined;
    active = false;
    return false;
  }
}

export function isStartupTraceActive(): boolean {
  return active;
}

export function injectTraceparent(): string | undefined {
  if (!active || !rootContext) return undefined;
  try {
    const carrier: Record<string, string> = {};
    propagation.inject(rootContext, carrier);
    return carrier.traceparent;
  } catch {
    return undefined;
  }
}

export function childSpan(
  name: string,
  attributes: Record<string, number | boolean>,
  startMs: number,
  endMs: number,
): void {
  if (!active || !rootContext) return;
  try {
    const span = getTracer().startSpan(name, { startTime: startMs }, rootContext);
    span.setAttributes(attributes);
    span.end(endMs);
  } catch {}
}

export function endRoot(endMs: number = Date.now()): void {
  if (!rootSpan) return;
  try {
    rootSpan.end(endMs);
  } catch {}
  rootSpan = undefined;
  rootContext = undefined;
  active = false;
}

export function __resetStartupTraceForTest(): void {
  rootSpan = undefined;
  rootContext = undefined;
  active = false;
}
