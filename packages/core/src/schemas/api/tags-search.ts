import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { MANAGED_ARTIFACT_SCOPES } from '../../constants/cc1.ts';
import {
  SkillTargetEditorSchema,
  SkillUserTargetEditorSchema,
} from '../../skill-targets/schema.ts';
import { SkillCostTiersSchema } from '../../skills-catalog/skill-cost.ts';
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

export const TemplateImportRequestSchema = z
  .object({
    sourcePath: z.string().min(1),
    targetFolder: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    deleteSource: z.boolean().optional(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateImportRequest = z.infer<typeof TemplateImportRequestSchema>;

export const TemplateImportSuccessSchema = z
  .object({
    path: z.string().min(1),
    created: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateImportSuccess = z.infer<typeof TemplateImportSuccessSchema>;

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
    metadata: z.object({ pack: z.string() }).strict().optional(),
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
    managed: z.boolean().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillPayload = z.infer<typeof SkillPayloadSchema>;

export const SkillGetSuccessSchema = z
  .object({
    skill: SkillPayloadSchema,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillGetSuccess = z.infer<typeof SkillGetSuccessSchema>;

export const SkillOriginSchema = z
  .object({
    source: z.string().min(1),
    publisher: z.string().optional(),
    skill: z.string().optional(),
    marketplaceUrl: z.string().optional(),
    importedAt: z.string().min(1),
    autoUpdate: z.boolean().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;

export const SkillsListEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    scope: SkillScopeSchema,
    path: z.string().min(1),
    canonicalPath: z.string().min(1).optional(),
    filePaths: z.array(z.string()).optional(),
    absolutePath: z.string().min(1).optional(),
    installed: z.boolean(),
    hosts: z.array(z.string()),
    hostQualifier: z.string().optional().meta({
      description:
        'Set on a GLOBAL entry that shares its name with a distinct-content bundle in another host dir AND is not the by-name default: the host id whose root holds THIS bundle. Doc-name builders append it (`__skill__/global/<name>@<host>`) so each same-named bundle keeps its own tab and its own write-back path; the default bundle keeps the stable unqualified name.',
    }),
    driftPaths: z.array(z.string()).optional().meta({
      description:
        'Recorded locations whose on-disk form (copy vs symlink) no longer matches what OK last wrote there — evidence another tool rewrote the path.',
    }),
    hostAliases: z.record(z.string(), z.string()).optional().meta({
      description:
        "Host skills roots that are symlink ALIASES of another location (host id → base-relative target root). An aliased folder is a derived view — no menu row, never a write target; the host's icon rides the target root's row.",
    }),
    conflictHosts: z.array(z.string()).optional().meta({
      description:
        'Hosts whose dir holds a DIFFERENT same-name skill (fork/conflict) — occupied, not this skill.',
    }),
    symlinkedHosts: z.array(z.string()).optional(),
    installableEditors: z.array(z.string()).optional(),
    hubOffered: z.boolean().optional().meta({
      description:
        'Whether the vendor-neutral `.agents/skills` hub is a live destination at this scope on THIS machine — server-computed via the same predicate that filters the Folders surface, so the install menu and Settings cannot disagree. True when the project already uses the hub OR a host that reads it is installed (`HUB_READER_EDITORS`).',
    }),
    linkMode: z.boolean().optional(),
    customPlacements: z
      .array(z.object({ path: z.string(), mode: z.enum(['copy', 'link']) }).strict())
      .optional(),
    plugin: z
      .object({
        name: z.string().min(1),
        marketplace: z.string().min(1),
        provider: z.string().min(1),
        url: z.string().optional(),
      })
      .strict()
      .optional(),
    managed: z.boolean().optional(),
    origin: SkillOriginSchema.optional(),
    pack: z.string().optional(),
    modified: z.boolean().optional(),
    revertable: z.boolean().optional(),
    ignored: z.boolean().optional(),
    size: SkillCostTiersSchema.optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillsListEntry = z.infer<typeof SkillsListEntrySchema>;

export const SkillTrackInGitRequestSchema = z
  .object({
    name: z.string().min(1),
    scope: SkillScopeSchema,
    apply: z.boolean().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTrackInGitRequest = z.infer<typeof SkillTrackInGitRequestSchema>;

export const SkillTrackInGitSuccessSchema = z
  .object({
    line: z.string().min(1),
    gitignorePath: z.string().min(1),
    applied: z.boolean(),
    alreadyTracked: z.boolean().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTrackInGitSuccess = z.infer<typeof SkillTrackInGitSuccessSchema>;

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
    name: z.string().meta({ description: 'Managed skill name to create or update.' }),
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

export const SkillReimportRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    dryRun: z.boolean().optional(),
    setAutoUpdate: z.boolean().optional(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillReimportRequest = z.infer<typeof SkillReimportRequestSchema>;

export const SkillReimportSuccessSchema = z
  .object({
    name: z.string().min(1),
    updated: z.boolean(),
    source: z.string().min(1),
    localBody: z.string().optional(),
    upstreamBody: z.string().optional(),
    gitTracked: z.boolean().optional(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillReimportSuccess = z.infer<typeof SkillReimportSuccessSchema>;

export const SkillRevertRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillRevertRequest = z.infer<typeof SkillRevertRequestSchema>;

export const SkillRevertSuccessSchema = z
  .object({
    name: z.string().min(1),
    baselineRef: z.string().min(1),
    restoredFiles: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillRevertSuccess = z.infer<typeof SkillRevertSuccessSchema>;

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

export const SkillMoveScopeRequestSchema = z
  .object({
    name: z.string(),
    fromScope: SkillScopeSchema,
    toScope: SkillScopeSchema,
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillMoveScopeRequest = z.infer<typeof SkillMoveScopeRequestSchema>;

export const SkillMoveScopeSuccessSchema = z
  .object({
    scope: SkillScopeSchema,
    path: z.string().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillMoveScopeSuccess = z.infer<typeof SkillMoveScopeSuccessSchema>;

export const SkillDuplicateRequestSchema = z
  .object({
    scope: SkillScopeSchema,
    name: z.string(),
    toName: z.string(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillDuplicateRequest = z.infer<typeof SkillDuplicateRequestSchema>;

export const SkillDuplicateSuccessSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillDuplicateSuccess = z.infer<typeof SkillDuplicateSuccessSchema>;

export const SkillEditExternalRequestSchema = z
  .object({
    name: z.string(),
    home: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillEditExternalRequest = z.infer<typeof SkillEditExternalRequestSchema>;

export const SkillEditExternalSuccessSchema = z
  .object({
    docName: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillEditExternalSuccess = z.infer<typeof SkillEditExternalSuccessSchema>;

export const SkillFileKindSchema = z.enum(['reference', 'script', 'file']);
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

export const SkillFileRenameRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    from: z.string().min(1),
    to: z.string().min(1),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFileRenameRequest = z.infer<typeof SkillFileRenameRequestSchema>;

export const SkillFileRenameSuccessSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    fromDocName: z.string().optional(),
    toDocName: z.string().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFileRenameSuccess = z.infer<typeof SkillFileRenameSuccessSchema>;

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

export const SkillHostIdArgSchema = z.union([SkillUserTargetEditorSchema, z.literal('agents')]);
export type SkillHostIdArg = z.infer<typeof SkillHostIdArgSchema>;

export const SkillRootPathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.startsWith('~') && !/^[A-Za-z]:/.test(p), {
    error: 'a custom root is base-relative (e.g. ".tim/skills"), not absolute or ~-prefixed',
  })
  .refine((p) => p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'), {
    error: 'a custom root may not contain "..", "." or empty path segments',
  })
  .refine((p) => p.includes('/'), {
    error: 'a custom root is a path (e.g. ".tim/skills") — bare editor names are host ids',
  });

export const SkillLocationIdSchema = z.union([SkillHostIdArgSchema, SkillRootPathSchema]);
export type SkillLocationId = z.infer<typeof SkillLocationIdSchema>;

export const SkillInstallRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    targets: z.array(SkillHostIdArgSchema).optional().meta({
      description:
        'SET-EXACT install targets (editor ids, plus "agents" for the .agents hub — in-place skills only): the COMPLETE resulting host set. Omit to use project-configured editors; pass [] to uninstall everywhere. Stateless callers should prefer `add`/`remove`.',
    }),
    add: z.array(SkillLocationIdSchema).optional().meta({
      description:
        'Locations to ADD the skill to (everything else untouched). Editor ids fan out a managed copy/symlink; a custom root path (".tim/skills") places the bundle there.',
    }),
    remove: z.array(SkillLocationIdSchema).optional().meta({
      description:
        'Locations to REMOVE the skill from (lossless only — a hand-edited fork is refused, never deleted). The source cannot be removed; move it first with `source`.',
    }),
    mode: z.enum(['copy', 'link']).optional().meta({
      description:
        '"link": one real folder (the source); every other location becomes a symlink to it. "copy": independent real folders, refreshed from the source until hand-edited (a hand-edit forks that copy). Converts existing locations losslessly. Omit to follow the form the skill already uses.',
    }),
    source: SkillLocationIdSchema.optional().meta({
      description:
        "Move the skill's REAL folder to this location (the old source becomes a symlink to it — never a removal). Sticky across rescans.",
    }),
    linkMode: z.boolean().optional(),
    setSource: z.string().min(1).optional(),
    place: z
      .object({
        dir: z.string().min(1).meta({
          description:
            'Project-relative directory the bundle dir is created under (e.g. ".windsurf/skills").',
        }),
        mode: z.enum(['copy', 'link']),
      })
      .strict()
      .optional(),
    convert: z
      .object({
        target: SkillLocationIdSchema.meta({
          description:
            'The installed location to convert — an editor id, "agents", or a recorded custom placement path.',
        }),
        mode: z.enum(['copy', 'link']).meta({
          description:
            '"link": replace this location with a symlink to the source. "copy": replace it with an independent real folder.',
        }),
      })
      .strict()
      .optional(),
    unplace: z
      .object({
        path: z.string().min(1).meta({
          description: 'The recorded placement bundle path (e.g. ".windsurf/skills/my-skill").',
        }),
      })
      .strict()
      .optional(),
    ...agentIdentityFields,
    summary: summaryField,
    fork: z
      .object({
        editor: z.string().min(1),
        action: z.enum(['align', 'make-source', 'rename']),
        toName: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => !(b.targets !== undefined && (b.add !== undefined || b.remove !== undefined)), {
    error: '`targets` is set-exact; `add`/`remove` are additive — use one style per call',
  })
  .refine(
    (b) =>
      b.fork === undefined ||
      (b.targets === undefined &&
        b.add === undefined &&
        b.remove === undefined &&
        b.source === undefined &&
        b.setSource === undefined),
    { error: '`fork` is its own operation — run it in a separate call' },
  )
  .refine((b) => b.fork?.action !== 'rename' || b.fork.toName !== undefined, {
    error: '`fork.rename` requires `toName`',
  })
  .refine((b) => !(b.source !== undefined && (b.add !== undefined || b.remove !== undefined)), {
    error: 'a `source` move is its own operation — run it in a separate call from `add`/`remove`',
  })
  .refine(
    (b) =>
      [
        b.targets !== undefined || b.add !== undefined || b.remove !== undefined,
        b.place !== undefined,
        b.unplace !== undefined,
        b.convert !== undefined,
        b.source !== undefined || b.setSource !== undefined,
        b.fork !== undefined,
      ].filter(Boolean).length <= 1,
    {
      error:
        'one operation per call — membership (`targets`/`add`/`remove`), `place`, `unplace`, `convert`, `source`, and `fork` are mutually exclusive',
    },
  ) satisfies StandardSchemaV1;
export type SkillInstallRequest = z.infer<typeof SkillInstallRequestSchema>;

export const SKILL_INSTALL_WARNING_CODES = [
  'no-targets',
  'scripts-present',
  'name-conflict',
  'no-description',
  'skill-fork-name-unpatched',
  'place-path-invalid',
  'place-fork-refused',
] as const;
export type SkillInstallWarningCode = (typeof SKILL_INSTALL_WARNING_CODES)[number];

export const SkillInstallSuccessSchema = z
  .object({
    name: z.string().min(1).meta({ description: 'Managed skill name installed or uninstalled.' }),
    hosts: z.array(z.string()).meta({
      description:
        'Editor ids the skill is projected into after the operation; [] is expected after uninstall.',
    }),
    scripts: z.boolean().meta({
      description: 'True when the skill ships executable scripts, projected but never run.',
    }),
    warnings: z
      .array(z.string())
      .meta({ description: 'Non-fatal install/uninstall warnings from target projection.' }),
    warningCodes: z
      .array(z.enum(SKILL_INSTALL_WARNING_CODES))
      .meta({ description: 'Machine-readable warning codes aligned with `warnings`.' }),
    placedAt: z.string().optional(),
    sourceMovedTo: z.string().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillInstallSuccess = z.infer<typeof SkillInstallSuccessSchema>;

export const SkillUninstallRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z
      .string()
      .meta({ description: 'Managed skill name to uninstall without deleting source.' }),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillUninstallRequest = z.infer<typeof SkillUninstallRequestSchema>;

export const SkillUninstallSuccessSchema = z
  .object({
    name: z.string().min(1).meta({ description: 'Managed skill name requested for uninstall.' }),
    uninstalled: z.boolean().meta({
      description:
        'True when an install marker existed and was removed; false for an idempotent no-op.',
    }),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillUninstallSuccess = z.infer<typeof SkillUninstallSuccessSchema>;

export const SkillTargetsGetSuccessSchema = z
  .object({
    targets: z.array(SkillTargetEditorSchema),
    configured: z.boolean(),
    folders: z
      .array(
        z
          .object({
            scope: SkillScopeSchema,
            host: z.string(),
            root: z.string(),
            state: z.enum(['own', 'linked', 'linked-parent', 'absent']),
            target: z.string().optional(),
            drift: z.literal(true).optional(),
            expected: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTargetsGetSuccess = z.infer<typeof SkillTargetsGetSuccessSchema>;

const SkillFolderLinkBase = z.object({
  action: z.literal('link'),
  scope: SkillScopeSchema,
  root: z.string().min(1).meta({ description: 'The folder to link (e.g. ".codex/skills").' }),
  target: z
    .string()
    .min(1)
    .meta({ description: 'The root it merges into (e.g. ".agents/skills"). Required.' }),
});

const SkillFolderUnlinkSchema = z
  .object({
    action: z.literal('unlink'),
    scope: SkillScopeSchema,
    root: z.string().min(1).meta({ description: 'The linked folder to materialize back.' }),
    exclude: z.array(z.string().min(1)).optional().meta({
      description:
        'Skill names to LEAVE OUT when materializing — the folder keeps every other skill it currently sees (as per-skill links) and stops auto-following the target root.',
    }),
  })
  .strict();

const SkillFolderAddRootSchema = z
  .object({
    action: z.literal('add-root'),
    scope: SkillScopeSchema,
    root: SkillRootPathSchema.meta({
      description: 'New custom skills root to declare (base-relative, e.g. ".team/skills").',
    }),
  })
  .strict();

export const SkillFolderActionSchema = z.discriminatedUnion('action', [
  SkillFolderLinkBase.extend({
    preview: z.boolean().optional().meta({
      description:
        'Return the merge plan only (moves, drops, removes, conflicts, strays) — nothing is written.',
    }),
  }).strict(),
  SkillFolderUnlinkSchema,
  SkillFolderAddRootSchema,
]);
export type SkillFolderAction = z.infer<typeof SkillFolderActionSchema>;

export const SkillFolderActionMcpSchema = z.discriminatedUnion('action', [
  SkillFolderLinkBase.strict(),
  SkillFolderUnlinkSchema,
  SkillFolderAddRootSchema,
]);
export type SkillFolderActionMcp = z.infer<typeof SkillFolderActionMcpSchema>;

export const SkillTargetsPutRequestSchema = z
  .object({
    folderAction: SkillFolderActionSchema,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTargetsPutRequest = z.infer<typeof SkillTargetsPutRequestSchema>;

export const SkillFolderLinkPreviewSchema = z
  .object({
    moves: z.array(z.string()),
    drops: z.array(z.string()),
    removes: z.array(z.string()),
    replaces: z.array(z.string()),
    conflicts: z.array(z.string()),
    strays: z.array(z.string()),
  })
  .strict();
export type SkillFolderLinkPreview = z.infer<typeof SkillFolderLinkPreviewSchema>;

export const SkillTargetsPutSuccessSchema = z
  .object({
    targets: z.array(SkillTargetEditorSchema),
    reprojected: z.array(z.object({ name: z.string(), hosts: z.array(z.string()) }).strict()),
    bundleHosts: z.array(z.string()),
    removedFrom: z.array(z.string()),
    folder: z
      .object({
        moved: z.array(z.string()),
        dropped: z.array(z.string()),
        linked: z.array(z.string()),
      })
      .strict()
      .optional(),
    preview: SkillFolderLinkPreviewSchema.optional(),
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
    keyNotRequired: z.boolean(),
    keySource: z.enum(['project', 'file', 'env']).nullable(),
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

export const SkillImportRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    source: z.string().min(1).meta({
      description:
        'External skill source: full skills.sh skill-page URL (https://www.skills.sh/<owner>/<repo>/<skill>, or https://www.skills.sh/site/<hostname>/<skill> for a website catalog), GitHub owner/repo[/subpath], git URL, or local/file path.',
    }),
    skill: z
      .string()
      .min(1)
      .optional()
      .meta({ description: 'Specific skill name to import from a multi-skill source.' }),
    install: z.boolean().optional().meta({
      description:
        'Pass false to import WITHOUT the default-editor auto-projection (the caller installs explicitly afterwards). Default true.',
    }),
    marketplace: z.boolean().optional().meta({
      description:
        'The source came from a skills.sh listing the user chose (the Explore tab), so the install is reported to skills.sh and counts toward that listing. Off by default: a hand-typed repo must not be announced to skills.sh. Honors the `telemetry.skillInstallReports.enabled` setting and DO_NOT_TRACK.',
    }),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillImportRequest = z.infer<typeof SkillImportRequestSchema>;

export const SKILLS_IMPORT_BULK_MAX = 100;

export const SkillsImportBulkRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    source: z.string().min(1).meta({
      description:
        'External skill source: full skills.sh skill-page URL, GitHub owner/repo[/subpath], git URL, or local/file path.',
    }),
    skills: z
      .array(z.string().min(1))
      .min(1)
      .max(SKILLS_IMPORT_BULK_MAX)
      .meta({ description: 'Skill names to import from the source.' }),
    install: z.boolean().optional().meta({
      description: 'Pass false to import WITHOUT the default-editor auto-projection. Default true.',
    }),
    marketplace: z.boolean().optional().meta({
      description:
        'The source came from a skills.sh listing the user chose (a marketplace plugin bundle), so the import is reported to skills.sh as one batched install event and counts toward that listing. Off by default: a hand-typed repo must not be announced to skills.sh. Honors the `telemetry.skillInstallReports.enabled` setting and DO_NOT_TRACK.',
    }),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillsImportBulkRequest = z.infer<typeof SkillsImportBulkRequestSchema>;

export const SkillImportBulkResultSchema = z
  .object({
    requested: z.string(),
    status: z.enum(['imported', 'already-imported', 'not-found', 'failed']),
    name: z.string().optional(),
    collisionRenamedFrom: z.string().optional(),
    warnings: z.array(z.string()),
    error: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillImportBulkResult = z.infer<typeof SkillImportBulkResultSchema>;

export const SkillsImportBulkSuccessSchema = z
  .object({
    results: z.array(SkillImportBulkResultSchema),
    imported: z.number(),
    alreadyImported: z.number(),
    failed: z.number(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillsImportBulkSuccess = z.infer<typeof SkillsImportBulkSuccessSchema>;

export const SkillsReimportBulkRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    names: z
      .array(z.string().min(1))
      .min(1)
      .max(SKILLS_IMPORT_BULK_MAX)
      .meta({ description: 'Managed skill names to refresh from their recorded upstreams.' }),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillsReimportBulkRequest = z.infer<typeof SkillsReimportBulkRequestSchema>;

export const SkillReimportBulkResultSchema = z
  .object({
    requested: z.string(),
    status: z.enum(['updated', 'up-to-date', 'not-found', 'failed']),
    source: z.string().optional(),
    warnings: z.array(z.string()),
    error: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillReimportBulkResult = z.infer<typeof SkillReimportBulkResultSchema>;

export const SkillsReimportBulkSuccessSchema = z
  .object({
    results: z.array(SkillReimportBulkResultSchema),
    updated: z.number(),
    upToDate: z.number(),
    failed: z.number(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillsReimportBulkSuccess = z.infer<typeof SkillsReimportBulkSuccessSchema>;

export const SkillImportProvenanceSchema = z
  .object({
    source: z.string(),
    ref: z.string().optional(),
    contentHash: z.string(),
    publisher: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillImportProvenance = z.infer<typeof SkillImportProvenanceSchema>;

export const SkillImportSuccessSchema = z
  .object({
    name: z.string().min(1).meta({ description: 'Managed skill name created or matched.' }),
    path: z
      .string()
      .min(1)
      .meta({ description: 'Store-relative path to the imported skill source.' }),
    created: z.boolean().meta({ description: 'True when this request created new source files.' }),
    alreadyImported: z.boolean().meta({
      description: 'True when identical content was already present and no files changed.',
    }),
    collisionRenamedFrom: z
      .string()
      .optional()
      .meta({ description: 'Original source name when collision handling renamed the import.' }),
    provenance: SkillImportProvenanceSchema,
    warnings: z
      .array(z.string())
      .meta({ description: 'Non-fatal import warnings, such as skipped unsupported files.' }),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillImportSuccess = z.infer<typeof SkillImportSuccessSchema>;
