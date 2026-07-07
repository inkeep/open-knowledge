/**
 * Cluster D: orphans / hubs / dead-links / suggest-links.
 *
 * All four are GET endpoints — request schemas are EmptyRequestSchema (query
 * params parsed manually inside the handler; their validity is enforced
 * inline via errorResponse `urn:ok:error:invalid-request` emits).
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

/**
 * Single entry in the orphans response. `title` is the H1 / frontmatter title
 * pulled from the corresponding markdown file; falls back to `docName` if no
 * usable heading exists.
 */
export const OrphanEntrySchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type OrphanEntry = z.infer<typeof OrphanEntrySchema>;

/** Success body for `GET /api/orphans[?mode=incoming|outgoing|both]`. */
export const OrphansSuccessSchema = z
  .object({
    orphans: z.array(OrphanEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type OrphansSuccess = z.infer<typeof OrphansSuccessSchema>;

/** Single entry in the hubs response. `count` is the inbound-backlink count. */
export const HubEntrySchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
    count: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type HubEntry = z.infer<typeof HubEntrySchema>;

/** Success body for `GET /api/hubs[?limit=N]`. */
export const HubsSuccessSchema = z
  .object({
    hubs: z.array(HubEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type HubsSuccess = z.infer<typeof HubsSuccessSchema>;

/**
 * Single source-pointer for a dead-link entry — references the page that
 * contains the broken link plus a short snippet for context.
 */
export const DeadLinkSourceSchema = z
  .object({
    source: z.string().min(1),
    title: z.string(),
    snippet: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type DeadLinkSource = z.infer<typeof DeadLinkSourceSchema>;

/** Single dead-link entry — one missing target plus the sources that point at it. */
export const DeadLinkEntrySchema = z
  .object({
    target: z.string().min(1),
    sources: z.array(DeadLinkSourceSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type DeadLinkEntry = z.infer<typeof DeadLinkEntrySchema>;

/** Success body for `GET /api/dead-links[?sourceDocName=...&sourceDocName=...]`. */
export const DeadLinksSuccessSchema = z
  .object({
    deadLinks: z.array(DeadLinkEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type DeadLinksSuccess = z.infer<typeof DeadLinksSuccessSchema>;

/** Target page metadata in a `/api/suggest-links` response. */
export const SuggestLinksTargetSchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
    aliases: z.array(z.string()),
  })
  .loose() satisfies StandardSchemaV1;
export type SuggestLinksTarget = z.infer<typeof SuggestLinksTargetSchema>;

/** Single mention discovered while scanning the corpus. */
export const SuggestLinksMentionSchema = z
  .object({
    source: z.string().min(1),
    excerpt: z.string(),
    offset: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type SuggestLinksMention = z.infer<typeof SuggestLinksMentionSchema>;

/** Success body for `GET /api/suggest-links?docName=...`. */
export const SuggestLinksSuccessSchema = z
  .object({
    target: SuggestLinksTargetSchema,
    mentions: z.array(SuggestLinksMentionSchema),
    truncated: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type SuggestLinksSuccess = z.infer<typeof SuggestLinksSuccessSchema>;
