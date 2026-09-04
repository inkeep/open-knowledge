import { LOGGER_OWNED_FIELDS } from '@inkeep/open-knowledge-core';

export const MAX_BREADCRUMB_CHARS = 4096;

const PINO_RESERVED_KEYS: ReadonlySet<string> = new Set(LOGGER_OWNED_FIELDS);

function isLoggableScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

export function emitDiagnosticBreadcrumb(
  event: string,
  fields?: Readonly<Record<string, unknown>>,
): void {
  try {
    const payload: Record<string, unknown> = { event };
    let droppedNonScalarFields = 0;
    let droppedReservedFields = 0;
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'event' || value === undefined) continue;
        if (PINO_RESERVED_KEYS.has(key)) {
          droppedReservedFields += 1;
          continue;
        }
        if (!isLoggableScalar(value)) {
          droppedNonScalarFields += 1;
          continue;
        }
        payload[key] = value;
      }
    }
    if (droppedNonScalarFields > 0) payload.droppedNonScalarFields = droppedNonScalarFields;
    if (droppedReservedFields > 0) payload.droppedReservedFields = droppedReservedFields;
    const line = JSON.stringify(payload);
    console.info(
      line.length <= MAX_BREADCRUMB_CHARS
        ? line
        : JSON.stringify({ event, oversized: true, fieldCount: Object.keys(payload).length - 1 }),
    );
  } catch {}
}
