import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const OrphanEntrySchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type OrphanEntry = z.infer<typeof OrphanEntrySchema>;

export const OrphansSuccessSchema = z
  .object({
    orphans: z.array(OrphanEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type OrphansSuccess = z.infer<typeof OrphansSuccessSchema>;

export const HubEntrySchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
    count: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type HubEntry = z.infer<typeof HubEntrySchema>;

export const HubsSuccessSchema = z
  .object({
    hubs: z.array(HubEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type HubsSuccess = z.infer<typeof HubsSuccessSchema>;

export const DeadLinkSourceSchema = z
  .object({
    source: z.string().min(1),
    title: z.string(),
    snippet: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type DeadLinkSource = z.infer<typeof DeadLinkSourceSchema>;

export const DeadLinkEntrySchema = z
  .object({
    target: z.string().min(1),
    sources: z.array(DeadLinkSourceSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type DeadLinkEntry = z.infer<typeof DeadLinkEntrySchema>;

export const DeadLinksSuccessSchema = z
  .object({
    deadLinks: z.array(DeadLinkEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type DeadLinksSuccess = z.infer<typeof DeadLinksSuccessSchema>;

export const SuggestLinksTargetSchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
    aliases: z.array(z.string()),
  })
  .loose() satisfies StandardSchemaV1;
export type SuggestLinksTarget = z.infer<typeof SuggestLinksTargetSchema>;

export const SuggestLinksMentionSchema = z
  .object({
    source: z.string().min(1),
    excerpt: z.string(),
    offset: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type SuggestLinksMention = z.infer<typeof SuggestLinksMentionSchema>;

export const SuggestLinksSuccessSchema = z
  .object({
    target: SuggestLinksTargetSchema,
    mentions: z.array(SuggestLinksMentionSchema),
    truncated: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type SuggestLinksSuccess = z.infer<typeof SuggestLinksSuccessSchema>;
