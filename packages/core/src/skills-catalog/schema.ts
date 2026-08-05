/**
 * The shared skill/Pack model — the vocabulary every marketplace slice
 * (enumerate, import, project, publish) speaks.
 *
 * Three types:
 *  - `SkillManifest` — the OPEN agentskills.io skill-dir unit (a `SKILL.md`
 *    with `name`+`description`, optional `scripts/`/`references/`). The
 *    cross-agent interop currency `skills.sh` + 51 agents already speak.
 *  - `CatalogSkill` — one installed instance, normalized across harnesses.
 *    The cross-harness enumerator produces these. After cross-harness de-dupe
 *    a single logical skill carries `sourceHarnesses[]` (every harness it was
 *    found in); `sourceHarness` is the primary (first, sorted) for the §3
 *    single-source contract.
 *  - `OkPack` — OK's bundling ENVELOPE over ≥1 skill-dir. NOT a new wire
 *    format — it wraps the open standard, adding name/version/host-compat.
 *
 * `looseObject` everywhere for forward-compat: a future field passes through
 * older readers untouched, matching the sibling `installed-skills/schema.ts`.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { MANAGED_ARTIFACT_SCOPES } from '../constants/cc1.ts';

/** Current `ok-pack.json` envelope schema version. */
export const OK_PACK_SCHEMA_VERSION = 1;

/**
 * The open agentskills.io skill-dir unit. `files` lists bundle contents by
 * role; paths are absolute. OK never executes `scripts` — they are surfaced,
 * never run (the trust contract).
 */
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

/**
 * Provenance the harness records. Rich for Claude plugins (version, commit,
 * marketplace, scope); empty for bare skill-dirs that carry none. `scope` is
 * the harness's RAW scope string (e.g. Claude's `project`/`user`), NOT coerced
 * into OK's `project`/`global` enum. `projectPath` is the project a `project`-
 * scoped install is bound to — load-bearing for project-locality: it's how the
 * catalog tells a plugin installed for THIS project from one installed for
 * another (see `isDetectedSkillInProject` in `./scope.ts`).
 */
export const SkillProvenanceSchema = z.looseObject({
  pluginProvider: z.string().optional(),
  plugin: z.string().optional(),
  marketplace: z.string().optional(),
  version: z.string().optional(),
  gitCommitSha: z.string().optional(),
  scope: z.string().optional(),
  projectPath: z.string().optional(),
});
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;

/**
 * Capability presence-flags (OF: surfaced, not mapped). Whether the source
 * bundle ships `commands/`, `hooks/`, or an `.mcp.json` — boolean only; the
 * deeper transfer mapping is a later slice.
 */
export const SkillInertSchema = z.looseObject({
  commands: z.boolean(),
  hooks: z.boolean(),
  mcp: z.boolean(),
});
export type SkillInert = z.infer<typeof SkillInertSchema>;

/** One installed skill, normalized across harnesses. */
export const CatalogSkillSchema = z.looseObject({
  ...SkillManifestSchema.shape,
  sourceHarness: z.string(),
  /** Every harness this skill was found in (de-dupe collapses across homes). */
  sourceHarnesses: z.array(z.string()),
  home: z.string(),
  provenance: SkillProvenanceSchema,
  inert: SkillInertSchema,
  /**
   * True when `home` sits outside the OPEN project. Enumeration resolves a
   * linked worktree to its parent checkout, so a parent's skills are listed
   * here even though no file of theirs exists in the open tree. Only the server
   * can decide this — it alone holds `contentDir` beside the resolved identity
   * — so it is stamped there rather than derived by a client.
   */
  outsideProject: z.boolean().optional(),
});
export type CatalogSkill = z.infer<typeof CatalogSkillSchema>;

/**
 * The OK Pack envelope. Minimal v1: enough for a multi-skill plugin (the `eng`
 * plugin bundles ~12 skills) to round-trip as one bundle and for import/publish
 * to share the contract. `capabilities`/`provenance` are optional and left
 * unpopulated by the read-only enumerator (no `contentHash` is fabricated).
 */
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

/**
 * Success body for `GET /api/skills/installed`. `.loose()` + StandardSchema
 * conformance to match the `schemas/api/*` cluster convention.
 */
export const SkillsInstalledSuccessSchema = z
  .object({
    skills: z.array(CatalogSkillSchema),
    packs: z.array(OkPackSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillsInstalledSuccess = z.infer<typeof SkillsInstalledSuccessSchema>;

/** One discovery result (skills.sh or the GitHub-topic fallback). */
export const SkillSearchResultSchema = z
  .object({
    // Stable `{source}/{slug}` id from skills.sh, or `owner/repo` for a GitHub hit.
    id: z.string().min(1),
    name: z.string().min(1),
    // skills.sh source identifier: GitHub `owner/repo` coordinates or a website hostname.
    source: z.string().min(1),
    description: z.string(),
    // Install count (skills.sh ranking signal); null in the degraded GitHub fallback.
    installs: z.number().int().nonnegative().nullable(),
    publisher: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillSearchResult = z.infer<typeof SkillSearchResultSchema>;

/**
 * Success body for `GET /api/skills/search`. `backend` names which discovery
 * source answered; `degraded` is true when the keyless skills.sh endpoint was
 * unavailable and the GitHub-topic fallback answered (no install-count ranking).
 */
export const SkillsSearchSuccessSchema = z
  .object({
    results: z.array(SkillSearchResultSchema),
    backend: z.enum(['skills.sh', 'github-fallback']),
    degraded: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillsSearchSuccess = z.infer<typeof SkillsSearchSuccessSchema>;

/**
 * Success body for `GET /api/skills/detail`. Enriches one discovery result for
 * the info modal: `image`/`title`/`description` come from the skills.sh page's
 * Open Graph tags (the page can't be iframed — `x-frame-options: DENY` — so the
 * og:image is the rendered "page preview"), `skillsUrl` links back to skills.sh,
 * and `sourceUrl` links to either the GitHub repository or website publisher.
 * `image`/`skillsUrl` are null when the skill has no reachable skills.sh page.
 */
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

/**
 * One skill discovered inside an import source — its dir/frontmatter `name` (the
 * value the import path matches against) and SKILL.md `description` for the
 * picker row. Mirrors what `discoverSkillDirs` + `parseSkillDir` yield.
 */
const DiscoveredSkillSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;

/**
 * Success body for `GET /api/skills/discover`. Enumerates every SKILL.md found
 * in a remote/local source via a shallow clone (same machinery as import), so
 * the Import modal can offer a picker of what to ingest instead of a blind
 * free-text "which skill" box. Empty `skills` means the source had no SKILL.md.
 */
export const SkillDiscoverSchema = z
  .object({ skills: z.array(DiscoveredSkillSchema) })
  .loose() satisfies StandardSchemaV1;
export type SkillDiscover = z.infer<typeof SkillDiscoverSchema>;

/**
 * Success body for `GET /api/skills/resolve-ref` — where a skill's `/other-skill`
 * reference resolves, by TRUSTED-PROVENANCE precedence (no marketplace-wide name
 * search, by design):
 *
 *  - `local`   — a skill by that name is already installed (nothing to import;
 *    `scope`/`name` name it). Wins first: it's what the user already has, and
 *    importing a same-name skill would fork.
 *  - `import`  — resolvable from a trusted source: `via: 'source'` (a sibling in
 *    the referencing skill's own origin repo/plugin) or `via: 'publisher'` (a
 *    same-publisher skills.sh result). `source`/`ref` drive a consented preview.
 *  - `none`    — no trusted signal matched. The caller leaves the missing-ref
 *    marker and offers MANUAL Explore search; OK never auto-picks a fuzzy match.
 */
export const SkillRefResolutionSchema = z
  .object({
    kind: z.enum(['local', 'import', 'none']),
    scope: z.enum(MANAGED_ARTIFACT_SCOPES).optional(),
    name: z.string().optional(),
    /** `kind: 'local'` only — the resolved skill's REAL bundle dir, base-relative
     *  (`.claude/skills/<name>`, `.agents/skills/<name>`, a custom root, …).
     *  Without it a caller has to guess the on-disk shape, and guessing the
     *  retired `.ok/skills/<name>` store mints a doc name that opens a phantom
     *  empty tab. The server already resolves this dir to answer the query. */
    dir: z.string().optional(),
    source: z.string().optional(),
    ref: z.string().optional(),
    via: z.enum(['source', 'publisher']).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillRefResolution = z.infer<typeof SkillRefResolutionSchema>;

/**
 * One bundle file in a skill preview — a `references/**` or `scripts/**` file's
 * skill-relative path and full UTF-8 contents, read (never executed) during the
 * same shallow clone that yields `skillMd`. Mirrors `AcquiredFile` from the
 * import parser so the preview shows the exact bytes an import would write.
 */
const SkillPreviewFileSchema = z
  .object({
    relPath: z.string(),
    /** UTF-8 text, or `null` when the file is binary. Raw bytes are NOT sent to
     *  the preview (a preview renders text or shows the file as binary) — the
     *  full-fidelity bytes only matter on import. */
    content: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;

/** Provider-neutral plugin metadata for a source managed by a plugin system. */
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

/**
 * A plugin detected by inspecting the CLONED skills.sh source repo — skills.sh
 * surfaces one skill and never flags the plugin relationship, so the preview
 * reads the source's manifest itself. `bundledSkills` is the sibling set (powers
 * "set up the whole plugin" + dependent-ref resolution); capability flags are
 * presence-only (never mapped/run). `setupSupported` is true only for providers
 * OK can drive the install of (Claude) — false providers disclose + link.
 */
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

/**
 * Success body for `GET /api/skills/preview`. Returns the un-imported skill's
 * full `SKILL.md` text (frontmatter + body) plus every `references/**` /
 * `scripts/**` bundle file, so the Explore preview can render the skill through
 * the editor's own read-only markdown viewer with a file tree — the same prose
 * and files it'd show once imported, before committing to the import. `name` is
 * the skill actually picked from the source (its frontmatter/dir name, which can
 * differ from the search row's name); `description` is the SKILL.md frontmatter
 * description (null when absent). Fetched via a shallow clone (same machinery as
 * import), so a network/clone failure surfaces as a non-`ok` request and the
 * preview degrades to the Open Graph card.
 */
export const SkillPreviewSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    skillMd: z.string(),
    files: z.array(SkillPreviewFileSchema),
    /** Normalized plugin provenance when a registered provider owns the source. */
    plugin: PluginSourceMetadataSchema.optional(),
    /** Set when the CLONED skills.sh source repo is itself a plugin bundling
     *  several skills — drives the "also available as a full plugin" disclosure. */
    pluginBundle: PluginBundleMetadataSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SkillPreview = z.infer<typeof SkillPreviewSchema>;
