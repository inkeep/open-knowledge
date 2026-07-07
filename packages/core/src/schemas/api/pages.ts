/**
 * Cluster B: pages CRUD.
 *
 * Read + mutate handlers backing the FileTree / NewItemDialog / EditorHeader
 * rename surface. `withValidation()` enforces these schemas at the wire
 * boundary; semantic failures (doc-not-found, doc-already-exists, etc.) emit
 * post-extractAgentIdentity for mutating handlers. Read-only handlers
 * (`handlePages`, `handlePageHeadings`) take query params, not bodies; they
 * route through a no-op request schema so the wrapper still gates 405.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { agentIdentityFields, summaryField } from './_shared.ts';
import {
  AdvisoryWarningsSchema,
  ContentDivergenceWarningSchema,
  SummaryResponseFieldSchema,
} from './agent-write.ts';

/**
 * Mapping from a pre-rename docName to its post-rename docName. Used in
 * the `renamed` array of `/api/rename` and `/api/rename-path` success bodies
 * so client UIs (FileTree, EditorHeader) can update their per-doc model
 * atomically without re-fetching the whole tree.
 */
export const RenamedDocMappingSchema = z
  .object({
    fromDocName: z.string().min(1),
    toDocName: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type RenamedDocMapping = z.infer<typeof RenamedDocMappingSchema>;

/**
 * Mapping from a pre-rename non-markdown asset path to its post-rename path.
 * Asset paths are content-dir-relative and include their extension.
 */
export const RenamedAssetMappingSchema = z
  .object({
    fromPath: z.string().min(1),
    toPath: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type RenamedAssetMapping = z.infer<typeof RenamedAssetMappingSchema>;

/** Empty request schema for GET endpoints whose body is unused. */
export const EmptyRequestSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type EmptyRequest = z.infer<typeof EmptyRequestSchema>;

/**
 * Request body for `POST /api/create-page`. `path` is the relative
 * content-dir path including the `.md`/`.mdx` suffix; the handler runs the
 * `isSupportedDocFile` + path-traversal + reserved-doc-name checks
 * post-validation. `agentId` etc. are optional — `extractAgentIdentity`
 * carries the default-agent fallback when absent.
 */
export const CreatePageRequestSchema = z
  .object({
    path: z.string().min(1),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type CreatePageRequest = z.infer<typeof CreatePageRequestSchema>;

/** Success body for `POST /api/create-page`. */
export const CreatePageSuccessSchema = z
  .object({
    docName: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type CreatePageSuccess = z.infer<typeof CreatePageSuccessSchema>;

/**
 * Request body for `POST /api/create-folder`. `path` is the relative
 * content-dir folder path. The handler runs traversal + reserved-prefix +
 * content-filter checks post-validation.
 */
export const CreateFolderRequestSchema = z
  .object({
    path: z.string().min(1),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type CreateFolderRequest = z.infer<typeof CreateFolderRequestSchema>;

/** Success body for `POST /api/create-folder`. Echoes the created path. */
export const CreateFolderSuccessSchema = z
  .object({
    path: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type CreateFolderSuccess = z.infer<typeof CreateFolderSuccessSchema>;

/** Request body for `POST /api/duplicate-path`. */
export const DuplicatePathRequestSchema = z
  .object({
    kind: z.enum(['file', 'folder']),
    path: z.string().min(1),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type DuplicatePathRequest = z.infer<typeof DuplicatePathRequestSchema>;

/** Success body for `POST /api/duplicate-path`. */
export const DuplicatePathSuccessSchema = z
  .object({
    kind: z.enum(['file', 'folder']),
    path: z.string().min(1),
    duplicatedDocNames: z.array(z.string().min(1)),
  })
  .loose() satisfies StandardSchemaV1;
export type DuplicatePathSuccess = z.infer<typeof DuplicatePathSuccessSchema>;

/**
 * Single page entry in the `pages` array of `GET /api/pages`. `docExt` is
 * the actual on-disk extension (`.md` or `.mdx`); `title` is the first
 * non-empty heading or the docName fallback.
 */
export const PageEntrySchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
    docExt: z.string().min(1),
    size: z.number().int().nonnegative(),
    modified: z.string().min(1),
    // Raw frontmatter `icon:` value as authored. Server emits the
    // unvalidated string; the editor classifies (emoji / URL / content-
    // relative path / unsupported) via `resolvePageIcon` at render
    // time — see `packages/app/src/components/page-header-utils.ts`.
    // Surfaces in the wiki-link chip prefix + (future) sidebar.
    //
    // Bounded by `MAX_VALUE_LENGTH = 2048` in `page-header-utils.ts`'s
    // classifier — anything over that resolves to `unsupported`, so
    // shipping it over the wire is wasted bytes + a potential DoS
    // surface for a list of 3000+ pages. `.min(1)` matches the
    // server's behavior of emitting `undefined` for blank scalars.
    icon: z.string().min(1).max(2048).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type PageEntry = z.infer<typeof PageEntrySchema>;

/** Success body for `GET /api/pages`. Sorted alphabetically by docName. */
export const PagesSuccessSchema = z
  .object({
    pages: z.array(PageEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type PagesSuccess = z.infer<typeof PagesSuccessSchema>;

/** ATX heading entry (level + slug) emitted by `GET /api/page-headings`. */
export const HeadingEntrySchema = z
  .object({
    level: z.number().int().min(1).max(6),
    text: z.string(),
    slug: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type HeadingEntry = z.infer<typeof HeadingEntrySchema>;

/** Success body for `GET /api/page-headings?docName=...`. */
export const PageHeadingsSuccessSchema = z
  .object({
    docName: z.string().min(1),
    headings: z.array(HeadingEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type PageHeadingsSuccess = z.infer<typeof PageHeadingsSuccessSchema>;

/** Backlink-rewrite summary entry returned by `/api/rename-path`. */
export const RenameRewrittenDocSchema = z
  .object({
    docName: z.string().min(1),
    rewrites: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type RenameRewrittenDoc = z.infer<typeof RenameRewrittenDocSchema>;

/**
 * Request body for `POST /api/rename-path`. `kind` selects file / folder /
 * asset semantics; the handler enforces the actual on-disk shape
 * post-validation.
 */
export const RenamePathRequestSchema = z
  .object({
    kind: z.enum(['file', 'folder', 'asset']),
    fromPath: z.string().min(1),
    toPath: z.string().min(1),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type RenamePathRequest = z.infer<typeof RenamePathRequestSchema>;

/**
 * Success body for `POST /api/rename-path`. Mirrors the full handler emit
 * shape: `renamed` (the mapping list, present even on no-op renames),
 * `rewrittenDocs` (back-references rewritten across the rename), and
 * `summary` (the normalized contributor-record summary, omitted for
 * `anonymous` actors and zero-affected renames).
 */
export const RenamePathSuccessSchema = z
  .object({
    renamed: z.array(RenamedDocMappingSchema),
    renamedAssets: z.array(RenamedAssetMappingSchema),
    rewrittenDocs: z.array(RenameRewrittenDocSchema).optional(),
    summary: SummaryResponseFieldSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type RenamePathSuccess = z.infer<typeof RenamePathSuccessSchema>;

/** Request body for `POST /api/delete-path`. */
export const DeletePathRequestSchema = z
  .object({
    kind: z.enum(['file', 'folder', 'asset']),
    path: z.string().min(1),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type DeletePathRequest = z.infer<typeof DeletePathRequestSchema>;

/** Success body for `POST /api/delete-path`. */
export const DeletePathSuccessSchema = z
  .object({
    deletedDocNames: z.array(z.string().min(1)),
  })
  .loose() satisfies StandardSchemaV1;
export type DeletePathSuccess = z.infer<typeof DeletePathSuccessSchema>;

/**
 * Request body for `POST /api/trash/cleanup` — server-side cleanup step
 * of the two-step Trash flow. The renderer calls this AFTER `shell.trashItem`
 * succeeds (Step 1 already moved the file to ~/.Trash). The server closes the
 * Hocuspocus docs, marks `recentlyRemovedDocs`, purges the file index, and
 * broadcasts the CC1 files channel — does NOT touch disk. `agentId` etc. are
 * optional; the handler threads identity via `extractActorIdentity` so the
 * cleanup is auditable in structured logs even when no contributor record is
 * emitted (cleanup doesn't write to docs).
 */
export const TrashCleanupRequestSchema = z
  .object({
    kind: z.enum(['file', 'folder', 'asset']),
    path: z.string().min(1),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type TrashCleanupRequest = z.infer<typeof TrashCleanupRequestSchema>;

/**
 * Success body for `POST /api/trash/cleanup`. Mirrors `DeletePathSuccess`
 * — both surface the docNames that were purged from the in-memory index.
 * Empty array when the file-watcher already processed the OS-level deletion
 * between Step 1 IPC and Step 2 cleanup (idempotent).
 */
export const TrashCleanupSuccessSchema = z
  .object({
    deletedDocNames: z.array(z.string().min(1)),
  })
  .loose() satisfies StandardSchemaV1;
export type TrashCleanupSuccess = z.infer<typeof TrashCleanupSuccessSchema>;

/**
 * Request body for `POST /api/rollback`. `commitSha` is a 40-char git SHA.
 * `agentId` mirrors the rename handler's explicit-attribution gate — the UI
 * Restore button posts no `agentId` so attribution stays anonymous.
 */
export const RollbackRequestSchema = z
  .object({
    docName: z.string().min(1),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i, { message: 'commitSha must be a 40-char git SHA' }),
    summary: summaryField,
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;

/** Success body for `POST /api/rollback`. */
export const RollbackSuccessSchema = z
  .object({
    restoredFrom: z.string().min(1),
    timestamp: z.string().min(1),
    summary: SummaryResponseFieldSchema.optional(),
    /** @deprecated Read `warnings` — kept emitting in parallel for one deprecation window. */
    warning: ContentDivergenceWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type RollbackSuccess = z.infer<typeof RollbackSuccessSchema>;
