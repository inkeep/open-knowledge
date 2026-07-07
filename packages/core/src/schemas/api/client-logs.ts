/**
 * Cluster: client-side log ingest. Backs `POST /api/client-logs`, the
 * web/browser path for capturing renderer `console` output into the on-disk
 * pino logs (the Electron app captures renderer console directly in its main
 * process via `console-message`, so it does not use this endpoint).
 *
 * Shared bounds live in `../../logging/renderer-log.ts` so the server Zod caps
 * and the renderer batcher agree.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import {
  RENDERER_LOG_MAX_ENTRIES,
  RENDERER_LOG_MAX_MESSAGE_BYTES,
} from '../../logging/renderer-log.ts';

/**
 * One captured console entry. `fields`/`event` carry the structured payload
 * lifted from a `JSON.stringify(...)` console line (see
 * `parseStructuredConsoleMessage`); `message` is the raw text fallback.
 */
export const ClientLogEntrySchema = z
  .object({
    level: z.enum(['info', 'warn', 'error']),
    message: z.string().max(RENDERER_LOG_MAX_MESSAGE_BYTES),
    event: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    ts: z.number().optional(),
    sourceId: z.string().optional(),
    lineNumber: z.number().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type ClientLogEntry = z.infer<typeof ClientLogEntrySchema>;

/** Request body for `POST /api/client-logs` — a bounded batch of entries. */
export const ClientLogsRequestSchema = z
  .object({
    entries: z.array(ClientLogEntrySchema).max(RENDERER_LOG_MAX_ENTRIES),
  })
  .loose() satisfies StandardSchemaV1;
export type ClientLogsRequest = z.infer<typeof ClientLogsRequestSchema>;

/** Success body — count of entries written to the server log. */
export const ClientLogsSuccessSchema = z
  .object({
    accepted: z.number().int().min(0),
  })
  .loose() satisfies StandardSchemaV1;
export type ClientLogsSuccess = z.infer<typeof ClientLogsSuccessSchema>;
