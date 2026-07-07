/**
 * Cluster E: save-version / history / history/<sha> / diff / workspace /
 * rescue-list / rescue-get / server-info / principal.
 *
 * Mix of GET-no-body (history, diff, workspace, rescue, server-info, principal)
 * and POST-with-optional-body (save-version) handlers. Save-version is the only
 * one taking a request body (writers); the others are query-string-only.
 * Schemas drop the `{ ok: true }` wrapper.
 *
 * `serverInfo` and `principal` schemas live in `_envelope.ts` (because they
 * also live near the file-top conceptually, alongside the cross-cutting
 * envelope schemas); below are the remaining cluster E success schemas.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

import { agentIdentityFields, summaryField } from './_shared.ts';

/** Optional writer record passed to `POST /api/save-version`. */
export const SaveVersionWriterSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    email: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SaveVersionWriter = z.infer<typeof SaveVersionWriterSchema>;

/**
 * Request body for `POST /api/save-version`. Every field optional — the
 * common case posts an empty `{}` body and inherits agent defaults.
 *
 * `writers` is an explicit override list (the server otherwise derives it
 * from the calling agent identity).
 */
export const SaveVersionRequestSchema = z
  .object({
    writers: z.array(SaveVersionWriterSchema).optional(),
    // Optional one-line label for the checkpoint — threads into the checkpoint
    // commit subject (defaults to "Checkpoint version" when absent).
    summary: summaryField,
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type SaveVersionRequest = z.infer<typeof SaveVersionRequestSchema>;

/**
 * Success response for `POST /api/save-version`. `checkpointRef` is the
 * shadow-repo checkpoint SHA.
 */
export const SaveVersionSuccessSchema = z
  .object({
    checkpointRef: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type SaveVersionSuccess = z.infer<typeof SaveVersionSuccessSchema>;

/**
 * Single shadow contributor entry (parsed from a checkpoint commit). Mirrors
 * the in-process `ShadowContributor` type from `shadow-repo-layout.ts` 1:1 —
 * wire shape and runtime shape are the same record. The fields shown here
 * match what `formatContributorsFrom()` writes into commit message bodies
 * and what `readContributors()` parses back out (`id`, `name`, `docs`,
 * optional `colorSeed`, optional `summaries[]`, optional `v` for version
 * tracking). Consumers (e.g. `TimelinePanel.tsx`) read these fields by name.
 */
export const HistoryShadowContributorSchema = z
  .object({
    /** Optional schema version on the commit-message contributor entry. */
    v: z.number().int().optional(),
    /** Stable writer-id (`agent-<id>`, `principal-<uuid>`, `file-system`, etc.). */
    id: z.string().min(1),
    /** Display name as shown in awareness / timeline. */
    name: z.string().min(1),
    /** Color seed for deterministic color assignment. */
    colorSeed: z.string().optional(),
    /** Doc paths this contributor touched in the commit. */
    docs: z.array(z.string()),
    /**
     * Flat per-contributor array of agent-provided summaries, oldest first.
     * Additive field. Legacy commits lack it entirely; malformed values
     * drop just this field.
     */
    summaries: z.array(z.string()).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type HistoryShadowContributor = z.infer<typeof HistoryShadowContributorSchema>;

/** Single timeline entry returned from `GET /api/history`. */
export const HistoryEntrySchema = z
  .object({
    sha: z.string().min(1),
    timestamp: z.string().min(1),
    author: z.string(),
    authorEmail: z.string(),
    type: z.enum(['checkpoint', 'wip', 'upstream', 'park']),
    message: z.string(),
    contributors: z.array(HistoryShadowContributorSchema),
    checkpoint: z.unknown().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/**
 * Success response for `GET /api/history?docName=...&branch=...`. The
 * `entries` array spans both checkpoint and WIP rows (filterable via the
 * `type` query parameter); pagination is `limit`-bounded server-side
 * (max 200 per page).
 */
export const HistorySuccessSchema = z
  .object({
    entries: z.array(HistoryEntrySchema),
    /**
     * Count of entries GATHERED for this query. When `hasMore` is true because
     * the depth-bounded git walk saturated, this is the windowed
     * count, NOT the doc's true lifetime total — a precise total would require
     * the unbounded walk the depth bound deliberately avoids. Use `hasMore` (not
     * `total`) as the pagination signal; do not render "page X of N" from it.
     */
    total: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    /**
     * True when more entries exist beyond this page — either later pages within
     * the gathered set, or the git-level depth window was saturated.
     * Consumers paginate by raising `offset`; an offset past the window
     * returns an empty `entries` with `hasMore: false` (the bounded walk is
     * deterministic — paging further cannot surface new rows).
     */
    hasMore: z.boolean().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type HistorySuccess = z.infer<typeof HistorySuccessSchema>;

/**
 * Success response for `GET /api/history/<sha>?docName=...`. Returns the
 * historical document content + commit metadata.
 */
export const HistoryVersionSuccessSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
    content: z.string(),
    timestamp: z.string(),
    author: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type HistoryVersionSuccess = z.infer<typeof HistoryVersionSuccessSchema>;

/**
 * Success response for `GET /api/workspace`. Loopback-only endpoint —
 * exposes the absolute host filesystem path so the client's "Copy path"
 * action can build full paths without guessing path-separator semantics.
 *
 * `symlinkResolved=false` indicates the contentDir was deleted out from
 * under the server (ENOENT on realpath); the client receives the unresolved
 * path and decides whether to act on it.
 */
export const WorkspaceSuccessSchema = z
  .object({
    contentDir: z.string().min(1),
    pathSeparator: z.enum(['/', '\\']),
    symlinkResolved: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type WorkspaceSuccess = z.infer<typeof WorkspaceSuccessSchema>;

/** Single rescue buffer entry — flat-file (shutdown-flush) source. */
export const RescueEntryFlatSchema = z
  .object({
    docName: z.string().min(1),
    timestamp: z.string().min(1),
    size: z.number().int().nonnegative(),
    source: z.literal('flat'),
  })
  .loose() satisfies StandardSchemaV1;
export type RescueEntryFlat = z.infer<typeof RescueEntryFlatSchema>;

/** Single rescue buffer entry — timeline-ref (saveInMemoryCheckpoint) source. */
export const RescueEntryTimelineSchema = z
  .object({
    docName: z.string().min(1),
    timestamp: z.string().min(1),
    source: z.literal('timeline'),
    sha: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type RescueEntryTimeline = z.infer<typeof RescueEntryTimelineSchema>;

/**
 * Success response for `GET /api/rescue` — flat array of rescue buffers
 * across both flat-file (shutdown-flush) and timeline-ref
 * (saveInMemoryCheckpoint) sources. The `source` discriminator field tells
 * the client which artifact class produced the entry. Empty `[]` is valid
 * (no rescue buffers OR no shadow repo configured).
 *
 * Note: `/api/rescue/<docName>` returns raw markdown content with
 * `Content-Type: text/markdown` (not JSON), so it has no JSON success schema.
 */
export const RescueListSuccessSchema = z
  .array(z.discriminatedUnion('source', [RescueEntryFlatSchema, RescueEntryTimelineSchema]))
  .meta({
    description: 'Flat array of rescue buffer entries; discriminated via `source`.',
  }) satisfies StandardSchemaV1;
export type RescueListSuccess = z.infer<typeof RescueListSuccessSchema>;
