
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { agentIdentityFields, summaryField } from './_shared.ts';
import {
  AdvisoryWarningsSchema,
  ContentDivergenceWarningSchema,
  SummaryResponseFieldSchema,
} from './agent-write.ts';

export const RenamedDocMappingSchema = z
  .object({
    fromDocName: z.string().min(1),
    toDocName: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type RenamedDocMapping = z.infer<typeof RenamedDocMappingSchema>;

export const RenamedAssetMappingSchema = z
  .object({
    fromPath: z.string().min(1),
    toPath: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type RenamedAssetMapping = z.infer<typeof RenamedAssetMappingSchema>;

export const EmptyRequestSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type EmptyRequest = z.infer<typeof EmptyRequestSchema>;

export const CreatePageRequestSchema = z
  .object({
    path: z.string().min(1),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type CreatePageRequest = z.infer<typeof CreatePageRequestSchema>;

export const CreatePageSuccessSchema = z
  .object({
    docName: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type CreatePageSuccess = z.infer<typeof CreatePageSuccessSchema>;

export const CreateFolderRequestSchema = z
  .object({
    path: z.string().min(1),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type CreateFolderRequest = z.infer<typeof CreateFolderRequestSchema>;

export const CreateFolderSuccessSchema = z
  .object({
    path: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type CreateFolderSuccess = z.infer<typeof CreateFolderSuccessSchema>;

export const DuplicatePathRequestSchema = z
  .object({
    kind: z.enum(['file', 'folder']),
    path: z.string().min(1),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type DuplicatePathRequest = z.infer<typeof DuplicatePathRequestSchema>;

export const DuplicatePathSuccessSchema = z
  .object({
    kind: z.enum(['file', 'folder']),
    path: z.string().min(1),
    duplicatedDocNames: z.array(z.string().min(1)),
  })
  .loose() satisfies StandardSchemaV1;
export type DuplicatePathSuccess = z.infer<typeof DuplicatePathSuccessSchema>;

export const PageEntrySchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
    docExt: z.string().min(1),
    size: z.number().int().nonnegative(),
    modified: z.string().min(1),
    icon: z.string().min(1).max(2048).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type PageEntry = z.infer<typeof PageEntrySchema>;

export const PagesSuccessSchema = z
  .object({
    pages: z.array(PageEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type PagesSuccess = z.infer<typeof PagesSuccessSchema>;

export const HeadingEntrySchema = z
  .object({
    level: z.number().int().min(1).max(6),
    text: z.string(),
    slug: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type HeadingEntry = z.infer<typeof HeadingEntrySchema>;

export const PageHeadingsSuccessSchema = z
  .object({
    docName: z.string().min(1),
    headings: z.array(HeadingEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type PageHeadingsSuccess = z.infer<typeof PageHeadingsSuccessSchema>;

export const RenameRewrittenDocSchema = z
  .object({
    docName: z.string().min(1),
    rewrites: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type RenameRewrittenDoc = z.infer<typeof RenameRewrittenDocSchema>;

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

export const RenamePathSuccessSchema = z
  .object({
    renamed: z.array(RenamedDocMappingSchema),
    renamedAssets: z.array(RenamedAssetMappingSchema),
    rewrittenDocs: z.array(RenameRewrittenDocSchema).optional(),
    summary: SummaryResponseFieldSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type RenamePathSuccess = z.infer<typeof RenamePathSuccessSchema>;

export const DeletePathRequestSchema = z
  .object({
    kind: z.enum(['file', 'folder', 'asset']),
    path: z.string().min(1),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type DeletePathRequest = z.infer<typeof DeletePathRequestSchema>;

export const DeletePathSuccessSchema = z
  .object({
    deletedDocNames: z.array(z.string().min(1)),
  })
  .loose() satisfies StandardSchemaV1;
export type DeletePathSuccess = z.infer<typeof DeletePathSuccessSchema>;

export const TrashCleanupRequestSchema = z
  .object({
    kind: z.enum(['file', 'folder', 'asset']),
    path: z.string().min(1),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type TrashCleanupRequest = z.infer<typeof TrashCleanupRequestSchema>;

export const TrashCleanupSuccessSchema = z
  .object({
    deletedDocNames: z.array(z.string().min(1)),
  })
  .loose() satisfies StandardSchemaV1;
export type TrashCleanupSuccess = z.infer<typeof TrashCleanupSuccessSchema>;

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

export const RollbackSuccessSchema = z
  .object({
    restoredFrom: z.string().min(1),
    timestamp: z.string().min(1),
    summary: SummaryResponseFieldSchema.optional(),
    warning: ContentDivergenceWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type RollbackSuccess = z.infer<typeof RollbackSuccessSchema>;
