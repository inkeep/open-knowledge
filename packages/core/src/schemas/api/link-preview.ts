import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const LinkPreviewMetadataSchema = z
  .object({
    domain: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    siteName: z.string().optional(),
    faviconDataUri: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type LinkPreviewMetadata = z.infer<typeof LinkPreviewMetadataSchema>;

export const LinkPreviewRequestSchema = z
  .object({ url: z.string() })
  .loose() satisfies StandardSchemaV1;
export type LinkPreviewRequest = z.infer<typeof LinkPreviewRequestSchema>;

export const LinkPreviewResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), metadata: LinkPreviewMetadataSchema }).loose(),
  z.object({ ok: z.literal(false), reason: z.string() }).loose(),
]) satisfies StandardSchemaV1;
export type LinkPreviewResponse = z.infer<typeof LinkPreviewResponseSchema>;
