import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const EmbedProbeEntrySchema = z
  .object({
    ts: z.number().int().min(0),
    url: z.string(),
    method: z.string(),
    ua: z.string().optional(),
    origin: z.string().optional(),
    referer: z.string().optional(),
    host: z.string().optional(),
    remote: z.string().optional(),
    secChUa: z.string().optional(),
    secChUaMobile: z.string().optional(),
    secChUaPlatform: z.string().optional(),
    secFetchSite: z.string().optional(),
    secFetchDest: z.string().optional(),
    secFetchMode: z.string().optional(),
    secFetchUser: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type EmbedProbeEntryWire = z.infer<typeof EmbedProbeEntrySchema>;

export const EmbedDetectionSchema = z
  .object({
    app: z.union([z.literal('cursor'), z.literal('codex'), z.literal('claude'), z.null()]),
    signals_fired: z.array(z.string()),
  })
  .loose() satisfies StandardSchemaV1;
export type EmbedDetection = z.infer<typeof EmbedDetectionSchema>;

export const EmbedDetectSuccessSchema = z
  .object({
    entries: z.array(EmbedProbeEntrySchema),
    count: z.number().int().min(0),
    detection: EmbedDetectionSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type EmbedDetectSuccess = z.infer<typeof EmbedDetectSuccessSchema>;
