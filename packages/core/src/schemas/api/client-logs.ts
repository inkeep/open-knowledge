import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import {
  RENDERER_LOG_MAX_ENTRIES,
  RENDERER_LOG_MAX_MESSAGE_BYTES,
} from '../../logging/renderer-log.ts';

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

export const ClientLogsRequestSchema = z
  .object({
    entries: z.array(ClientLogEntrySchema).max(RENDERER_LOG_MAX_ENTRIES),
  })
  .loose() satisfies StandardSchemaV1;
export type ClientLogsRequest = z.infer<typeof ClientLogsRequestSchema>;

export const ClientLogsSuccessSchema = z
  .object({
    accepted: z.number().int().min(0),
  })
  .loose() satisfies StandardSchemaV1;
export type ClientLogsSuccess = z.infer<typeof ClientLogsSuccessSchema>;
