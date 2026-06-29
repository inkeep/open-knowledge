import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const LifecycleStatusSchema = z
  .object({
    status: z.string().min(1),
    reason: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

export const DocumentReadSuccessSchema = z
  .object({
    docName: z.string().min(1),
    content: z.string(),
    lifecycle: LifecycleStatusSchema.nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type DocumentReadSuccess = z.infer<typeof DocumentReadSuccessSchema>;

export const DocumentListEntrySchema = z
  .object({
    kind: z.enum(['document', 'asset', 'folder', 'file']).default('document'),
    docName: z.string().min(1).optional(),
    docExt: z.string().min(1).default('.md'),
    size: z.number().int().nonnegative(),
    modified: z.string().min(1),
    isSymlink: z.boolean().default(false),
    canonicalDocName: z.string().nullable().default(null),
    targetPath: z.string().nullable().default(null),
    path: z.string().min(1).optional(),
    assetExt: z.string().min(1).optional(),
    mediaKind: z.enum(['image', 'video', 'audio', 'pdf', 'text']).nullable().optional(),
    referencedBy: z.array(z.string().min(1)).optional(),
    hasChildren: z.boolean().optional(),
  })
  .loose()
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
        return (
          entry.docName === undefined &&
          entry.path !== undefined &&
          entry.assetExt === undefined &&
          entry.mediaKind === undefined &&
          entry.referencedBy === undefined
        );
      }
      if (entry.kind === 'file') {
        return (
          entry.path !== undefined &&
          entry.mediaKind === undefined &&
          entry.referencedBy === undefined &&
          entry.hasChildren === undefined
        );
      }
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

export const DocumentListSuccessSchema = z
  .object({
    documents: z.array(DocumentListEntrySchema),
    truncated: z.boolean().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type DocumentListSuccess = z.infer<typeof DocumentListSuccessSchema>;

export const BacklinkEntrySchema = z
  .object({
    source: z.string().min(1),
    anchor: z.string().nullable(),
    title: z.string(),
    snippet: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type BacklinkEntry = z.infer<typeof BacklinkEntrySchema>;

export const BacklinksSuccessSchema = z
  .object({
    docName: z.string().min(1),
    backlinks: z.array(BacklinkEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type BacklinksSuccess = z.infer<typeof BacklinksSuccessSchema>;

export const BacklinkCountsSuccessSchema = z
  .object({
    counts: z.record(z.string().min(1), z.number().int().nonnegative()),
  })
  .loose() satisfies StandardSchemaV1;
export type BacklinkCountsSuccess = z.infer<typeof BacklinkCountsSuccessSchema>;

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

export const ForwardLinksSuccessSchema = z
  .object({
    docName: z.string().min(1),
    forwardLinks: z.array(ForwardLinkEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type ForwardLinksSuccess = z.infer<typeof ForwardLinksSuccessSchema>;

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

export const LinkGraphEdgeSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type LinkGraphEdge = z.infer<typeof LinkGraphEdgeSchema>;

export const LinkGraphSuccessSchema = z
  .object({
    nodes: z.array(LinkGraphNodeSchema),
    links: z.array(LinkGraphEdgeSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type LinkGraphSuccess = z.infer<typeof LinkGraphSuccessSchema>;
