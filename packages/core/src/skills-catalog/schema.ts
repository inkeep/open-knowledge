import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { MANAGED_ARTIFACT_SCOPES } from '../constants/cc1.ts';

export const OK_PACK_SCHEMA_VERSION = 1;

export const SkillManifestSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  files: z.looseObject({
    skillMd: z.string(),
    scripts: z.array(z.string()),
    references: z.array(z.string()),
  }),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const SkillProvenanceSchema = z.looseObject({
  pluginProvider: z.string().optional(),
  plugin: z.string().optional(),
  marketplace: z.string().optional(),
  repositoryUrl: z.string().optional(),
  version: z.string().optional(),
  gitCommitSha: z.string().optional(),
  scope: z.string().optional(),
  projectPath: z.string().optional(),
});
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;

export const SkillInertSchema = z.looseObject({
  commands: z.boolean(),
  hooks: z.boolean(),
  mcp: z.boolean(),
});
export type SkillInert = z.infer<typeof SkillInertSchema>;

export const CatalogSkillSchema = z.looseObject({
  ...SkillManifestSchema.shape,
  sourceHarness: z.string(),
  sourceHarnesses: z.array(z.string()),
  home: z.string(),
  provenance: SkillProvenanceSchema,
  inert: SkillInertSchema,
  outsideProject: z.boolean().optional(),
});
export type CatalogSkill = z.infer<typeof CatalogSkillSchema>;

export const OkPackSchema = z.looseObject({
  schema: z.literal(OK_PACK_SCHEMA_VERSION),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  author: z.looseObject({ name: z.string() }).optional(),
  skills: z.array(z.string()),
  hostCompatibility: z.array(z.string()).optional(),
  capabilities: z
    .looseObject({ scripts: z.string(), network: z.string(), inert: z.array(z.string()) })
    .optional(),
  provenance: z
    .looseObject({ source: z.string(), ref: z.string(), contentHash: z.string() })
    .optional(),
});
export type OkPack = z.infer<typeof OkPackSchema>;

export const SkillsInstalledSuccessSchema = z
  .object({
    skills: z.array(CatalogSkillSchema),
    packs: z.array(OkPackSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillsInstalledSuccess = z.infer<typeof SkillsInstalledSuccessSchema>;

export const SkillSearchResultSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    source: z.string().min(1),
    description: z.string(),
    installs: z.number().int().nonnegative().nullable(),
    publisher: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillSearchResult = z.infer<typeof SkillSearchResultSchema>;

export const SkillsSearchSuccessSchema = z
  .object({
    results: z.array(SkillSearchResultSchema),
    backend: z.enum(['skills.sh', 'github-fallback']),
    degraded: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillsSearchSuccess = z.infer<typeof SkillsSearchSuccessSchema>;

export const SkillDetailSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    image: z.string().nullable(),
    skillsUrl: z.string().nullable(),
    sourceKind: z.enum(['github', 'site']),
    sourceUrl: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

const DiscoveredSkillSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;

export const SkillDiscoverSchema = z
  .object({ skills: z.array(DiscoveredSkillSchema) })
  .loose() satisfies StandardSchemaV1;
export type SkillDiscover = z.infer<typeof SkillDiscoverSchema>;

export const SkillRefResolutionSchema = z
  .object({
    kind: z.enum(['local', 'import', 'none']),
    scope: z.enum(MANAGED_ARTIFACT_SCOPES).optional(),
    name: z.string().optional(),
    dir: z.string().optional(),
    source: z.string().optional(),
    ref: z.string().optional(),
    via: z.enum(['source', 'publisher']).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillRefResolution = z.infer<typeof SkillRefResolutionSchema>;

const SkillPreviewFileSchema = z
  .object({
    relPath: z.string(),
    content: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;

export const PluginSourceMetadataSchema = z
  .object({
    provider: z.string(),
    plugin: z.string(),
    version: z.string().optional(),
    marketplace: z.string().optional(),
    repositoryUrl: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type PluginSourceMetadata = z.infer<typeof PluginSourceMetadataSchema>;

export const PluginBundleMetadataSchema = z
  .object({
    provider: z.string(),
    plugin: z.string(),
    version: z.string().optional(),
    description: z.string().optional(),
    repositoryUrl: z.string().optional(),
    bundledSkills: z.array(z.string()),
    capabilities: z.object({
      commands: z.boolean(),
      hooks: z.boolean(),
      mcp: z.boolean(),
      agents: z.boolean(),
    }),
    setupSupported: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type PluginBundleMetadata = z.infer<typeof PluginBundleMetadataSchema>;

export const SkillPreviewSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    skillMd: z.string(),
    files: z.array(SkillPreviewFileSchema),
    plugin: PluginSourceMetadataSchema.optional(),
    pluginBundle: PluginBundleMetadataSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillPreview = z.infer<typeof SkillPreviewSchema>;
