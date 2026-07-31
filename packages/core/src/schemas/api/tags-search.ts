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
 * Request body for `POST /api/template/import`. `sourcePath` is the relative
 * path to the source markdown document, `targetFolder` is the folder where the
 * template should be saved, `name` is the optional template name, and `title`
 * is the optional template title. `deleteSource` is optional to support move-instead-of-copy.
 */
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

/**
 * Success body for `POST /api/template/import`.
 */
export const TemplateImportSuccessSchema = z
  .object({
    path: z.string().min(1),
    created: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateImportSuccess = z.infer<typeof TemplateImportSuccessSchema>;

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
    /** True for OpenKnowledge's own built-in `open-knowledge*` skills, served
     *  from the on-disk editor projection (`.claude/skills/...`) READ-ONLY. The
     *  UI labels these "Managed by OpenKnowledge" and disables edit/rename/delete;
     *  the write/rename/delete APIs also refuse them (defense in depth). */
    managed: z.boolean().optional(),
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
 * Import provenance surfaced to the UI — the subset of a `.ok/skills-lock.json`
 * entry the properties panel needs. `source` is the raw import source (GitHub
 * `owner/repo`, a git URL, or a local path), `publisher` the derived owner,
 * `ref` the resolved commit sha, `importedAt` an ISO timestamp.
 */
export const SkillOriginSchema = z
  .object({
    source: z.string().min(1),
    publisher: z.string().optional(),
    /** Upstream skill slug in a multi-skill source (skills.sh page URLs). */
    skill: z.string().optional(),
    /** Public repository for a plugin-cache source, resolved from the harness
     * marketplace registry. The raw `source` remains the import identity. */
    marketplaceUrl: z.string().optional(),
    importedAt: z.string().min(1),
    /** Explicit per-skill auto-update choice. When absent, local filesystem
     *  sources default on and remote sources default off. */
    autoUpdate: z.boolean().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;

/**
 * Single entry in `SkillsListSuccessSchema.skills`. `description` is optional
 * so a malformed on-disk skill (missing/empty frontmatter) still lists rather
 * than failing the whole enumeration — the Skills panel surfaces it as a
 * so it can be fixed. `installed` + `hosts` derive from the per-project install marker
 * (`.ok/local/installed-skills.json`): `installed` is `true` when the skill has
 * an install record, `hosts` are the editor ids it was projected into (empty
 * when never installed). They let the panel show where each row is installed
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
    /** Hosts whose occurrence is a SYMLINK (in-place skills; user links are
     *  preserved and disclosed rather than presented as plain copies). */
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
    /** Editor ids the install menu may OFFER for this skill's scope on THIS
     *  machine. Project scope: every editor with a project skill root (all
     *  creatable). Global scope: only editors whose user-home skill dir actually
     *  exists (`detectUserSkillHosts`) — so we don't offer an install that
     *  silently no-ops (e.g. Copilot with no `~/.copilot`), which flashed a
     * checkmark then reverted. Absent → the menu offers all. */
    installableEditors: z.array(z.string()).optional(),
    /** Per-skill install-mode preference: editor fan-out uses symlinks to the
     *  canonical instead of copies. Machine-local. */
    linkMode: z.boolean().optional(),
    /** Custom placements (project-relative bundle dirs) recorded by the
     *  install menu's custom-path action — machine-local, `.ok/local/`. */
    customPlacements: z
      .array(z.object({ path: z.string(), mode: z.enum(['copy', 'link']) }).strict())
      .optional(),
    /** True for OpenKnowledge's own built-in `open-knowledge*` skills (the ones
     *  projected into editor host dirs, e.g. `.claude/skills/open-knowledge`).
     *  They are READ-ONLY: surfaced so users can see what their agents load, but
     *  edit/rename/delete/install are disabled in the UI and refused by the API. */
    managed: z.boolean().optional(),
    // Import provenance from `.ok/skills-lock.json` (project skills only). Present
    // when the skill was brought in via import; drives the "Imported from …"
    // properties row + the "Update from source" action. Absent for authored
    // skills and all global-scope skills (the global store is unversioned).
    origin: SkillOriginSchema.optional(),
    // True when the skill's current on-disk content diverges from what was
    // installed (the write-time `localHash` baseline in the lockfile). Drives the
    // "Modified" indicator. Only set for imported project skills whose lock entry
    // carries a baseline; omitted (clean) otherwise.
    modified: z.boolean().optional(),
    // True when the lock entry carries a shadow-repo `baselineRef` — the installed
    // bytes Revert restores from. Gates the Revert button so it never shows-and-
    // fails: a `modified` skill in a non-git project has a `localHash` (Modified
    // shows) but no `baselineRef` (nothing to revert to), so Revert stays hidden.
    revertable: z.boolean().optional(),
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
    name: z.string().meta({ description: 'Managed skill name to create or update.' }),
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
 * Request body for `POST /api/skill/reimport` — refresh an IMPORTED skill from
 * its recorded upstream (`.ok/skills-lock.json`). Unlike a pack seed
 * (bundled starter packs), the source is re-fetched from the network. `scope`
 * defaults to `project` (only project skills carry a lockfile).
 */
export const SkillReimportRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    // Preview only — fetch upstream and report the diff WITHOUT writing. Drives
    // the "Update overwrites your local edits" confirm dialog: the client shows
    // `localBody` vs `upstreamBody`, then re-POSTs without `dryRun` to apply.
    dryRun: z.boolean().optional(),
    // Toggle-persist mode: when present, ONLY flips the lockfile entry's
    // `autoUpdate` flag and returns (no upstream fetch, nothing rewritten).
    // Rides this route so the toggle needs no new endpoint.
    setAutoUpdate: z.boolean().optional(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillReimportRequest = z.infer<typeof SkillReimportRequestSchema>;

/**
 * Success body for `POST /api/skill/reimport`. `updated` is false when the
 * upstream content hash matched the recorded one (already up to date — nothing
 * written). On a `dryRun`, nothing is written and `localBody`/`upstreamBody`
 * carry the two SKILL.md bodies for the confirm dialog's diff.
 */
export const SkillReimportSuccessSchema = z
  .object({
    name: z.string().min(1),
    updated: z.boolean(),
    source: z.string().min(1),
    /** Present only on a `dryRun`: the skill's current on-disk SKILL.md body. */
    localBody: z.string().optional(),
    /** Present only on a `dryRun`: the fetched upstream SKILL.md body. */
    upstreamBody: z.string().optional(),
    /** Present on a `dryRun` for PROJECT skills: the bundle dir has tracked
     *  files in the project git index. Auto-update refuses git-tracked skills
     *  (two machines auto-updating + autoSync = lockfile/bundle churn war);
     *  updates flow through the repo (pull / CI) or the manual Update button. */
    gitTracked: z.boolean().optional(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillReimportSuccess = z.infer<typeof SkillReimportSuccessSchema>;

/**
 * Request body for `POST /api/skill/revert` — discard local edits and restore an
 * imported skill to the exact bytes recorded when it was installed/last updated
 * (the shadow-repo `baselineRef` in `.ok/skills-lock.json`). Project scope only.
 */
export const SkillRevertRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z.string(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillRevertRequest = z.infer<typeof SkillRevertRequestSchema>;

/** Success body for `POST /api/skill/revert`. `restoredFiles` are skill-dir
 *  relative; `baselineRef` is the shadow commit the skill was restored to. */
export const SkillRevertSuccessSchema = z
  .object({
    name: z.string().min(1),
    baselineRef: z.string().min(1),
    restoredFiles: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillRevertSuccess = z.infer<typeof SkillRevertSuccessSchema>;

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

/**
 * Request body for `POST /api/skill/move-scope` — relocate a skill across
 * scopes (project ↔ global), preserving its name. Unlike the within-scope
 * rename (`POST /api/skill`), this is server-side atomic: the whole bundle dir
 * is copied verbatim (binaries included), the source is deleted, and install
 * projections are transferred — in ONE request. The old client-orchestrated
 * copy+delete dance raced the live-doc bridge and could double a skill's
 * content on a round-trip. `.strict()` rejects unknown keys.
 */
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

/** Success body for `POST /api/skill/move-scope`. `scope` is the destination. */
export const SkillMoveScopeSuccessSchema = z
  .object({
    scope: SkillScopeSchema,
    /** Destination bundle dir, base-relative (the target scope's default
     *  skill home) — the moved skill's real location. */
    path: z.string().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillMoveScopeSuccess = z.infer<typeof SkillMoveScopeSuccessSchema>;

/** Request body for `POST /api/skill/duplicate`. The server copies the complete
 * bundle within one scope, including binary files, and rewrites only the
 * duplicate's skill identity. */
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

/** Success body for `POST /api/skill/duplicate`. */
export const SkillDuplicateSuccessSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillDuplicateSuccess = z.infer<typeof SkillDuplicateSuccessSchema>;

/**
 * Request body for `POST /api/skill/edit-external` — register a detected
 * (unmanaged) skill for in-place editing. `home` is the skill's own enumerated
 * dir (`CatalogSkill.home`, e.g. `~/.claude/skills/<name>`); the server
 * realpath-resolves it, verifies it holds a `SKILL.md`, and registers it so the
 * `__extskill__/<name>` doc's continuous autosave-out writes back to the real
 * file (containment-guarded). No copy, no symlink, no `.ok/` scaffolding.
 * `.strict()` rejects unknown keys.
 */
export const SkillEditExternalRequestSchema = z
  .object({
    name: z.string(),
    home: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillEditExternalRequest = z.infer<typeof SkillEditExternalRequestSchema>;

/** Success body for `POST /api/skill/edit-external` — the synthetic editable
 *  doc name the client opens as a normal editor tab. */
export const SkillEditExternalSuccessSchema = z
  .object({
    docName: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillEditExternalSuccess = z.infer<typeof SkillEditExternalSuccessSchema>;

/** A bundle file is a `reference` (under `references/`), a `script` (under
 *  `scripts/`), or a plain `file` anywhere else in the bundle (root files,
 *  custom dirs — always fs-direct, `SKILL.md` excluded). */
export const SkillFileKindSchema = z.enum(['reference', 'script', 'file']);
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

/**
 * Request body for `POST /api/skill-file/rename` — rename/move ONE bundle file
 * inside a skill (never `SKILL.md`, never an overwrite, never an escape — the
 * server runs the same allowlist + containment gate as write/delete on BOTH
 * paths). A project `.md` reference is a live CRDT content doc, so the server
 * also moves the doc identity (close old, reindex under the new name) and the
 * client retargets any open tab.
 */
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

/** Success body for `POST /api/skill-file/rename`. */
export const SkillFileRenameSuccessSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    /** Present for a project `.md` reference: the old + new live doc names the
     *  client should retarget an open tab across. */
    fromDocName: z.string().optional(),
    toDocName: z.string().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillFileRenameSuccess = z.infer<typeof SkillFileRenameSuccessSchema>;

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
 * omitted the server projects to the project-configured editors; when explicitly
 * `[]`, install is set-exact to no editors, so it uninstalls everywhere while
 * leaving the source skill in place. The source is validated before any host
 * write (pre-install gate). `.strict()`.
 */
/** An editor host id or the vendor-neutral `.agents/skills` hub — the
 *  non-path skill location ids. */
export const SkillHostIdArgSchema = z.union([SkillTargetEditorSchema, z.literal('agents')]);
export type SkillHostIdArg = z.infer<typeof SkillHostIdArgSchema>;

/** A base-relative custom skills-root path (e.g. `.tim/skills`). Never
 *  absolute, never `~`, never escaping — and ALWAYS containing `/`, which is
 *  what distinguishes it from a host id, so `SkillLocationIdSchema` below is
 *  unambiguous. The same grammar guards folder verbs and custom placements. */
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

/** ONE location vocabulary for everywhere a skill can live or be fanned to:
 *  `claude` | `cursor` | `codex` | `copilot` | `opencode` | `pi` | `agents`
 *  | a base-relative custom root path (`.tim/skills`). Host ids never contain
 *  `/`; custom roots always do. */
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
    /** ADDITIVE: locations to add the skill to — everything else untouched.
     *  Editor ids fan out a managed copy/symlink; a custom root path records
     *  a placement there (the old `place` one-shot, unified). */
    add: z.array(SkillLocationIdSchema).optional().meta({
      description:
        'Locations to ADD the skill to (everything else untouched). Editor ids fan out a managed copy/symlink; a custom root path (".tim/skills") places the bundle there.',
    }),
    /** ADDITIVE: locations to remove the skill from. Lossless only — a
     *  hand-edited fork is refused, never deleted; removing the SOURCE is a
     *  400 (move it first via `source`). */
    remove: z.array(SkillLocationIdSchema).optional().meta({
      description:
        'Locations to REMOVE the skill from (lossless only — a hand-edited fork is refused, never deleted). The source cannot be removed; move it first with `source`.',
    }),
    /** The form THIS call installs, the `linkMode` boolean respelled for
     *  location callers: `link` = one real folder (the source) + symlinks
     *  everywhere else; `copy` = independent folders auto-refreshed until
     *  hand-edited. Not persisted — omit it and the form is derived from the
     *  ones the skill already uses. */
    mode: z.enum(['copy', 'link']).optional().meta({
      description:
        '"link": one real folder (the source); every other location becomes a symlink to it. "copy": independent real folders, refreshed from the source until hand-edited (a hand-edit forks that copy). Converts existing locations losslessly. Omit to follow the form the skill already uses.',
    }),
    /** One-shot SOURCE move respelled for location callers (≡ `setSource`):
     *  relocate the skill's real folder; the old source becomes a symlink. */
    source: SkillLocationIdSchema.optional().meta({
      description:
        "Move the skill's REAL folder to this location (the old source becomes a symlink to it — never a removal). Sticky across rescans.",
    }),
    /** One-shot CUSTOM placement (project scope): put a copy or symlink of the
     *  skill bundle under an arbitrary project-relative dir. Mutually exclusive
     *  with `targets` semantics — when present, ONLY the placement runs. */
    /** The form THIS call installs, as a boolean: `true` = editor fan-out
     *  symlinks to the canonical, `false` = copies. Omitted = derive from the
     *  forms the skill's existing locations use. `mode` is the same knob
     *  spelled for location callers. */
    linkMode: z.boolean().optional(),
    /** One-shot SOURCE move (in-place skills): make this location the skill's
     *  real folder. An editor id, "agents", or a project-relative custom
     *  skills-root path (e.g. ".ok/skills") holding a placement. Sticky. */
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
    /** One-shot PER-LOCATION mode change: convert ONE installed location
     *  between an independent copy and a symlink to the source, leaving every
     *  sibling location alone. `mode` converts every location at once; this
     *  converts one row. Lossless-only — a hand-edited copy is refused, never
     *  overwritten. */
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
    /** One-shot REMOVAL of a recorded custom placement (the inverse of `place`).
     *  Lossless-only: a hand-edited copy is refused, never deleted. */
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
    /**
     * Fork resolution (same name, DIFFERENT bytes, in an editor dir that lost
     * the canonical election). Exactly one action:
     *  - `align`: the fork loses — its dir is stashed out-of-tree, then the
     *    canonical re-projects there (they re-merge as one skill).
     *  - `make-source`: the fork wins — the old canonical (stashed) + its
     *    copies are removed and re-projected from the fork's dir, which
     *    becomes the source.
     *  - `rename`: keep BOTH — the fork's dir moves to `toName` (frontmatter
     *    name rewritten in lock-step) and becomes an independent skill.
     */
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
  // The handler is a first-match-wins chain of early returns, so a request
  // naming two operations silently performs one and drops the other with a 200
  // and an unchanged-looking `hosts`. Make the combination unrepresentable
  // rather than relying on callers to know the precedence order.
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
export const SKILL_INSTALL_WARNING_CODES = [
  'no-targets',
  'scripts-present',
  'name-conflict',
  // The skill installed but has an empty `description` — a soft nudge, never a
  // block. Clients surface it as an advisory, not a failure.
  'no-description',
  // A fork rename moved the folder but could not rewrite the `name` in its
  // SKILL.md, so the skill is left declaring its old name. The rename is not
  // rolled back — the caller is told to fix the frontmatter.
  'skill-fork-name-unpatched',
  // A bulk `add`/`remove` named a location that is not a placeable root at all
  // (outside the project, inside `.ok/` internals, or the source itself). The
  // single-shot `place` verb returns 400 for the same condition.
  'place-path-invalid',
  // A bulk `remove` found a hand-edited copy at the location. It is refused,
  // never deleted — the single-shot `unplace` verb returns 409 for this.
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
    /** Project-relative bundle dir a custom `place` landed at. */
    placedAt: z.string().optional(),
    /** Set when unchecking the SOURCE relocated it — the new source bundle dir. */
    sourceMovedTo: z.string().optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillInstallSuccess = z.infer<typeof SkillInstallSuccessSchema>;

/**
 * Request body for `POST /api/skill/uninstall` — remove a skill's editor-host
 * projections + drop its install-marker entry, leaving the SOURCE intact (the
 * skill still loads from its own folder). A local-op like install, not an attributed content
 * mutation; no identity fields. `.strict()`.
 */
export const SkillUninstallRequestSchema = z
  .object({
    scope: SkillScopeSchema.default('project'),
    name: z
      .string()
      .meta({ description: 'Managed skill name to uninstall without deleting source.' }),
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
    name: z.string().min(1).meta({ description: 'Managed skill name requested for uninstall.' }),
    uninstalled: z.boolean().meta({
      description:
        'True when an install marker existed and was removed; false for an idempotent no-op.',
    }),
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
    /** Folder-level state per host skills root, BOTH scopes (locked
     *  locations-menu design, slice 2): `own` = a real folder, `linked` = the
     *  folder is a symlink to `target`, `linked-parent` = a parent dir is the
     *  symlink (report-only; unlink the parent by hand), `absent` = no folder. */
    folders: z
      .array(
        z
          .object({
            scope: SkillScopeSchema,
            host: z.string(),
            root: z.string(),
            state: z.enum(['own', 'linked', 'linked-parent', 'absent']),
            target: z.string().optional(),
            /** Passive drift: OK's folder-link receipt disagrees with disk
             *  (something outside OK rewrote the folder since OK set it). */
            drift: z.literal(true).optional(),
            /** The recorded expected form, for the chip tooltip
             *  (`link → <target>` | `own folder`). */
            expected: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict() satisfies StandardSchemaV1;
export type SkillTargetsGetSuccess = z.infer<typeof SkillTargetsGetSuccessSchema>;

/**
 * Folder-level verbs over a host skills folder (the Settings → Folders
 * surface, and the MCP `config` tool's `skillFolders` arg). One action per
 * request:
 * - `link`  — merge the folder into an explicitly chosen `target` root and
 *   replace it with a symlink (merge-then-swap; same-hash entries drop,
 *   conflicts abort, an interrupted merge is resumable by re-running).
 *   No target is ever assumed — it is a required caller pick.
 * - `unlink` — turn a linked folder back into a real directory holding one
 *   per-skill symlink per skill it currently sees (lossless, reversible).
 * - `add-root` — declare a NEW custom skills root; it becomes a folder row
 *   and a link/install target from declaration (no first placement needed).
 */
export const SkillFolderActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('link'),
      scope: SkillScopeSchema,
      root: z.string().min(1).meta({ description: 'The folder to link (e.g. ".codex/skills").' }),
      target: z
        .string()
        .min(1)
        .meta({ description: 'The root it merges into (e.g. ".agents/skills"). Required.' }),
    })
    .strict(),
  z
    .object({
      action: z.literal('unlink'),
      scope: SkillScopeSchema,
      root: z.string().min(1).meta({ description: 'The linked folder to materialize back.' }),
      /** Skill names to leave out of the materialized links — "stop this
       *  agent reading that skill": the folder keeps everything else it sees
       *  today but stops following the target root. */
      exclude: z.array(z.string().min(1)).optional().meta({
        description:
          'Skill names to LEAVE OUT when materializing — the folder keeps every other skill it currently sees (as per-skill links) and stops auto-following the target root.',
      }),
    })
    .strict(),
  z
    .object({
      action: z.literal('add-root'),
      scope: SkillScopeSchema,
      root: SkillRootPathSchema.meta({
        description: 'New custom skills root to declare (base-relative, e.g. ".team/skills").',
      }),
    })
    .strict(),
]);
export type SkillFolderAction = z.infer<typeof SkillFolderActionSchema>;

/**
 * Request body for `PUT /api/skill-targets` — set the committed target set.
 * A user/UI action (not agent-attributed), so no identity fields. Changing
 * the set re-projects every managed skill (authored + OK's shipped bundle).
 */
export const SkillTargetsPutRequestSchema = z
  .object({
    folderAction: SkillFolderActionSchema,
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
    /** Folder-verb outcome (present when the request carried `folderAction`). */
    folder: z
      .object({
        moved: z.array(z.string()),
        dropped: z.array(z.string()),
        linked: z.array(z.string()),
      })
      .strict()
      .optional(),
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
    /**
     * True when the configured endpoint is loopback (localhost) and so needs no
     * key — the UI shows "not required" instead of nagging for one. Only
     * meaningful when `!keyPresent`.
     */
    keyNotRequired: z.boolean(),
    keySource: z.enum(['project', 'file', 'env']).nullable(),
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

/**
 * Request body for `POST /api/skill/import` — acquire a skill as versioned
 * content from `source` (a remote/local spec: skills.sh URL,
 * `owner/repo[/subpath]`, git URL, or local/`file://` path). `skill`
 * cherry-picks one skill from a multi-skill source. `.strict()`.
 */
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
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillImportRequest = z.infer<typeof SkillImportRequestSchema>;

/**
 * Ceiling on one bulk-import call. Sized well above the largest plugin repos
 * seen in the wild (~40 skills) and far below anything that would hold a request
 * open for minutes — the cap is what keeps "install the whole plugin" bounded.
 */
export const SKILLS_IMPORT_BULK_MAX = 100;

/**
 * Request body for `POST /api/skills/import-bulk` — acquire SEVERAL skills from
 * one `source` in a SINGLE shallow clone (the plugin-repo case: one repo
 * bundling dozens of skills, where one request per skill re-clones the same
 * repo every time). `skills` names them exactly, matched the same way the
 * single import matches `skill` (dir basename or SKILL.md frontmatter `name`).
 * There is deliberately no "import everything" flag: the caller picks, so
 * nobody lands 40 unreviewed skills from one click. `.strict()`.
 */
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
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type SkillsImportBulkRequest = z.infer<typeof SkillsImportBulkRequestSchema>;

/**
 * One row of a bulk import. `status` is per-skill so a bundle that trips the
 * size limits, or a name that isn't in the source, never fails the rest of the
 * selection: `imported` wrote files, `already-imported` matched an identical
 * bundle already present, `not-found` wasn't in the source, `failed` carries the
 * reason in `error`.
 */
export const SkillImportBulkResultSchema = z
  .object({
    requested: z.string(),
    status: z.enum(['imported', 'already-imported', 'not-found', 'failed']),
    /** On-disk name — differs from `requested` on a collision rename. */
    name: z.string().optional(),
    collisionRenamedFrom: z.string().optional(),
    warnings: z.array(z.string()),
    error: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillImportBulkResult = z.infer<typeof SkillImportBulkResultSchema>;

/** Success body for `POST /api/skills/import-bulk`. Always 200: the per-skill
 *  outcomes ride `results`, and the counts are what the caller reports. */
export const SkillsImportBulkSuccessSchema = z
  .object({
    results: z.array(SkillImportBulkResultSchema),
    imported: z.number(),
    alreadyImported: z.number(),
    failed: z.number(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillsImportBulkSuccess = z.infer<typeof SkillsImportBulkSuccessSchema>;

/** Provenance recorded for an imported skill (mirrors the lockfile entry). */
export const SkillImportProvenanceSchema = z
  .object({
    source: z.string(),
    ref: z.string().optional(),
    contentHash: z.string(),
    publisher: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillImportProvenance = z.infer<typeof SkillImportProvenanceSchema>;

/**
 * Success body for `POST /api/skill/import`. `name` is the on-disk skill name
 * (may differ from the source name when a collision forced an `-imported`
 * suffix — then `collisionRenamedFrom` carries the original). `path` is
 * store-relative. `alreadyImported` is true when an identical bundle (same
 * `contentHash`) was already present and the import was a no-op.
 */
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
