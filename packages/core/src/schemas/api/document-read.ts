/**
 * Read-only handlers backing the BacklinksPanel / ForwardLinksPanel / GraphView /
 * FileTree / EmptyEditorState / agent-sim consumers. All take query params
 * (no body) and use `EmptyRequestSchema` + `skipBodyParse` at the wrapper.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

/**
 * Per-doc lifecycle status carried alongside content reads. `status` mirrors
 * the `Y.Map('lifecycle').get('status')` token the server writes for
 * `'conflict'` / `'deleted-upstream'` / `'renamed'` states. `reason` is a
 * free-form discriminator (e.g. `'conflict-markers'` vs `'merged-with-markers'`
 * for the two conflict provenances). Always populated together; the field
 * itself is `null` when no status is set so SDK consumers branch on a stable
 * `lifecycle === null` check rather than `lifecycle?.status`.
 */
export const LifecycleStatusSchema = z
  .object({
    status: z.string().min(1),
    reason: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

/**
 * Success body for `GET /api/document?docName=...`.
 *
 * `lifecycle` is ALWAYS present in the response — `null` when no status is
 * set, populated `{status, reason}` otherwise. Always-include for SDK type
 * stability (consumers can rely on the field existing rather than checking
 * `'lifecycle' in body`).
 */
export const DocumentReadSuccessSchema = z
  .object({
    docName: z.string().min(1),
    content: z.string(),
    lifecycle: LifecycleStatusSchema.nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type DocumentReadSuccess = z.infer<typeof DocumentReadSuccessSchema>;

/**
 * Single entry in the `documents` array of `GET /api/documents`. The
 * sidebar renders a unified document+asset tree, so the wire shape
 * is a discriminated union via the `kind` field:
 *
 * - `kind: 'document'` — indexed markdown page. Carries `docName` / `docExt`
 *   plus the symlink fields (aliases share `size` / `modified` with the
 *   canonical sibling; `targetPath` is the canonical-relative on-disk path
 *   when `isSymlink: true`).
 * - `kind: 'asset'` — referenced asset discovered through wiki-link or markdown
 *   image syntax. Carries `path` (contentDir-relative), `assetExt`,
 *   `mediaKind` (`'image' | 'video' | 'audio' | 'pdf' | 'text' | null` —
 *   `'text'` is set for data formats the sidebar previews via CodeMirror
 *   (json / toml / lock); `null` for non-renderable extensions that surface only
 *   via `[[wiki-link]]` references), and `referencedBy` (the docNames
 *   that point at it).
 * - `kind: 'file'` — any ContentFilter-passing non-markdown
 *   file that is NOT picked up as a referenced asset (e.g. `data.csv`,
 *   `FileTree.tsx`, `package.json`). Carries `path` (contentDir-relative,
 *   including the file's extension). No `mediaKind` / `referencedBy` (the
 *   server never reads its body — name/path only). This is the wire-side
 *   counterpart to the `FileIndexEntry.kind:'file'` discriminator, and lets
 *   the omnibar / picker surface every tracked file without a show-all toggle.
 *
 * Schema is `.loose()` for forward-compat. Default values live on the
 *   document-side fields so legacy clients reading existing pages stay
 *   compatible — asset-only fields are optional.
 */
export const DocumentListEntrySchema = z
  .object({
    kind: z.enum(['document', 'asset', 'folder', 'file']).default('document'),
    // docName is document-only — folders identify by `path`. Made optional
    // so the kind=='folder' variant can omit it; `.refine()` enforces presence
    // for document/asset variants.
    docName: z.string().min(1).optional(),
    docExt: z.string().min(1).default('.md'),
    size: z.number().int().nonnegative(),
    modified: z.string().min(1),
    isSymlink: z.boolean().default(false),
    canonicalDocName: z.string().nullable().default(null),
    targetPath: z.string().nullable().default(null),
    // Asset-only fields (populated when kind === 'asset'). The `path` field
    // is also reused by `kind === 'folder'` to carry the folder's relative
    // path within the content directory.
    path: z.string().min(1).optional(),
    assetExt: z.string().min(1).optional(),
    mediaKind: z.enum(['image', 'video', 'audio', 'pdf', 'text']).nullable().optional(),
    referencedBy: z.array(z.string().min(1)).optional(),
    // Folder-only. True when the folder contains at least one non-skipped child
    // entry. The depth-1 children variant of GET /api/documents
    // (`?dir=<rel>&depth=1`) sets it so the client can render an expand
    // affordance for each child folder without walking the subtree. Absent on
    // document/asset entries and on the recursive (`?showAll=true`) walk.
    hasChildren: z.boolean().optional(),
  })
  .loose()
  // Variant constraint enforced via `.refine()` rather than `.discriminatedUnion()`
  // because the `.default('document')` backwards-compat for legacy clients
  // that omit `kind` would block a DU migration. The `.refine()` rejects
  // illegal cross-variant field combinations (e.g.
  // `{ kind: 'document', mediaKind: 'image', assetExt: '.png' }` — asset
  // fields populated on a document entry) while preserving the default.
  .refine(
    (entry) => {
      if (entry.kind === 'document') {
        return (
          entry.docName !== undefined &&
          entry.path === undefined &&
          entry.assetExt === undefined &&
          entry.mediaKind === undefined &&
          entry.referencedBy === undefined &&
          entry.hasChildren === undefined
        );
      }
      if (entry.kind === 'folder') {
        // Folder entries carry `path` only. `docName` MUST be absent —
        // folders aren't documents, and the GET /api/documents emitter
        // intentionally omits it for the empty-folder rows.
        return (
          entry.docName === undefined &&
          entry.path !== undefined &&
          entry.assetExt === undefined &&
          entry.mediaKind === undefined &&
          entry.referencedBy === undefined
        );
      }
      if (entry.kind === 'file') {
        // File variant: name-only non-markdown row. Requires
        // `path` (contentDir-relative, includes the extension). `mediaKind` /
        // `referencedBy` MUST be absent — the server never reads the body and
        // these are reserved for the renderable-asset variant; `hasChildren`
        // is folder-only. `docName` is allowed (mirror of `path` so callers
        // that key on docName keep working). `assetExt` is allowed but
        // optional — the server populates it when the file has an extension
        // so the tree can decorate by extension without re-parsing the path.
        return (
          entry.path !== undefined &&
          entry.mediaKind === undefined &&
          entry.referencedBy === undefined &&
          entry.hasChildren === undefined
        );
      }
      // kind === 'asset' requires path + assetExt + referencedBy. mediaKind
      // is independently optional/nullable per the comment block above.
      // `docName` is allowed on assets (carries the canonical asset id —
      // emitter sets it to the same value as `path` for assets so existing
      // sidebar code that keys on docName keeps working).
      return (
        entry.path !== undefined &&
        entry.assetExt !== undefined &&
        entry.referencedBy !== undefined &&
        entry.hasChildren === undefined
      );
    },
    {
      message:
        'document/asset/folder/file kind must match its required fields (document → docName; asset → path+assetExt+referencedBy; folder → path only, no docName; file → path, no mediaKind/referencedBy/hasChildren)',
    },
  ) satisfies StandardSchemaV1;
export type DocumentListEntry = z.infer<typeof DocumentListEntrySchema>;

/** Success body for `GET /api/documents`. Sorted alphabetically by docName. */
export const DocumentListSuccessSchema = z
  .object({
    documents: z.array(DocumentListEntrySchema),
    // Set only by the `?showAll=true` branch: true when the on-demand disk
    // walk hit its entry ceiling and stopped early, so `documents` is a
    // partial prefix. Absent on the index-backed (non-showAll) response.
    truncated: z.boolean().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type DocumentListSuccess = z.infer<typeof DocumentListSuccessSchema>;

/**
 * Single backlink edge returned by `/api/backlinks`. `anchor` is null when
 * the backlink targets the page root (no `#heading`). `snippet` is the
 * surrounding paragraph or `null` when the source has no nearby prose.
 */
export const BacklinkEntrySchema = z
  .object({
    source: z.string().min(1),
    anchor: z.string().nullable(),
    title: z.string(),
    snippet: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type BacklinkEntry = z.infer<typeof BacklinkEntrySchema>;

/** Success body for `GET /api/backlinks?docName=...`. */
export const BacklinksSuccessSchema = z
  .object({
    docName: z.string().min(1),
    backlinks: z.array(BacklinkEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type BacklinksSuccess = z.infer<typeof BacklinksSuccessSchema>;

/**
 * Success body for `GET /api/backlink-counts?docNames=a,b,c`. Sparse map —
 * docNames failing `isSafeDocName` are silently dropped (read-only enrichment
 * for sidebar listings; failure is graceful).
 */
export const BacklinkCountsSuccessSchema = z
  .object({
    counts: z.record(z.string().min(1), z.number().int().nonnegative()),
  })
  .loose() satisfies StandardSchemaV1;
export type BacklinkCountsSuccess = z.infer<typeof BacklinkCountsSuccessSchema>;

/**
 * Single forward-link entry returned by `/api/forward-links`. Discriminated
 * by `kind`: `'doc'` carries `docName` + optional `anchor`; `'external'`
 * carries `url`. `title` falls back to the docName / URL when no
 * page-title is available; `snippet` is the surrounding paragraph or null.
 */
export const ForwardLinkDocEntrySchema = z
  .object({
    kind: z.literal('doc'),
    docName: z.string().min(1),
    anchor: z.string().nullable(),
    title: z.string(),
    snippet: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type ForwardLinkDocEntry = z.infer<typeof ForwardLinkDocEntrySchema>;

export const ForwardLinkExternalEntrySchema = z
  .object({
    kind: z.literal('external'),
    url: z.string().min(1),
    title: z.string(),
    snippet: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type ForwardLinkExternalEntry = z.infer<typeof ForwardLinkExternalEntrySchema>;

export const ForwardLinkEntrySchema = z.discriminatedUnion('kind', [
  ForwardLinkDocEntrySchema,
  ForwardLinkExternalEntrySchema,
]) satisfies StandardSchemaV1;
export type ForwardLinkEntry = z.infer<typeof ForwardLinkEntrySchema>;

/** Success body for `GET /api/forward-links?docName=...`. */
export const ForwardLinksSuccessSchema = z
  .object({
    docName: z.string().min(1),
    forwardLinks: z.array(ForwardLinkEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type ForwardLinksSuccess = z.infer<typeof ForwardLinksSuccessSchema>;

/**
 * Single graph node in `/api/link-graph`. Discriminated by `kind`. Doc nodes
 * carry frontmatter-derived metadata (`cluster`, `category`, `tags`) for
 * graph coloring; external nodes carry only the URL + label.
 */
export const LinkGraphDocNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('doc'),
    docName: z.string().min(1),
    anchor: z.string().nullable(),
    label: z.string(),
    cluster: z.string().nullable(),
    category: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type LinkGraphDocNode = z.infer<typeof LinkGraphDocNodeSchema>;

export const LinkGraphExternalNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('external'),
    url: z.string().min(1),
    label: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type LinkGraphExternalNode = z.infer<typeof LinkGraphExternalNodeSchema>;

export const LinkGraphNodeSchema = z.discriminatedUnion('kind', [
  LinkGraphDocNodeSchema,
  LinkGraphExternalNodeSchema,
]) satisfies StandardSchemaV1;
export type LinkGraphNode = z.infer<typeof LinkGraphNodeSchema>;

/** Single edge in `/api/link-graph`. `source` / `target` are node ids. */
export const LinkGraphEdgeSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type LinkGraphEdge = z.infer<typeof LinkGraphEdgeSchema>;

/** Success body for `GET /api/link-graph[?docName=...&degrees=N]`. */
export const LinkGraphSuccessSchema = z
  .object({
    nodes: z.array(LinkGraphNodeSchema),
    links: z.array(LinkGraphEdgeSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type LinkGraphSuccess = z.infer<typeof LinkGraphSuccessSchema>;
