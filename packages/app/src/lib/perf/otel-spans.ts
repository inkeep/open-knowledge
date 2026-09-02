import type { Attributes, Span } from '@opentelemetry/api';
import { context, trace } from '@opentelemetry/api';

const TRACER_NAME = 'open-knowledge-app';

interface ColdMountEntry {
  span: Span;
  startTimeMs: number;
}

const coldMountByMountId = new Map<string, ColdMountEntry>();
const finalizedMountIds = new Set<string>();
const FINALIZED_SET_CAP = 1024;
const COLD_MOUNT_MAP_CAP = 1024;

function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

export function ensureColdMountSpan(
  mountId: string,
  attributes: Attributes,
  startTimeMs: number,
): ColdMountEntry | null {
  if (finalizedMountIds.has(mountId)) return null;
  const existing = coldMountByMountId.get(mountId);
  if (existing) return existing;
  if (coldMountByMountId.size >= COLD_MOUNT_MAP_CAP) {
    const oldestKey = coldMountByMountId.keys().next().value;
    if (oldestKey !== undefined) {
      const oldestEntry = coldMountByMountId.get(oldestKey);
      coldMountByMountId.delete(oldestKey);
      try {
        oldestEntry?.span.end();
      } catch (err) {
        console.warn(
          '[otel-spans] eviction span.end failed:',
          err instanceof Error ? err : String(err),
        );
      }
    }
  }
  const span = getTracer().startSpan('ok.cold-mount', {
    attributes: { 'mount.id': mountId, ...attributes },
    startTime: startTimeMs,
  });
  const entry = { span, startTimeMs };
  coldMountByMountId.set(mountId, entry);
  return entry;
}

export function emitColdMountChild(
  mountId: string,
  name: string,
  attributes: Attributes,
  startTimeMs: number,
  endTimeMs?: number,
): void {
  try {
    const root = ensureColdMountSpan(mountId, attributes, startTimeMs);
    const parentCtx = root ? trace.setSpan(context.active(), root.span) : context.active();
    const span = getTracer().startSpan(
      name,
      { attributes: { 'mount.id': mountId, ...attributes }, startTime: startTimeMs },
      parentCtx,
    );
    span.end(endTimeMs ?? Date.now());
  } catch (err) {
    console.warn(
      '[otel-spans] emitColdMountChild failed:',
      err instanceof Error ? err : String(err),
    );
  }
}

export function finalizeColdMountSpan(mountId: string, endTimeMs?: number): void {
  try {
    const entry = coldMountByMountId.get(mountId);
    if (entry) {
      coldMountByMountId.delete(mountId);
      entry.span.end(endTimeMs ?? Date.now());
    }
    if (!finalizedMountIds.has(mountId)) {
      if (finalizedMountIds.size >= FINALIZED_SET_CAP) {
        const oldest = finalizedMountIds.values().next().value;
        if (oldest !== undefined) finalizedMountIds.delete(oldest);
      }
      finalizedMountIds.add(mountId);
    }
  } catch (err) {
    console.warn(
      '[otel-spans] finalizeColdMountSpan failed:',
      err instanceof Error ? err : String(err),
    );
  }
}

export function __resetColdMountSpans(): void {
  for (const entry of coldMountByMountId.values()) {
    entry.span.end();
  }
  coldMountByMountId.clear();
  finalizedMountIds.clear();
}

export function __coldMountSpanCount(): number {
  return coldMountByMountId.size;
}
