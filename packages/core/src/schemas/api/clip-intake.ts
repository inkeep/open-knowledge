/**
 * Web Clipper clip-intake envelope schema (`openknowledge.clip/v1`).
 *
 * Validates the clip payload passed from browser extensions via the clipboard
 * during the `openknowledge://clip?destination=<id>&clipboard=true` intake flow.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const ClipPayloadSchema = z
  .object({
    schema: z.literal('openknowledge.clip/v1'),
    title: z.string().min(1),
    suggestedFilename: z.string().min(1).optional(),
    sourceUrl: z.string().min(1),
    selectionOnly: z.boolean().default(false),
    markdown: z.string(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .loose() satisfies StandardSchemaV1;

export type OkClipPayload = z.infer<typeof ClipPayloadSchema>;
