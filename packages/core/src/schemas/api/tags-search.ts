
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { MANAGED_ARTIFACT_SCOPES } from '../../constants/cc1.ts';
import { SkillTargetEditorSchema } from '../../skill-targets/schema.ts';
import { agentIdentityFields, summaryField } from './_shared.ts';

export const TagSummaryEntrySchema = z
  .object({
    name: z.string().min(1),
    count: z.number().int().nonnegative(),
    isLeaf: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type TagSummaryEntry = z.infer<typeof TagSummaryEntrySchema>;

export const TagsListSuccessSchema = z
  .object({
    tags: z.array(TagSummaryEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type TagsListSuccess = z.infer<typeof TagsListSuccessSchema>;

export const TagsDocEntrySchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
    matchingTags: z.array(z.string().min(1)),
    snippet: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type TagsDocEntry = z.infer<typeof TagsDocEntrySchema>;

export const TagsForNameSuccessSchema = z
  .object({
    name: z.string().min(1),
    docs: z.array(TagsDocEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type TagsForNameSuccess = z.infer<typeof TagsForNameSuccessSchema>;

export const FolderConfigGetSuccessSchema = z
  .object({
    folder: z.unknown(),
    frontmatter_local: z.record(z.string(), z.unknown()).nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type FolderConfigGetSuccess = z.infer<typeof FolderConfigGetSuccessSchema>;

export const FolderConfigPutRequestSchema = z
  .object({
    path: z.string(),
    frontmatter: z.record(z.string(), z.unknown()).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type FolderConfigPutRequest = z.infer<typeof FolderConfigPutRequestSchema>;

export const FolderConfigPutSuccessSchema = z
  .object({
    applied: z.unknown(),
  })
  .loose() satisfies StandardSchemaV1;
export type FolderConfigPutSuccess = z.infer<typeof FolderConfigPutSuccessSchema>;

export const TemplateFrontmatterSchema = z
  .record(z.string(), z.unknown())
  .meta({ description: 'Free-form frontmatter map embedded in template payloads.' });
export type TemplateFrontmatter = z.infer<typeof TemplateFrontmatterSchema>;

export const TemplatePayloadSchema = z
  .object({
    name: z.string().min(1),
    folder: z.string(),
    scope: z.enum(['local', 'inherited']),
    path: z.string().min(1),
    frontmatter: TemplateFrontmatterSchema,
    body: z.string(),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatePayload = z.infer<typeof TemplatePayloadSchema>;

export const TemplateGetSuccessSchema = z
  .object({
    template: TemplatePayloadSchema,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateGetSuccess = z.infer<typeof TemplateGetSuccessSchema>;

export const TemplatesListEntrySchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    path: z.string().min(1),
    source_folder: z.string(),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatesListEntry = z.infer<typeof TemplatesListEntrySchema>;

export const TemplatesListSuccessSchema = z
  .object({
    templates: z.array(TemplatesListEntrySchema),
    truncated: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatesListSuccess = z.infer<typeof TemplatesListSuccessSchema>;

export const TemplatePutRequestSchema = z
  .object({
    folder: z.string(),
    name: z.string(),
    body: z.string().optional(),
    frontmatter: TemplateFrontmatterSchema.optional(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatePutRequest = z.infer<typeof TemplatePutRequestSchema>;

export const TemplatePutSuccessSchema = z
  .object({
    path: z.string().min(1),
    created: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatePutSuccess = z.infer<typeof TemplatePutSuccessSchema>;

export const TemplateDeleteSuccessSchema = z
  .object({
    existed: z.boolean(),
    path: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateDeleteSuccess = z.infer<typeof TemplateDeleteSuccessSchema>;

export const TemplateMoveRequestSchema = z
  .object({
    fromFolder: z.string(),
    fromName: z.string(),
    toFolder: z.string(),
    toName: z.string(),
    body: z.string().optional(),
    frontmatter: TemplateFrontmatterSchema.optional(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateMoveRequest = z.infer<typeof TemplateMoveRequestSchema>;

export const TemplateMoveSuccessSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    committed: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateMoveSuccess = z.infer<typeof TemplateMoveSuccessSchema>;


/** Skill scope: `project` (shared via git) or `global` (user store).
 *  Derived from the canonical `MANAGED_ARTIFACT_SCOPES` (cc1.ts) — do not
 *  re-declare the tuple. */
export const SkillScopeSchema = z.enum(MANAGED_ARTIFACT_SCOPES);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SKILL_NAME_REGEX = /^[a-z0-9-]+$/;

const XML_TAG_REGEX = /<\/?[A-Za-z][^>]*>/;
export function containsXmlTag(s: string): boolean {
  return XML_TAG_REGEX.test(s);
}

export const TEMPLATE_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

export const SkillFrontmatterSchema = z
  .object({
    name: z.string(),
    description: z.string(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const SkillPayloadSchema = z
  .object({
    name: z.string().min(1),
    scope: SkillScopeSchema,
    path: z.string().min(1),
    frontmatter: SkillFrontmatterSchema,
    body: z.string(),
    files: z
      .array(
        z.object({
          path: z.string().min(1),
          text: z.string().nullable(),
        }),
      )
      .optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillPayload = z.infer<typeof SkillPayloadSchema>;

export const SkillGetSuccessSchema = z
  .object({
    skill: SkillPayloadSchema,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillGetSuccess = z.infer<typeof SkillGetSuccessSchema>;

export const SkillsListEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    scope: SkillScopeSchema,
    path: z.string().min(1),
    /** Absolute on-disk path to the skill's SKILL.md — drives the desktop
     *  Reveal-in-Finder / Open-in-Terminal / Copy-Path row actions. Always set on
     *  `/api/skills` list entries; omitted on partial entries built client-side
     *  (a cold deep-link before the list loads), where those actions disable. */
    absolutePath: z.string().min(1).optional(),
    installed: z.boolean(),
    hosts: z.array(z.string()),
    installedVersion: z.string().optional(),
    bundledVersion: z.string().optional(),
    updateAvailable: z.boolean().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillsListEntry = z.infer<typeof SkillsListEntrySchema>;

export const SkillsListSuccessSchema = z
  .object({
    skills: z.array(SkillsListEntrySchema),
    truncated: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillsListSuccess = z.infer<typeof SkillsListSuccessSchema>;

export const SkillPutRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    body: z.string().optional(),
    frontmatter: SkillFrontmatterSchema,
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillPutRequest = z.infer<typeof SkillPutRequestSchema>;

export const SkillPutSuccessSchema = z
  .object({
    path: z.string().min(1),
    created: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillPutSuccess = z.infer<typeof SkillPutSuccessSchema>;

export const SkillUpdateRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillUpdateRequest = z.infer<typeof SkillUpdateRequestSchema>;

export const SkillUpdateSuccessSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    previousVersion: z.string().optional(),
    checkpointRef: z.string().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillUpdateSuccess = z.infer<typeof SkillUpdateSuccessSchema>;

export const SkillDeleteSuccessSchema = z
  .object({
    existed: z.boolean(),
    path: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillDeleteSuccess = z.infer<typeof SkillDeleteSuccessSchema>;

export const SkillMoveRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    fromName: z.string(),
    toName: z.string(),
    body: z.string().optional(),
    frontmatter: SkillFrontmatterSchema.optional(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillMoveRequest = z.infer<typeof SkillMoveRequestSchema>;

export const SkillMoveSuccessSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    committed: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillMoveSuccess = z.infer<typeof SkillMoveSuccessSchema>;

export const SkillFileKindSchema = z.enum(['reference', 'script']);
export type SkillFileKind = z.infer<typeof SkillFileKindSchema>;

export const SkillFilePutRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    path: z.string().min(1),
    content: z.string(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFilePutRequest = z.infer<typeof SkillFilePutRequestSchema>;

export const SkillFilePutSuccessSchema = z
  .object({
    path: z.string().min(1),
    created: z.boolean(),
    kind: SkillFileKindSchema,
    content: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFilePutSuccess = z.infer<typeof SkillFilePutSuccessSchema>;

export const SkillFileGetSuccessSchema = z
  .object({
    path: z.string().min(1),
    kind: SkillFileKindSchema,
    text: z.string(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFileGetSuccess = z.infer<typeof SkillFileGetSuccessSchema>;

export const SkillFileDeleteSuccessSchema = z
  .object({
    path: z.string().min(1),
    existed: z.boolean(),
    kind: SkillFileKindSchema,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFileDeleteSuccess = z.infer<typeof SkillFileDeleteSuccessSchema>;

export const SkillInstallRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    targets: z.array(SkillTargetEditorSchema).optional().meta({
      description: 'Explicit editor ids to install into; omit to use project-configured editors.',
    }),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillInstallRequest = z.infer<typeof SkillInstallRequestSchema>;

export const SKILL_INSTALL_WARNING_CODES = ['no-targets', 'scripts-present'] as const;
export type SkillInstallWarningCode = (typeof SKILL_INSTALL_WARNING_CODES)[number];

export const SkillInstallSuccessSchema = z
  .object({
    name: z.string().min(1),
    hosts: z.array(z.string()),
    scripts: z.boolean(),
    warnings: z.array(z.string()),
    warningCodes: z.array(z.enum(SKILL_INSTALL_WARNING_CODES)),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillInstallSuccess = z.infer<typeof SkillInstallSuccessSchema>;

export const SkillUninstallRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillUninstallRequest = z.infer<typeof SkillUninstallRequestSchema>;

export const SkillUninstallSuccessSchema = z
  .object({
    name: z.string().min(1),
    uninstalled: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillUninstallSuccess = z.infer<typeof SkillUninstallSuccessSchema>;

export const SkillTargetsGetSuccessSchema = z
  .object({
    targets: z.array(SkillTargetEditorSchema),
    configured: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTargetsGetSuccess = z.infer<typeof SkillTargetsGetSuccessSchema>;

export const SkillTargetsPutRequestSchema = z
  .object({
    targets: z.array(SkillTargetEditorSchema),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTargetsPutRequest = z.infer<typeof SkillTargetsPutRequestSchema>;

export const SkillTargetsPutSuccessSchema = z
  .object({
    targets: z.array(SkillTargetEditorSchema),
    reprojected: z.array(z.object({ name: z.string(), hosts: z.array(z.string()) }).strict()),
    bundleHosts: z.array(z.string()),
    removedFrom: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTargetsPutSuccess = z.infer<typeof SkillTargetsPutSuccessSchema>;

export const SkillRestoreRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    version: z.string().regex(/^[0-9a-f]{40}$/i),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillRestoreRequest = z.infer<typeof SkillRestoreRequestSchema>;

export const SkillRestoreSuccessSchema = z
  .object({
    name: z.string().min(1),
    version: z.string(),
    restoredFiles: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillRestoreSuccess = z.infer<typeof SkillRestoreSuccessSchema>;

export const SearchRequestSchema = z
  .object({
    query: z.string().optional(),
    intent: z.enum(['autocomplete', 'full_text', 'omnibar']).optional(),
    ranking: z.enum(['navigation', 'relevance']).optional(),
    scopes: z.array(z.enum(['page', 'folder', 'content', 'file'])).optional(),
    scope: z.string().optional(),
    limit: z.number().int().nonnegative().optional(),
    semantic: z.boolean().optional(),
    source: z.enum(['omnibar', 'mcp', 'http']).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export type SearchSource = NonNullable<SearchRequest['source']>;

export const SearchResultEntrySchema = z
  .object({
    kind: z.enum(['page', 'folder', 'content', 'file']),
    path: z.string().min(1),
    title: z.string(),
    score: z.number(),
    signals: z.record(z.string(), z.unknown()),
    snippet: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchResultEntry = z.infer<typeof SearchResultEntrySchema>;

export const SearchSemanticStatusSchema = z
  .object({
    capable: z.boolean(),
    applied: z.boolean(),
    coverage: z.object({
      embedded: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchSemanticStatus = z.infer<typeof SearchSemanticStatusSchema>;

export const SemanticIndexStatusSchema = z
  .object({
    enabled: z.boolean(),
    keyPresent: z.boolean(),
    keySource: z.enum(['file', 'env']).nullable(),
    keyHint: z.string().nullable(),
    ready: z.boolean(),
    capable: z.boolean(),
    embedded: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type SemanticIndexStatus = z.infer<typeof SemanticIndexStatusSchema>;

export const SearchSuccessSchema = z
  .object({
    query: z.string(),
    intent: z.enum(['autocomplete', 'full_text', 'omnibar']),
    results: z.array(SearchResultEntrySchema),
    elapsedMs: z.number().nonnegative(),
    semantic: SearchSemanticStatusSchema.optional(),
    truncated: z.boolean().optional(),
    ready: z.boolean().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchSuccess = z.infer<typeof SearchSuccessSchema>;

export const SkillInstallTargetStateSchema = z
  .object({
    version: z.string().min(1),
    recordedAt: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillInstallTargetState = z.infer<typeof SkillInstallTargetStateSchema>;

export const SkillInstallStateSuccessSchema = z
  .object({
    currentVersion: z.string().min(1),
    targets: z.record(z.string(), SkillInstallTargetStateSchema.nullable()),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillInstallStateSuccess = z.infer<typeof SkillInstallStateSuccessSchema>;

