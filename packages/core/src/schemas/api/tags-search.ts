/**
 * Cluster I: tags / search / folder-config / template / skill-install-state
 *
 * Ten handlers (counting method-router shims as their own surface):
 * `handleTagsList`, `handleTagsForName`, `handleSearch` (GET+POST inner
 * pair under one shim), `handleFolderConfigGet` / `handleFolderConfigPut`
 * (under `handleFolderConfig`), `handleTemplateGet` / `handleTemplatePut` /
 * `handleTemplateDelete` (under `handleTemplate`), `handleTemplatesList`
 * (project-wide flat enumeration at `/api/templates`),
 * `handleSkillInstallState`.
 * All read-only-or-local-mutating; none mutate per-agent CRDT content
 * (folder-config + template writes are local-user-attributed and protected
 * by the `MUTATING_ROUTES` Origin gate, so they sit in EXEMPT_HANDLERS
 * alongside `handleSeedApply` / `handleInstallSkill`).
 *
 * Two new URN tokens (added to `ProblemTypeSchema` in `_envelope.ts`):
 * `urn:ok:error:tag-index-not-configured` (503) for the rare startup state
 * where the tag index hasn't initialized yet, and
 * `urn:ok:error:template-not-found` (404) for the leaf-to-root walk-exhausted
 * case in `handleTemplateGet`. All other write-error paths reuse the shared
 * `urn:ok:error:invalid-request` URN with a `detail` string carrying the
 * underlying error code from `applyTemplateWrite` / `applyTemplateDelete` /
 * `applyNestedFolderRulesUpsert`.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { MANAGED_ARTIFACT_SCOPES } from '../../constants/cc1.ts';
import { SkillTargetEditorSchema } from '../../skill-targets/schema.ts';
import { agentIdentityFields, summaryField } from './_shared.ts';

/**
 * Single entry in the `tags` array of `GET /api/tags`. Mirrors
 * `TagSummaryEntry` in `tag-index.ts` — `name` is the tag string,
 * `count` is the indexed-doc count, `isLeaf` is `true` iff no other
 * indexed tag begins with `name + '/'`.
 */
export const TagSummaryEntrySchema = z
  .object({
    name: z.string().min(1),
    count: z.number().int().nonnegative(),
    isLeaf: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type TagSummaryEntry = z.infer<typeof TagSummaryEntrySchema>;

/** Success body for `GET /api/tags`. Sorted alphabetically by tag name. */
export const TagsListSuccessSchema = z
  .object({
    tags: z.array(TagSummaryEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type TagsListSuccess = z.infer<typeof TagsListSuccessSchema>;

/**
 * Single doc entry in the `docs` array of `GET /api/tags/:name`. `matchingTags`
 * is the subset of the doc's tags that matched the requested tag (typically
 * one; multi-match arises from prefix overlap). `snippet` is reserved for a
 * future inline-context excerpt — currently always `null`.
 */
export const TagsDocEntrySchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
    matchingTags: z.array(z.string().min(1)),
    snippet: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type TagsDocEntry = z.infer<typeof TagsDocEntrySchema>;

/** Success body for `GET /api/tags/:name`. */
export const TagsForNameSuccessSchema = z
  .object({
    name: z.string().min(1),
    docs: z.array(TagsDocEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type TagsForNameSuccess = z.infer<typeof TagsForNameSuccessSchema>;

/**
 * Success body for `GET /api/folder-config?path=<rel>`. `folder` is the
 * directory-metadata payload returned by `enrichDirectory` from
 * `@inkeep/open-knowledge-server` (typed `unknown`; callers consume it
 * through the in-process `EnrichedDirectory` type). `frontmatter_local` is
 * this folder's own `<folder>/.ok/frontmatter.yml` map (open-shape, like a
 * doc's; when present), or `null` if no local file exists / the YAML is
 * malformed.
 *
 * Folder frontmatter is SELF-ONLY — there is no ancestor cascade — so no
 * per-key `frontmatter_sources` is surfaced. Schema declarations
 * (`.ok/schema.yml`) were removed; templates own new-doc starting values.
 */
export const FolderConfigGetSuccessSchema = z
  .object({
    folder: z.unknown(),
    frontmatter_local: z.record(z.string(), z.unknown()).nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type FolderConfigGetSuccess = z.infer<typeof FolderConfigGetSuccessSchema>;

/**
 * Request body for `PUT /api/folder-config`. `path` is the project-root-
 * relative folder (validated against path-traversal post-schema by the
 * handler's `validateFolderRel` helper). `frontmatter` is the folder's own
 * open-shape frontmatter — any key, exactly like a doc's (`title` /
 * `description` / `tags` are conventional keys the UI surfaces).
 */
export const FolderConfigPutRequestSchema = z
  .object({
    path: z.string(),
    frontmatter: z.record(z.string(), z.unknown()).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type FolderConfigPutRequest = z.infer<typeof FolderConfigPutRequestSchema>;

/**
 * Success body for `PUT /api/folder-config`. `applied` is the raw
 * `applyNestedFolderRulesUpsert` result map (rule path → outcome) — same
 * opaque `unknown`-with-presence-check pattern as the seed schemas, since
 * the in-process structure evolves.
 */
export const FolderConfigPutSuccessSchema = z
  .object({
    applied: z.unknown(),
  })
  .loose() satisfies StandardSchemaV1;
export type FolderConfigPutSuccess = z.infer<typeof FolderConfigPutSuccessSchema>;

/**
 * Frontmatter map embedded in the template payload. Free-form keys; the
 * server applies `pickFrontmatterFields` post-parse rather than gating
 * shapes structurally so future template variables don't require a
 * schema edit.
 */
export const TemplateFrontmatterSchema = z
  .record(z.string(), z.unknown())
  .meta({ description: 'Free-form frontmatter map embedded in template payloads.' });
export type TemplateFrontmatter = z.infer<typeof TemplateFrontmatterSchema>;

/**
 * Single template payload returned by `GET /api/template?name=<n>&folder=<f>`.
 * `scope` is `'local'` when the template was found at the requested folder,
 * `'inherited'` when the leaf-to-root walk picked it up from an ancestor.
 *
 * `.strict()` rejects unknown keys: OK ships as an atomic Electron bundle
 * (UI + backend update together), so internal contracts have no version-skew
 * surface where `.loose()`'s forward-compat machinery would earn its keep.
 * Server-side response emit paths fail-loud if they emit a field not in the
 * schema, catching contributor drift at runtime.
 *
 * Sibling schemas in this directory use `.loose()` (the forward-compat
 * default — see `_envelope.ts` for the per-schema rationale on the
 * envelope/principal/problem-details surface). The templates block diverges
 * intentionally: request `.strict()` is load-bearing for the `target` removal
 * (loud-rejects stale fields), and the 4 response schemas use `.strict()`
 * symmetrically so server-side drift is caught at the same boundary.
 */
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

/** Success body for `GET /api/template?name=<n>&folder=<f>`. */
export const TemplateGetSuccessSchema = z
  .object({
    template: TemplatePayloadSchema,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateGetSuccess = z.infer<typeof TemplateGetSuccessSchema>;

/**
 * Single entry in `TemplatesListSuccessSchema.templates`. Mirrors the
 * in-process `TemplateEntry` shape from `templates-resolver.ts` minus the
 * `scope` field — flat enumeration has no inheritance context, so every
 * entry is implicitly "local" to its `source_folder`. The editor's empty-
 * state surface uses `source_folder` to label and route the create-from-
 * template action.
 */
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

/**
 * Success body for `GET /api/templates`. Project-wide flat enumeration of
 * every `<folder>/.ok/templates/*.md` file. The editor's empty-state
 * surface lists these; `source_folder` is also where the template's
 * resolved new doc will be created.
 */
export const TemplatesListSuccessSchema = z
  .object({
    templates: z.array(TemplatesListEntrySchema),
    /**
     * `true` when the project-scan walker bailed at the directory cap and
     * may have missed templates deeper in BFS order. UI surfaces should
     * indicate the list is incomplete so users know to look at the server
     * log for diagnostic detail.
     */
    truncated: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatesListSuccess = z.infer<typeof TemplatesListSuccessSchema>;

/**
 * Request body for `PUT /api/template`. `name` validated post-schema by the
 * handler's `validateTemplateName` helper (letters / digits / `_` / `-`,
 * no `.md` extension); `folder` validated by `validateFolderRel`. `body`
 * defaults to empty string when omitted; `frontmatter` is free-form.
 *
 * `.strict()` rejects unknown keys → callers passing a stale `target` field
 * receive a 400 RFC 9457 `urn:ok:error:invalid-request` with the
 * `unrecognized_keys` issue surfaced in `detail`.
 */
export const TemplatePutRequestSchema = z
  .object({
    folder: z.string(),
    name: z.string(),
    body: z.string().optional(),
    frontmatter: TemplateFrontmatterSchema.optional(),
    // Identity + summary for attribution (folder timeline). All optional;
    // resolved by `extractActorIdentity` (agent → principal → anonymous).
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatePutRequest = z.infer<typeof TemplatePutRequestSchema>;

/**
 * Success body for `PUT /api/template`. `path` is the contentDir-relative
 * path the template was written to; `created` is `true` when the file did
 * not exist before the write (`false` for in-place updates). `warnings` is
 * the array of non-fatal issues `applyTemplateWrite` surfaced (empty array
 * when there were none).
 */
export const TemplatePutSuccessSchema = z
  .object({
    path: z.string().min(1),
    created: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatePutSuccess = z.infer<typeof TemplatePutSuccessSchema>;

/**
 * Success body for `DELETE /api/template?name=<n>&folder=<f>`. `existed` is
 * `true` when the file was deleted; `false` when the operation was a no-op
 * (template wasn't on disk). `path` is the contentDir-relative path the
 * server attempted to delete.
 */
export const TemplateDeleteSuccessSchema = z
  .object({
    existed: z.boolean(),
    path: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateDeleteSuccess = z.infer<typeof TemplateDeleteSuccessSchema>;

/**
 * Request body for `POST /api/template` — move/rename a template from
 * `<fromFolder>/.ok/templates/<fromName>.md` to `<toFolder>/.ok/templates/<toName>.md`.
 * `fromFolder`/`toFolder` (may be `""` for project root) validated by
 * `validateFolderRel`; `fromName`/`toName` by `validateTemplateName`.
 * `frontmatter`/`body` are optional — when present, the relocated file is
 * rewritten with the new content in the same request (atomic move+edit), so a
 * UI Save that changes the name/folder AND the body is one server operation.
 * `.strict()` rejects unknown keys.
 */
export const TemplateMoveRequestSchema = z
  .object({
    fromFolder: z.string(),
    fromName: z.string(),
    toFolder: z.string(),
    toName: z.string(),
    body: z.string().optional(),
    frontmatter: TemplateFrontmatterSchema.optional(),
    // Identity + summary for attribution (folder timeline).
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateMoveRequest = z.infer<typeof TemplateMoveRequestSchema>;

/**
 * Success body for `POST /api/template` (move/rename). `from`/`to` are the
 * contentDir-relative paths moved between. `committed` is `true` when the
 * relocation was a tracked `git mv` (history-preserving) and `false` when it
 * fell back to a plain rename (the template's `.ok/` dir is untracked /
 * git-excluded, e.g. local-only sharing mode) — surfaced so callers can be
 * honest that history wasn't preserved.
 */
export const TemplateMoveSuccessSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    committed: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateMoveSuccess = z.infer<typeof TemplateMoveSuccessSchema>;

// ─── Skills (`/api/skill`, `/api/skills`) ────────────────────────
//
// Skills mirror the template artifact spine but address by
// `scope` + `name` rather than per-folder: a skill is a directory
// `<root>/.ok/skills/<name>/` where `<root>` is the project (scope: project)
// or the user store (scope: global). There is no folder/leaf-to-root walk —
// skill `name` is the whole identity. Frontmatter is the Agent Skills schema
// verbatim (`name` + `description` only; `.strict()` rejects `version` and any
// OK-injected key at the boundary, enforcing skill-frontmatter purity).

/** Skill scope: `project` (shared via git) or `global` (user store).
 *  Derived from the canonical `MANAGED_ARTIFACT_SCOPES` (cc1.ts) — do not
 *  re-declare the tuple. */
export const SkillScopeSchema = z.enum(MANAGED_ARTIFACT_SCOPES);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

/**
 * Skill name grammar — lowercase ASCII letters, digits, hyphens. The single
 * source for this pattern; the server's write validator and the MCP verb-schema
 * `resolveSkillName` import it instead of each re-declaring the literal.
 */
export const SKILL_NAME_REGEX = /^[a-z0-9-]+$/;

/**
 * Detects an HTML/XML-style tag (`<tag …>` / `</tag>`) in a string. Single
 * source for the "no XML tags" rule applied to skill descriptions (they break
 * the Agent Skills loader) and the projection-time skill-content guard — both
 * server sites import this instead of re-declaring the regex.
 */
const XML_TAG_REGEX = /<\/?[A-Za-z][^>]*>/;
export function containsXmlTag(s: string): boolean {
  return XML_TAG_REGEX.test(s);
}

/**
 * Template filename grammar — ASCII letters, digits, underscores, hyphens (the
 * stable identifier for a `.ok/templates/<name>.md` file). Single source shared
 * by the server's template write validator and the managed-artifact path
 * resolver. Wider than skills (templates allow `_` + uppercase) per
 * `templates-write.ts`.
 */
export const TEMPLATE_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * SKILL.md frontmatter — the Agent Skills schema verbatim. `.strict()` is
 * load-bearing: it rejects a `version` field (skills carry no version) and any
 * OK-injected descriptive key (OK must not pollute skill frontmatter) at the
 * request boundary, before `applySkillWrite`'s deeper validation (length caps,
 * `name`==dir, no XML tags).
 */
export const SkillFrontmatterSchema = z
  .object({
    name: z.string(),
    description: z.string(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/**
 * Single skill payload returned by `GET /api/skill?name=<n>&scope=<s>`.
 * `path` is the store-relative path to the skill's `SKILL.md`. `.strict()`
 * mirrors the template payload's drift-loud contract.
 */
export const SkillPayloadSchema = z
  .object({
    name: z.string().min(1),
    scope: SkillScopeSchema,
    path: z.string().min(1),
    frontmatter: SkillFrontmatterSchema,
    body: z.string(),
    /**
     * Bundled files beside `SKILL.md` (`scripts/`, `reference/`, assets), each
     * with inline `text` when it is a readable, reasonably-sized text file
     * (`null` for binary or oversize). Read-only — a skill is a folder, so its
     * files are browsable + viewable as text (scripts are shown as TEXT, never
     * served as an executable). Sorted by path; excludes `SKILL.md` itself.
     */
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

/** Success body for `GET /api/skill?name=<n>&scope=<s>`. */
export const SkillGetSuccessSchema = z
  .object({
    skill: SkillPayloadSchema,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillGetSuccess = z.infer<typeof SkillGetSuccessSchema>;

/**
 * Single entry in `SkillsListSuccessSchema.skills`. `description` is optional
 * so a malformed on-disk skill (missing/empty frontmatter) still lists rather
 * than failing the whole enumeration — the Skills panel surfaces it as a
 * Draft to fix. `installed` + `hosts` derive from the per-project install marker
 * (`.ok/local/installed-skills.json`): `installed` is `true` when the skill has
 * an install record, `hosts` are the editor ids it was projected into (empty
 * when never installed). They let the panel badge each row Draft vs Installed
 * and name the host dirs without a second round-trip.
 */
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
    // Starter-pack update detection. Present only for
    // `open-knowledge-pack-*` skills: `installedVersion` is the `version`
    // frontmatter of the user's copy (undefined when the copy predates
    // versioning — treated as v0); `bundledVersion` is the version OK currently
    // ships; `updateAvailable` is the server's semver verdict
    // (`bundledVersion > installedVersion`). Absent on non-pack skills, so the
    // panel only badges packs.
    installedVersion: z.string().optional(),
    bundledVersion: z.string().optional(),
    updateAvailable: z.boolean().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillsListEntry = z.infer<typeof SkillsListEntrySchema>;

/** Success body for `GET /api/skills`. Flat enumeration across in-scope stores. */
export const SkillsListSuccessSchema = z
  .object({
    skills: z.array(SkillsListEntrySchema),
    truncated: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillsListSuccess = z.infer<typeof SkillsListSuccessSchema>;

/**
 * Request body for `PUT /api/skill`. `name` is the skill identity (== dir),
 * validated post-schema by the handler. `frontmatter` is REQUIRED (a skill
 * must carry name + description — unlike templates, which may be bare). `scope`
 * defaults to `project`. `.strict()` rejects stale/unknown keys.
 */
export const SkillPutRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    body: z.string().optional(),
    frontmatter: SkillFrontmatterSchema,
    // Identity + summary for attribution (folder timeline). Resolved by
    // `extractActorIdentity` (agent → principal → anonymous).
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillPutRequest = z.infer<typeof SkillPutRequestSchema>;

/** Success body for `PUT /api/skill`. Mirrors `TemplatePutSuccessSchema`. */
export const SkillPutSuccessSchema = z
  .object({
    path: z.string().min(1),
    created: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillPutSuccess = z.infer<typeof SkillPutSuccessSchema>;

/**
 * Request body for `POST /api/skill/update` — refresh an installed starter-pack
 * skill (`open-knowledge-pack-*`) from OK's currently-bundled source. The handler
 * checkpoints the current doc first (reversible), then overwrites it verbatim
 * from the bundle (preserving the bundled `version`). `scope` defaults to
 * `project` (pack skills are project-scope). Identity drives the timeline.
 */
export const SkillUpdateRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillUpdateRequest = z.infer<typeof SkillUpdateRequestSchema>;

/**
 * Success body for `POST /api/skill/update`. `version` is the now-installed
 * (bundled) version; `previousVersion` is what the copy carried before (absent
 * when versionless); `checkpointRef` is the pre-update version-history checkpoint
 * the user can restore to.
 */
export const SkillUpdateSuccessSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    previousVersion: z.string().optional(),
    checkpointRef: z.string().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillUpdateSuccess = z.infer<typeof SkillUpdateSuccessSchema>;

/** Success body for `DELETE /api/skill?name=<n>&scope=<s>`. */
export const SkillDeleteSuccessSchema = z
  .object({
    existed: z.boolean(),
    path: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillDeleteSuccess = z.infer<typeof SkillDeleteSuccessSchema>;

/**
 * Request body for `POST /api/skill` — rename a skill `fromName` → `toName`
 * within one scope. `frontmatter`/`body`, when present, rewrite the relocated
 * `SKILL.md` in the same request (atomic move+edit) so its `name` stays in sync
 * with the new directory. `.strict()` rejects unknown keys.
 */
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

/**
 * Success body for `POST /api/skill` (rename). `committed` is `true` when the
 * relocation was a tracked `git mv` (history-preserving), `false` on the
 * plain-rename fallback (untracked / local-only `.ok/`).
 */
export const SkillMoveSuccessSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    committed: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillMoveSuccess = z.infer<typeof SkillMoveSuccessSchema>;

/** A bundle file is a `reference` (under `references/`) or a `script` (under `scripts/`). */
export const SkillFileKindSchema = z.enum(['reference', 'script']);
export type SkillFileKind = z.infer<typeof SkillFileKindSchema>;

/**
 * Request body for `PUT /api/skill-file` — write ONE bundle file (a
 * `references/**` reference or a `scripts/**` script) into an existing skill.
 * `path` is skill-relative (the server validates the allowlist + containment).
 * Project `.md` references route through the CRDT content-doc path; global
 * `.md` references + all scripts are fs-direct. `.strict()` rejects unknown keys.
 */
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

/** Success body for `PUT /api/skill-file`. `path` is store-relative. */
export const SkillFilePutSuccessSchema = z
  .object({
    path: z.string().min(1),
    created: z.boolean(),
    kind: SkillFileKindSchema,
    /** True when the project `.md` reference was routed through the CRDT content doc. */
    content: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFilePutSuccess = z.infer<typeof SkillFilePutSuccessSchema>;

/** Success body for `GET /api/skill-file?name=&scope=&path=` — one file's bytes. */
export const SkillFileGetSuccessSchema = z
  .object({
    path: z.string().min(1),
    kind: SkillFileKindSchema,
    text: z.string(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFileGetSuccess = z.infer<typeof SkillFileGetSuccessSchema>;

/** Success body for `DELETE /api/skill-file?name=&scope=&path=`. */
export const SkillFileDeleteSuccessSchema = z
  .object({
    path: z.string().min(1),
    existed: z.boolean(),
    kind: SkillFileKindSchema,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFileDeleteSuccess = z.infer<typeof SkillFileDeleteSuccessSchema>;

/**
 * Request body for `POST /api/skill/install` — project a skill's source into
 * editor host dirs. `targets` is an optional explicit editor-id list; when
 * omitted the server projects to the project-configured editors. The
 * source is validated before any host write (pre-install gate). `.strict()`.
 */
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

/**
 * Success body for `POST /api/skill/install`. `hosts` are the editor ids the
 * skill was projected into; `scripts` flags a skill that shipped executable
 * `scripts/`; `warnings` carries non-fatal notes (no targets detected,
 * collision-overwrite, scripts present).
 */
/**
 * Machine-readable codes for the install advisories, parallel to the
 * human-readable `warnings` strings. Clients switch on the CODE
 * (`no-targets` → projected nowhere; `scripts-present` → skill ships executable
 * `scripts/`) instead of substring-matching the English message, which is
 * fragile. `warnings[i]` is the display text for `warningCodes[i]`.
 */
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

/**
 * Request body for `POST /api/skill/uninstall` — remove a skill's editor-host
 * projections + drop its install-marker entry, leaving the SOURCE intact (the
 * skill demotes to Draft). A local-op like install, not an attributed content
 * mutation; no identity fields. `.strict()`.
 */
export const SkillUninstallRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillUninstallRequest = z.infer<typeof SkillUninstallRequestSchema>;

/**
 * Success body for `POST /api/skill/uninstall`. `uninstalled` is `true` when an
 * install record existed and was removed, `false` when the skill wasn't
 * installed (idempotent no-op).
 */
export const SkillUninstallSuccessSchema = z
  .object({
    name: z.string().min(1),
    uninstalled: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillUninstallSuccess = z.infer<typeof SkillUninstallSuccessSchema>;

/**
 * Success body for `GET /api/skill-targets`. `targets` is the effective set
 * OK projects skills into; `configured` is `true` when an explicit committed
 * `.ok/skill-targets.json` set exists, `false` when these were detected from
 * the project's configured editors (the unset fallback). Editor ids reuse the
 * canonical `SkillTargetEditorSchema` (the skill-targets store's source of
 * truth) so the API and the on-disk set can never drift.
 */
export const SkillTargetsGetSuccessSchema = z
  .object({
    targets: z.array(SkillTargetEditorSchema),
    configured: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTargetsGetSuccess = z.infer<typeof SkillTargetsGetSuccessSchema>;

/**
 * Request body for `PUT /api/skill-targets` — set the committed target set.
 * A user/UI action (not agent-attributed), so no identity fields. Changing
 * the set re-projects every managed skill (authored + OK's shipped bundle).
 */
export const SkillTargetsPutRequestSchema = z
  .object({
    targets: z.array(SkillTargetEditorSchema),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTargetsPutRequest = z.infer<typeof SkillTargetsPutRequestSchema>;

/**
 * Success body for `PUT /api/skill-targets`. `reprojected` lists each managed
 * skill and the hosts it now lives in; `bundleHosts` is where OK's shipped
 * `open-knowledge` bundle now lives. `removedFrom` are the editors dropped
 * from the set (reverse-projected away).
 */
export const SkillTargetsPutSuccessSchema = z
  .object({
    targets: z.array(SkillTargetEditorSchema),
    reprojected: z.array(z.object({ name: z.string(), hosts: z.array(z.string()) }).strict()),
    bundleHosts: z.array(z.string()),
    removedFrom: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTargetsPutSuccess = z.infer<typeof SkillTargetsPutSuccessSchema>;

/**
 * Request body for `POST /api/skill/restore` — restore a skill's source to a
 * prior shadow-repo version (fs-direct). `version` is a 40-char commit SHA
 * from the document history (`GET /api/history?docName=.ok/skills/<name>/SKILL`).
 */
export const SkillRestoreRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    // 40-char commit SHA — it flows into `git ls-tree <version>` / `git show
    // <version>:<path>` (argv, not shell, so not injectable), but constrain it
    // to a SHA so an arbitrary rev token (e.g. a leading `-`) never reaches git.
    // Matches the `rollback` handler's `commitSha` precedent.
    version: z.string().regex(/^[0-9a-f]{40}$/i),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillRestoreRequest = z.infer<typeof SkillRestoreRequestSchema>;

/** Success body for `POST /api/skill/restore`. */
export const SkillRestoreSuccessSchema = z
  .object({
    name: z.string().min(1),
    version: z.string(),
    restoredFiles: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillRestoreSuccess = z.infer<typeof SkillRestoreSuccessSchema>;

/**
 * Request body for `POST /api/search`. All fields optional — empty body
 * is valid (treated as `{}` by `withValidation`'s zero-length guard).
 * `query` is the user's search string (capped at 200 chars by the handler
 * post-schema); `intent` selects the ranking heuristic; `scopes` filters
 * the corpus to a subset (`page` / `folder` / `content` / `file`); `limit` caps
 * result count.
 *
 * `semantic` is the opt-in switch for embeddings ranking: omitted/`false` keeps
 * the request purely lexical (the cmd-K omnibar's per-keystroke search stays
 * lexical, instant, and unchanged); `true` opts the request into semantic fusion
 * when the workspace flag is on and an API key is present (the MCP `search` tool
 * sets it by default; the omnibar sets it only on a deliberate "by meaning"
 * submit). Capability-gated server-side — `true` with the feature off is a
 * no-op lexical search.
 *
 * `source` names the caller surface so semantic searches can be counted by
 * origin (omnibar vs MCP tool — different cost/usage profiles) without leaking
 * query text. Bounded enum; absent on the wire defaults to `http` at the handler.
 */
export const SearchRequestSchema = z
  .object({
    query: z.string().optional(),
    intent: z.enum(['autocomplete', 'full_text', 'omnibar']).optional(),
    // Ordering strategy, independent of intent. The omnibar pairs intent
    // `full_text` (content + fuzzy tolerance) with `navigation` ordering.
    ranking: z.enum(['navigation', 'relevance']).optional(),
    scopes: z.array(z.enum(['page', 'folder', 'content', 'file'])).optional(),
    scope: z.string().optional(),
    limit: z.number().int().nonnegative().optional(),
    semantic: z.boolean().optional(),
    source: z.enum(['omnibar', 'mcp', 'http']).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/**
 * Caller surface of a `/api/search` request — the bounded `source` telemetry
 * label. Absent on the wire resolves to `http` at the handler.
 */
export type SearchSource = NonNullable<SearchRequest['source']>;

/**
 * Single result entry in `/api/search` responses. `kind` mirrors the
 * underlying `WorkspaceSearchDocument` discriminator (`page` / `folder` /
 * `file`); `content` is accepted for leniency but never emitted as a result
 * kind. `snippet` is populated only for `kind: 'page'` responses when the
 * query matched body content (name-only `file` entries never carry one).
 */
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

/**
 * Non-content semantic-search status block, present on a `/api/search` response
 * ONLY when the workspace semantic flag is enabled AND the caller opted in
 * (`semantic: true`). It carries no document content — just capability +
 * coverage so an agent knows whether the vector signal contributed and how much
 * of the corpus is embedded yet (the first opt-in search kicks off a background
 * embed, so early coverage is partial). Absent on the lexical / flag-off path,
 * which keeps that response byte-identical to the pre-embeddings contract.
 */
export const SearchSemanticStatusSchema = z
  .object({
    /** Feature flag on AND an API key is present AND the embedder is warm. */
    capable: z.boolean(),
    /** A vector signal contributed to at least one result in this response. */
    applied: z.boolean(),
    /** Documents with cached vectors / total embeddable pages (coverage). */
    coverage: z.object({
      embedded: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchSemanticStatus = z.infer<typeof SearchSemanticStatusSchema>;

/**
 * Success body for `GET /api/semantic-status` — the read-only "is semantic
 * search set up, and how much is indexed" probe for the Settings UI. Distinct
 * from the per-query `SearchSemanticStatusSchema` (no `applied`): it reports the
 * project's standing config + capability + coverage WITHOUT running a search,
 * embedding, or egress. `enabled` is the project-local config flag. `keyPresent`
 * is whether an API key is resolvable (the 0600 secrets file or the env
 * override) — a free, prompt-free read, so the UI can show "no key" instantly on
 * enable rather than waiting for the first search. `keySource` names where the
 * key came from. `ready` is whether the service has warmed yet (false until the
 * first search warms it lazily). `capable` is the post-warm truth — warmed AND
 * the embedder actually loaded with a working key — so `keyPresent && ready &&
 * !capable` is the "key set but the provider rejected it" state, distinct from
 * "no key" (`!keyPresent`).
 */
export const SemanticIndexStatusSchema = z
  .object({
    enabled: z.boolean(),
    keyPresent: z.boolean(),
    keySource: z.enum(['file', 'env']).nullable(),
    /**
     * A redacted tail (the last few characters) of the resolved key, so the UI
     * can show WHICH key is stored without the key ever being returned in full.
     * Null when no key, or when the key is too short to redact safely.
     */
    keyHint: z.string().nullable(),
    ready: z.boolean(),
    capable: z.boolean(),
    embedded: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type SemanticIndexStatus = z.infer<typeof SemanticIndexStatusSchema>;

/**
 * Success body for `GET /api/search?query=<q>` and `POST /api/search` (same
 * wire shape — the GET vs POST split is purely a transport decision).
 * `query` echoes the post-trim/length-clip user input; `intent` echoes
 * the resolved ranking heuristic. `elapsedMs` is informational (helps
 * surface slow-corpus warnings to the operator). `semantic` is present only
 * when the semantic flag is on and the caller opted in (see
 * `SearchSemanticStatusSchema`).
 */
export const SearchSuccessSchema = z
  .object({
    query: z.string(),
    intent: z.enum(['autocomplete', 'full_text', 'omnibar']),
    results: z.array(SearchResultEntrySchema),
    elapsedMs: z.number().nonnegative(),
    semantic: SearchSemanticStatusSchema.optional(),
    // True when the name-only `kind:'file'` tier hit the corpus admission cap
    // (`OK_SEARCH_MAX_ENTRIES`) and the deepest paths were dropped. Markdown
    // content docs are never dropped, so omission/`false` means full coverage.
    truncated: z.boolean().optional(),
    // Cold-start readiness. `false` while the boot index seed is still walking
    // the content dir, in which case `results` is empty and the caller should
    // retry shortly rather than treat the empty result as authoritative. Omitted
    // or `true` means the index is built and these results are complete.
    ready: z.boolean().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchSuccess = z.infer<typeof SearchSuccessSchema>;

/**
 * Single per-target install state entry on
 * `SkillInstallStateSuccessSchema.targets`. Mirrors the in-process
 * `{ version: string; recordedAt: string }` shape from
 * `@inkeep/open-knowledge-server`'s `SkillInstallStateSnapshot.targets`.
 *
 * `version` is the marker-file's recorded version. `recordedAt` is the
 * ISO-8601 timestamp the install marker was written. The full record-value
 * (this object or `null` when the marker is absent) is reflected in
 * `SkillInstallStateSuccessSchema.targets` via `z.union([SchemaShape, null])`.
 */
export const SkillInstallTargetStateSchema = z
  .object({
    version: z.string().min(1),
    recordedAt: z.string().min(1),
  })
  // Deliberately `.loose()`, not `.strict()` like the request schemas in this
  // file: the producer (`writeTargetVersion` in server `skill-state.ts`) also
  // writes a `surface` field that this client-facing contract doesn't surface.
  // Strict would reject that extra key and fail the install-state response.
  .loose() satisfies StandardSchemaV1;
export type SkillInstallTargetState = z.infer<typeof SkillInstallTargetStateSchema>;

/**
 * Success body for `GET /api/skill/install-state`. Loopback + DNS-rebinding
 * gated. `currentVersion` is the bundled skill version that `ok cowork`
 * would write; `targets` carries per-installation-host snapshot state
 * (claude / codex / cursor — keys mirror `SkillStateTarget`). Record values
 * are nullable because `readSkillInstallStateSnapshot` emits `null` for
 * targets whose marker file isn't on disk.
 *
 * `Cache-Control: no-store` on success keeps the dashboard from showing
 * stale state after the user runs `ok cowork` in another window.
 */
export const SkillInstallStateSuccessSchema = z
  .object({
    currentVersion: z.string().min(1),
    targets: z.record(z.string(), SkillInstallTargetStateSchema.nullable()),
  })
  // `.loose()` for the same reason as the target-state schema above: the
  // response envelope tolerates forward-compatible extra keys rather than
  // hard-failing the dashboard's install-state read.
  .loose() satisfies StandardSchemaV1;
export type SkillInstallStateSuccess = z.infer<typeof SkillInstallStateSuccessSchema>;

// `InstallSkillSuccessSchema` and `InstallSkillHandoffErrorSchema` were
// moved to `./sync-seed.ts` to colocate with `InstallSkillRequestSchema`
// (per the codebase convention of pairing request + success schemas in the
// same cluster file).
