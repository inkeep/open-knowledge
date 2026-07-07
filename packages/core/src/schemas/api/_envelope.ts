/**
 * Cross-cutting envelope + scaffolding schemas that aren't tied to a single
 * cluster: server-info / principal flat success bodies, the closed
 * `ProblemTypeSchema` URN union, the `ProblemDetailsSchema` RFC 9457 body,
 * `assertNeverProblemType`, the multipart upload metadata schema, the
 * local-op clone request schema (which `withValidation` references at the
 * generic local-op gate), and the streaming-error event schema used by
 * NDJSON endpoints.
 *
 * These were the pre-cluster region of the original monolithic api.ts.
 * Cluster files import the URN union + problem-details schema from here
 * when they need to extend or reference them.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

import { URN_UUID_RE } from './_shared.ts';
import { isValidBranchName } from './share.ts';

/**
 * Response shape for `GET /api/server-info`.
 *
 * The per-process `serverInstanceId` is a UUID generated at server start;
 * the client's `ProviderPool` caches it and uses it in
 * `expectedServerInstanceId` claims on every WebSocket reconnect.
 * Mismatch triggers the client-side restart-recovery recycle path (see
 * `provider-pool.ts:handleServerInstanceMismatch`).
 *
 * `currentBranch` is the late-join backstop for the CC1 `branch-switched`
 * stateless broadcast. Stateless frames have no replay, so a client
 * briefly offline during a branch switch silently re-syncs against the
 * new branch with stale-branch IDB. The boot fetch and every reconnect
 * fetch compare against the last-observed branch; a change triggers
 * `handleBranchSwitched` exactly as the live broadcast would. Optional
 * for backwards-compat with non-git deployments where branch is
 * meaningless.
 *
 * `currentDiskAckSVs` is the late-join backstop for the CC1 `disk-ack`
 * stateless broadcasts. Same gap as `branch-switched` (no replay), with
 * a stronger correctness consequence: a stale `lastDiskAckedSV` would
 * cause the mismatch-recycle baseline-selection to over-include
 * durably-persisted bytes in the buffer, re-replaying them onto the
 * post-restart server's markdown-rebuilt Y.Doc and producing
 * duplication. The map is keyed by `documentName`; values are
 * base64-encoded `Uint8Array` state vectors (same wire shape as
 * `CC1DiskAckPayload.sv`). Clients refresh their per-entry
 * `lastDiskAckedSV` on every `__system__` reconnect via this fetch.
 * Empty `{}` is valid (cold server with no flushed docs).
 */
/**
 * `boot` carries server boot-phase timings for the desktop startup
 * instrumentation waterfall. Present only when the standalone `bootServer`
 * path ran (the dev-server / plugin path omits it). `startedAt` is the
 * boot-start wall-clock (ISO 8601, from `toISOString()`) used for cross-process
 * clock alignment; every other field is a non-negative millisecond duration (or
 * a file count). Every value is server-generated and bounded in cardinality —
 * no user paths, document content, or free-form strings — so disclosure on
 * `/api/server-info` is safe.
 *
 * `startedAt` stays a permissive `min(1)` string rather than `.datetime()` on
 * purpose: `boot` is a nested field on the shared `ServerInfoSuccessSchema`, and
 * a present-but-invalid nested field fails the WHOLE envelope parse. Tightening
 * the format here would couple unrelated consumers of that envelope (branch
 * display, version-drift) to the exact format of a cosmetic timestamp.
 */
export const ServerInfoBootSchema = z.object({
  startedAt: z.string().min(1),
  httpListenMs: z.number().nonnegative().optional(),
  seedWalkMs: z.number().nonnegative().optional(),
  indexesMs: z.number().nonnegative().optional(),
  readyMs: z.number().nonnegative().optional(),
  fileCount: z.number().nonnegative().optional(),
});
export type ServerInfoBoot = z.infer<typeof ServerInfoBootSchema>;

export const ServerInfoSuccessSchema = z
  .object({
    serverInstanceId: z.string().min(1),
    currentBranch: z.string().min(1).optional(),
    currentDiskAckSVs: z.record(z.string().min(1), z.string().min(1)).optional(),
    boot: ServerInfoBootSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type ServerInfoSuccess = z.infer<typeof ServerInfoSuccessSchema>;

/**
 * Response shape for `GET /api/principal`.
 *
 * The Zod schema is the single source of truth for the wire shape; the
 * `Principal` type alias re-exported from `../../types/principal.ts` is
 * `z.infer<typeof PrincipalSuccessSchema>`. Schema-first eliminates the
 * "two parallel declarations + cast at trust boundary" failure class.
 *
 * `display_name` is `.min(1)` so an empty git-config user.name
 * (template-rendered configs, mis-quoted setup scripts) routes through the
 * `safeParse` failure path to the random-identity fallback rather than
 * rendering an empty initial / blank tooltip / blank cursor label downstream.
 * `display_email` has no length constraint because it is never rendered in
 * awareness — it is used only server-side (shadow-repo authoring,
 * Co-Authored-By). Rejecting an otherwise-valid principal because its email
 * is absent would discard a usable `display_name` and `id` unnecessarily.
 *
 * `.loose()` preserves unknown fields for forward-compat — new server
 * fields don't break older clients. Parse failures fall back silently to
 * the random-identity fallback; presence remains functional.
 *
 * Note: this schema uses a bare object shape (no `ok: true` discriminator),
 * matching the RFC 9457 wire shape — `handleServerInfo` /
 * `handleWorkspace` / `handlePrincipal` all emit flat `{...data}` objects
 * with `Content-Type: application/json` (no `ok: true` wrapper); errors
 * emit `application/problem+json` per `ProblemDetailsSchema`.
 */
export const PrincipalSuccessSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    display_email: z.string(),
    source: z.enum(['git-config', 'synthesized']),
    created_at: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type PrincipalSuccess = z.infer<typeof PrincipalSuccessSchema>;

/**
 * Response shape for `GET /api/config` — the React shell's collab-bootstrap
 * payload, served identically by `ok ui` and (in the desktop /
 * worktree-as-project-server topology) the collab server's api-extension.
 *
 * `collabUrl` is the same-origin `ws://<host>/collab` URL, or `null` when no
 * collab server is bound / the Host header is absent (the client then falls
 * back to a same-origin WS URL). `previewUrl` is always `null` on the wire
 * (the route-only preview URL is computed client-side). `port` is the bound
 * server port (0 when unknown). `paneTarget` is the armed deep-link route
 * fragment (`#/<doc>` / `#/<folder>/`), TTL-bounded server-side, or `null`
 * when unarmed/expired.
 *
 * `.loose()` preserves unknown fields for forward-compat, matching the other
 * bare-object success schemas in this file (no `ok: true` discriminator).
 */
export const ApiConfigSuccessSchema = z
  .object({
    collabUrl: z.string().nullable(),
    previewUrl: z.string().nullable(),
    port: z.number(),
    paneTarget: z.string().nullable(),
    /**
     * `true` when this server is a no-project ephemeral single-file session
     * (`ok <file>`). The React shell reads it to drop the project chrome
     * (sidebar / file-tree / project switcher / tabs / Settings) while keeping
     * the editor editable. Absent/false on every normal project server.
     */
    singleFile: z.boolean().default(false),
  })
  .loose() satisfies StandardSchemaV1;
export type ApiConfigSuccess = z.infer<typeof ApiConfigSuccessSchema>;

// ---------------------------------------------------------------------------
// RFC 9457 Problem Details
// ---------------------------------------------------------------------------
//
// Errors emitted from `api-extension.ts` use RFC 9457 Problem Details on the
// wire. The server's `errorResponse` helper constructs a `ProblemDetails`
// object, validates it through `ProblemDetailsSchema.parse()`, and emits with
// `Content-Type: application/problem+json`.
//
// `type` tokens are URN form `urn:ok:error:<kebab>` (RFC 9457 §3.1.1
// recommends absolute URIs and warns that path-only relative URIs depend on
// base-URI resolution). URNs are routing-independent so the meaning won't
// shift under reverse-proxy / path-prefix.
//
// The schema is closed by policy — adding a new token is a single edit
// here in lockstep with the handler PR that emits it. Future opening
// triggers (MCP `upload_asset` ships, public SDK ships) get a new spec.

/**
 * RFC 9457 `type` URN tokens. Closed by policy.
 *
 * Naming convention: `urn:ok:error:<kebab-action-or-condition>`.
 * Adding a new token = single edit here + the handler PR that emits it.
 *
 * Domain-prefix convention: when a token names a noun the API operates on
 * (e.g. documents), use the **same prefix the codebase uses for the entity**.
 * Documents are referred to as `doc` (matching the `docName` parameter and
 * the cluster-B CRUD verbs), so document-related tokens use the `doc-`
 * prefix uniformly: `doc-not-found`, `doc-already-exists`, `doc-not-open`,
 * `doc-not-available`, `reserved-doc-name`. Avoid mixed/compound forms
 * (`document-`, `docname`) — they create cognitive load for SDK consumers.
 */
export const ProblemTypeSchema = z.enum([
  // Upload-side (covers all 5 UploadWriteReason variants 1:1)
  'urn:ok:error:malformed-upload',
  'urn:ok:error:collision-exhaustion',
  'urn:ok:error:storage-full',
  'urn:ok:error:storage-readonly',
  'urn:ok:error:storage-error',
  'urn:ok:error:no-file-received',
  'urn:ok:error:path-escape',
  // Cross-handler shared
  'urn:ok:error:method-not-allowed',
  'urn:ok:error:invalid-request',
  'urn:ok:error:payload-too-large',
  // Request-body read exceeded the per-function 30s timeout in `readRequestBody`.
  // Distinct URN from `payload-too-large` (size cap) and `invalid-request`
  // (parse/shape) so SDK consumers can branch on retry-class (408 → drop
  // and retry, slowloris-class) vs bug-class (400 → fix request) vs
  // size-class (413 → reduce payload).
  'urn:ok:error:request-timeout',
  'urn:ok:error:internal-server-error',
  // /api/local-op/* security gate (shared by all local-op endpoints)
  'urn:ok:error:loopback-required',
  'urn:ok:error:invalid-origin',
  // /api/local-op/clone
  'urn:ok:error:url-not-allowed',
  'urn:ok:error:dir-outside-home',
  'urn:ok:error:concurrent-operation',
  'urn:ok:error:clone-failed',
  'urn:ok:error:clone-timeout',
  'urn:ok:error:server-start-failed',
  // Cluster A: agent-write / -write-md / -patch / -undo.
  // `reserved-doc-name` rejects writes to system / config doc names (post-
  // identity, attributed). `target-not-found` / `stale-target` /
  // `frontmatter-edit-not-supported` are handleAgentPatch-specific.
  // `no-active-session` is handleAgentUndo-specific.
  // `too-many-agent-sessions` (DoS guard): the AgentSessionManager's
  // per-server cap was hit before the inbound write could allocate a new
  // session — surfaced as 503 so SDK consumers know to retry-after.
  'urn:ok:error:reserved-doc-name',
  'urn:ok:error:target-not-found',
  'urn:ok:error:stale-target',
  'urn:ok:error:frontmatter-edit-not-supported',
  // /api/frontmatter-patch atomic rejection on per-key value-schema failure.
  // Distinct from `frontmatter-edit-not-supported` (agent-patch FM intersect)
  // so SDK consumers can branch: this one carries a `fieldErrors` extension
  // map; the other directs the caller to use a different tool.
  'urn:ok:error:invalid-frontmatter-patch',
  // agent's write payload contained YAML in the FM region
  // that fails to parse (commonly an unquoted string value with `:`/`#`/
  // leading `-`). Fired only when the FM actually CHANGED — gates the
  // introducer at write time so the bad bytes never reach Y.Text. Carries
  // `file` + raw `parseError` extensions so agents can self-correct.
  'urn:ok:error:frontmatter-malformed',
  'urn:ok:error:no-active-session',
  'urn:ok:error:too-many-agent-sessions',
  // an out-of-band disk edit diverged from the loaded base after the
  // agent's edit was prepared; the store-time backstop aborted the overwrite
  // (disk won), so the agent edit was NOT applied. 409 Conflict. Emitted by the
  // mutating write handlers (write / edit / frontmatter / undo / rollback) — the
  // agent re-reads and retries (the edit was discarded, not double-applied).
  'urn:ok:error:disk-divergence',
  // Cluster B: pages CRUD. `doc-not-found` covers rename / rollback
  // / delete / rename-path "doesn't exist" cases; `doc-already-exists` covers
  // create-page collision and rename-into-existing destinations.
  // `doc-not-open` distinguishes rollback's open-in-editor requirement
  // from the absent-on-disk case. `rollback-not-configured` flags the
  // shadow-repo-unavailable startup state separately from internal-error.
  'urn:ok:error:doc-not-found',
  'urn:ok:error:doc-already-exists',
  'urn:ok:error:doc-not-open',
  'urn:ok:error:rollback-not-configured',
  // Cluster C: document/links read part 1. `doc-not-available`
  // distinguishes hocuspocus-document-load failure from `doc-not-found`
  // (former is server-internal, latter is "doesn't exist on disk").
  // `backlink-index-not-configured` flags the (rare) startup state where
  // the backlink index hasn't initialized yet — distinct from internal
  // errors during read.
  'urn:ok:error:doc-not-available',
  'urn:ok:error:backlink-index-not-configured',
  // `file-rescan-not-configured` flags the startup-state where the watcher's
  // `rescanFromDisk` callback hasn't been wired into `createApiExtension` —
  // emitted by `POST /api/test-rescan-files` (test-only) when the host
  // assembled the api-extension without the rescue capability. Parallel to
  // `backlink-index-not-configured` (same shape, different index).
  'urn:ok:error:file-rescan-not-configured',
  // Cluster D: orphans / hubs / dead-links / suggest-links.
  // No new tokens — reuses cluster-C `backlink-index-not-configured`,
  // cluster-B `doc-not-found` (suggest-links target missing), shared
  // `invalid-request` (orphan-mode / docName validation) and `internal-server-error`.
  // Cluster E: save-version / history / history/<sha> / diff / workspace /
  // rescue-list / rescue-get / server-info / principal.
  // `shadow-not-configured` covers the startup-state where the shadow repo
  // (history surface) is unavailable; `host-not-allowed` covers the
  // /api/workspace + /api/principal + /api/metrics/agent-presence DNS-rebinding
  // gate; `principal-not-available` is the 404 case when local git-config
  // identity is absent. `not-found` is the rescue-buffer fallback.
  'urn:ok:error:shadow-not-configured',
  'urn:ok:error:host-not-allowed',
  'urn:ok:error:principal-not-available',
  'urn:ok:error:not-found',
  // Cluster G: LocalOp + auth handlers.
  // `auth-failed` is the catch-all for non-zero subprocess exits across
  // login / repos / pat / status / signout. `no-project-dir` flags the
  // service-unavailable case where the server has no projectDir configured
  // (handleLocalOpAuthSetIdentity). `server-open-failed`
  // covers a server spawn-or-poll timeout (504). `concurrent-operation`,
  // `loopback-required`, `invalid-origin`, `method-not-allowed`, `invalid-request`,
  // `internal-server-error` are reused.
  'urn:ok:error:auth-failed',
  'urn:ok:error:no-project-dir',
  'urn:ok:error:server-open-failed',
  // Mutating-write refusal when the target doc is in a merge-conflict state
  // (`lifecycle.status === 'conflict'`). Emitted by every mutating write
  // surface — agent_write / agent_write_md / agent_patch / agent_undo /
  // rollback / rename / delete / template — so SDK consumers can branch on
  // URN to detect conflict-class refusals distinctly from other 409s
  // (`doc-already-exists`) or post-resolution retries. Wire body includes
  // a `file` extension (the .md path) and `resolutionOptions` (the strategy
  // enum mirror) so agents can transition straight to `conflicts({ kind: 'content' })`
  // + `resolve_conflict` without parsing the detail string.
  'urn:ok:error:doc-in-conflict',
  // `no-conflict-tracked` is the 404 surfaced by handleSyncConflictContent
  // when an agent asks for stages on a file the conflict store doesn't
  // track (stale 409 envelope, post-resolution retry, or wrong path).
  // Aligns with the analogous 404 produced by handleSyncResolveConflict —
  // both flag "I have no conflict record for this file" distinctly from
  // generic 4xx so MCP clients can branch on the URN.
  'urn:ok:error:no-conflict-tracked',
  // Cluster H: sync + seed handlers. `sync-not-active` flags the
  // service-unavailable state when the sync engine isn't constructed yet
  // (no remote, or sync subsystem disabled). `project-repo-not-configured`
  // flags handleSyncConflictContent's projectDir guard. `seed-prerequisite-missing`
  // covers SeedPrerequisiteError (e.g. project root not git-init'd);
  // `seed-invalid-root` covers SeedRootDirError (rootDir contains '..' or
  // absolute path). All other error paths reuse shared `invalid-request`,
  // `method-not-allowed`, `internal-server-error`, plus cluster-G's
  // `loopback-required` / `invalid-origin` from the shared local-op gate.
  'urn:ok:error:sync-not-active',
  'urn:ok:error:project-repo-not-configured',
  'urn:ok:error:seed-prerequisite-missing',
  'urn:ok:error:seed-invalid-root',
  // Cluster I: tags / search / folder-config / template / skill-install-state /
  // asset.
  // `tag-index-not-configured` flags the startup-state where the tag index
  // hasn't initialized yet (parallels cluster-C `backlink-index-not-configured`).
  // `template-not-found` is the leaf-to-root walk-exhausted 404 emitted by
  // `handleTemplateGet`. `unsupported-asset-type` is `handleAsset`'s 415 token
  // for non-renderable extensions (anything not in `INLINE_RENDERABLE_EXTENSIONS`)
  // — distinct from `invalid-request` so SDK consumers can branch on
  // unsupported-content (415) vs malformed-request (400). All other write-error
  // paths in this cluster reuse shared `invalid-request` + a `detail` string
  // carrying the underlying applyTemplateWrite/applyTemplateDelete/
  // applyNestedFolderRulesUpsert code.
  'urn:ok:error:tag-index-not-configured',
  'urn:ok:error:template-not-found',
  'urn:ok:error:unsupported-asset-type',
  'urn:ok:error:asset-not-found',
  // No-project single-file mode (the `ok <file>` ephemeral open) refuses the
  // contentDir-tree write handlers (`PUT /api/folder-config`, `PUT
  // /api/template`) with 403 — those would land sidecar artifacts in the
  // user's directory, which single-file mode must never do. Distinct URN
  // so a client can branch on "this surface is unavailable in single-file
  // mode" vs a generic forbidden/invalid-request.
  'urn:ok:error:single-file-mode',
  // `ok ui` proxy fall-through when the collab server (`ok start`) isn't
  // running. Surfaced through the same RFC 9457 contract as the in-process
  // server emits so client `ProblemDetailsSchema.safeParse` flows match.
  'urn:ok:error:collab-server-not-running',
  // `ok ui` proxy: upstream took longer than the upstream-timeout deadline
  // to respond. Distinct from `request-timeout` (slowloris-class body-read
  // timeout on the inbound direction) — `gateway-timeout` is the upstream
  // direction (504 semantics).
  'urn:ok:error:gateway-timeout',
  // /api/spawn-cursor (handoff sibling of /api/installed-agents).
  // `cursor-not-installed` (422) — the `cursor` binary couldn't be
  // resolved on the user's machine (no bundle path, `which` missed).
  // `cursor-spawn-timeout` (504) — the spawn deadline expired before the
  // child process settled. `cursor-spawn-failed` (502) — child process
  // emitted an error event other than ENOENT/EACCES/EPERM (binary present
  // but spawn failed for some other reason, e.g. malformed shim). Symmetric
  // with `clone-timeout` / `clone-failed` so SDK consumers can branch by
  // class (timeout vs hard-failure) rather than parsing detail strings.
  'urn:ok:error:cursor-not-installed',
  'urn:ok:error:cursor-spawn-timeout',
  'urn:ok:error:cursor-spawn-failed',
  // /api/handoff — generalized cross-target Open-in-Agent dispatch. The
  // recipe-per-target handler surfaces the same three failure classes as
  // /api/spawn-cursor but for any target (Claude / Codex / Cursor), so the
  // URNs are target-agnostic. A `target` extension member (spread onto the
  // problem body via `errorResponse({ extensions: { target } })`) identifies
  // which target failed; consumers branch on URN for class
  // (not-installed vs timeout vs hard-failure) and on `target` for routing.
  'urn:ok:error:handoff-target-not-installed',
  'urn:ok:error:handoff-spawn-timeout',
  'urn:ok:error:handoff-spawn-failed',
]) satisfies StandardSchemaV1;
export type ProblemType = z.infer<typeof ProblemTypeSchema>;

/**
 * Per-DU exhaustiveness helper for `ProblemType` (and any subset thereof —
 * `UploadWriteReason` etc.). Mirrors `assertNeverLinkTarget` /
 * `assertNeverDiskEvent`. Using it as `default: assertNeverProblemType(target)`
 * forces a compile error at every consumer site when a new URN token is added
 * to `ProblemTypeSchema` and the switch hasn't grown a matching case.
 */
export function assertNeverProblemType(value: never): never {
  throw new Error(`Unexpected ProblemType variant: ${JSON.stringify(value)}`);
}

/**
 * RFC 9457 Problem Details body shape.
 *
 * Wire shape: `{ type, title, status, instance?, detail? }` with
 * `Content-Type: application/problem+json`. Top-level fields per RFC 9457 §3:
 * - `type` (REQUIRED, URN) — typed problem identifier
 * - `title` (REQUIRED) — short human-readable summary
 * - `status` (REQUIRED) — must equal HTTP response status
 * - `instance` (OPTIONAL, RFC 9457 §3.1.6 — URI reference) — `urn:uuid:<uuid>`
 *   per error emit. Same value mirrored in Pino structured log line
 *   for grep correlation. The URN form is the RFC 4122 URI representation
 *   of a UUID and satisfies the §3.1.6 URI-reference contract while
 *   remaining a single token (no slashes / path segments) so log-grep
 *   workflows still pattern-match a flat string.
 * - `detail` (OPTIONAL) — longer human-readable explanation
 *
 * `.loose()` preserves unknown extension fields per RFC 9457 §3.2.
 */
export const ProblemDetailsSchema = z
  .object({
    type: ProblemTypeSchema,
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    instance: z.string().regex(URN_UUID_RE, 'instance must be urn:uuid:<uuid>').optional(),
    detail: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

// ---------------------------------------------------------------------------
// Per-handler request + success schemas
// ---------------------------------------------------------------------------
//
// Per-handler schemas live alongside the canonical envelope so consumers
// only need a single import path. Success schemas drop the `{ ok: true }`
// wrapper — clients use HTTP-status discrimination (`if (!res.ok)`).
// Request schemas feed the `withValidation()` middleware wrapper so
// handlers receive an already-typed body and can never be added without
// going through the wrapper.

/**
 * Multipart-form metadata fields validated by `withValidation` for
 * `POST /api/upload`. The binary payload itself is parsed by busboy upstream;
 * Zod validates only the fields that flow through normal parsing.
 *
 * `parentDocName` is required so the server can resolve the asset's
 * destination directory. `placement` distinguishes editor uploads from
 * explicit sidebar folder drops. `agentId` and `agentName` are optional;
 * missing identity routes the upload through the default-agent fallback.
 */
export const UploadRequestSchema = z
  .object({
    parentDocName: z.string().min(1),
    placement: z.enum(['configured-attachments', 'parent-dir']).default('configured-attachments'),
    agentId: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type UploadRequest = z.infer<typeof UploadRequestSchema>;

/**
 * Success response for `POST /api/upload` — flat `{ ...data }` shape with
 * `Content-Type: application/json` (no `ok: true` wrapper).
 *
 * `src` is the on-disk basename the server linked to. `path` is the
 * contentDir-relative path the client emits in the markdown ref — clients
 * MUST prefer `path` over `src` so non-default `attachmentFolderPath`
 * configurations (Obsidian-style `attachments/`, bare-name, parent-relative)
 * round-trip correctly. `deduped` is true when the upload hit the same-dir
 * sha256 cache (no new bytes written).
 */
export const UploadAssetSuccessSchema = z
  .object({
    src: z.string().min(1),
    path: z.string().min(1).optional(),
    deduped: z.boolean().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type UploadAssetSuccess = z.infer<typeof UploadAssetSuccessSchema>;

/**
 * Request body for `POST /api/local-op/clone`.
 *
 * `url` is the git remote URL (https/ssh/git/SCP-style); the server's
 * `isAllowedGitUrl` check enforces the protocol allowlist after schema
 * validation. `dir` is the local destination directory; `isSafeLocalPath`
 * confines it to the user's home directory. Both fields are non-empty
 * strings; protocol/path-safety failures emit `urn:ok:error:url-not-allowed`
 * / `urn:ok:error:dir-outside-home` post-validation.
 */
export const LocalOpCloneRequestSchema = z
  .object({
    url: z.string().min(1),
    dir: z.string().min(1),
    /**
     * Optional ref for `git clone -b <branch>`. When the branch is missing
     * upstream, the clone falls back to the remote default branch and emits
     * a `branch-fallback` event before retrying.
     *
     * Validated via the shared `isValidBranchName` predicate. `git clone -b`
     * treats its argument literally (not a refspec) so the risk is lower
     * than `git fetch`, but defense-in-depth — a leading-dash branch like
     * `--upload-pack=evil` could be misinterpreted by some git versions as
     * a flag.
     */
    branch: z.string().min(1).refine(isValidBranchName, 'invalid branch name').optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpCloneRequest = z.infer<typeof LocalOpCloneRequestSchema>;

/**
 * Mid-stream error event emitted on NDJSON streaming endpoints.
 *
 * The streaming protocol's `type` field discriminates event kinds
 * (`progress` | `complete` | `error`) — preserved as the wire-level
 * discriminator. Typed RFC 9457 `ProblemDetails` lives nested under
 * `problem`, so the streaming `type: 'error'` and the URN `problem.type`
 * never collide. Pre-stream errors continue to use `errorResponse(...)` +
 * `application/problem+json` content-type.
 *
 * See `handleLocalOpClone` for the canonical streaming-endpoint pattern.
 */
export const StreamingProblemEventSchema = z
  .object({
    type: z.literal('error'),
    problem: ProblemDetailsSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type StreamingProblemEvent = z.infer<typeof StreamingProblemEventSchema>;
