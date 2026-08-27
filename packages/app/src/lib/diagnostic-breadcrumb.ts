/**
 * `emitDiagnosticBreadcrumb(event, fields)` — write one structured renderer
 * event into the on-disk log a diagnostic bundle collects.
 *
 * The renderer runs sandboxed and cannot call pino. Both distributions capture
 * its console instead, and both agree on one wire shape: a single `console.info`
 * whose only argument is `JSON.stringify({ event, ...fields })`.
 *
 *   - Electron — main's `console-message` listener
 *     (`packages/desktop/src/main/renderer-console-capture.ts`) lifts the parsed
 *     object into pino fields and writes `~/.ok/logs/desktop.<date>.log`.
 *   - web / `ok ui` — the client-log forwarder
 *     (`./install-client-log-forwarder.ts`) batches the same text to
 *     `POST /api/client-logs`, which writes the server's `renderer` subsystem log.
 *
 * Either way `fields` land as top-level pino keys and `event` becomes the
 * message, so a breadcrumb is greppable by name and its numbers are queryable
 * without parsing free text. `report-bundle` collects both sinks.
 *
 * **`debug` is the one level that reaches no log file**, dropped twice over:
 * `mapConsoleLevel` maps it to null before pino sees it, and the web forwarder
 * never patches `console.debug` at all. `warn` and `error` do reach disk, but
 * they file routine diagnostics as faults, which is why this helper is fixed at
 * `info`.
 *
 * Field names must avoid pino's own keys, which this drops rather than leaves to
 * convention — see {@link PINO_RESERVED_KEYS}.
 *
 * Fields must be flat scalars, which this enforces rather than trusts. Pino's
 * keyed `redact` reaches one level of nesting, so a nested blob is both
 * unredactable and the shape that pushes a line over the cap below.
 */

import { LOGGER_OWNED_FIELDS } from '@inkeep/open-knowledge-core';

/**
 * Ceiling on a serialized line, at half the 8192-code-unit cap both transports
 * apply to one message. The headroom is for the multibyte case: the cap is a
 * UTF-16 length while the wire budget it protects is bytes.
 *
 * On the Electron path, overshooting does not cost the tail — it costs
 * everything. That capture site truncates BEFORE parsing and the parse is
 * all-or-nothing on `JSON.parse`, so a payload one character over arrives as an
 * unparsed string with no event name and no fields. (The web forwarder parses
 * the untruncated argument and so keeps the event, dropping only oversized
 * fields; the degradation below is what makes the two agree.) Every payload
 * here runs a few hundred bytes, but `docName` has no length bound.
 */
export const MAX_BREADCRUMB_CHARS = 4096;

/**
 * Names the log record's own producer owns. The authority is
 * `LOGGER_OWNED_FIELDS`, which strips them at the chokepoint both capture
 * transports call — that is what makes the rule hold for emitters that never
 * found this helper. IMPORTED rather than restated: a second hand-maintained
 * copy would drift silently, since both copies would keep passing their own
 * tests while one of them stopped matching the loggers.
 *
 * Dropping them here as well is not redundant. It is what lets the count below
 * report the loss, so a caller sees that a field of theirs went missing instead
 * of wondering where it went.
 */
const PINO_RESERVED_KEYS: ReadonlySet<string> = new Set(LOGGER_OWNED_FIELDS);

/**
 * What may be written as a field value.
 *
 * Stated as an allowlist rather than as "not an object", because the values that
 * break serialization are not all objects: a BigInt is a scalar by every other
 * measure and makes `JSON.stringify` throw, and a symbol or function serializes
 * to nothing. Under a denylist those reach the outer catch, which discards the
 * whole breadcrumb — event name included. An allowlist folds them into the
 * counted-drop path instead, so one bad field costs one field.
 */
function isLoggableScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Emit one breadcrumb. Never throws: a diagnostic must not break the path it
 * observes, and every caller sits on a user-facing interaction.
 *
 * A `fields.event` is ignored so a payload cannot rename its own event and hide
 * from a grep.
 */
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
    // Counted rather than silently swallowed: a dropped field is a gap in the
    // record, and a gap nobody can see reads as "the code did not do that".
    if (droppedNonScalarFields > 0) payload.droppedNonScalarFields = droppedNonScalarFields;
    if (droppedReservedFields > 0) payload.droppedReservedFields = droppedReservedFields;
    const line = JSON.stringify(payload);
    console.info(
      line.length <= MAX_BREADCRUMB_CHARS
        ? line
        : // Report the event and the shape of what was lost. A line that says
          // "this happened, oversized" is still evidence; an unparsed one is not.
          JSON.stringify({ event, oversized: true, fieldCount: Object.keys(payload).length - 1 }),
    );
  } catch {
    // A non-serializable scalar (BigInt) must not take the caller down.
  }
}
