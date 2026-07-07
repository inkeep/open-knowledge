/**
 * sync + seed + skill-install handlers
 *
 * Nine handlers: `handleSyncStatus`, `handleSyncTrigger`, `handleSyncConflicts`,
 * `handleSyncResolveConflict`, `handleSyncConflictContent`,
 * `handleSeedPlan`, `handleSeedApply`, `handleSeedPacks`, `handleInstallSkill`.
 * All gated on `checkLocalOpSecurity` (loopback + Origin). Sync handlers are
 * HTTP-only — no IPC mirror exists. Seed plan/apply are also IPC-mirrored
 * (`ok:seed:plan` / `ok:seed:apply` on the desktop bridge); their HTTP fallback
 * in `seedClient()` translates the RFC 9457 wire shape back to the in-process
 * `OkSeedPlanResult` / `OkSeedApplyResult` discriminated unions so renderers
 * don't branch by transport. The RFC 9457 path only carries the SUCCESS
 * payload (`{plan}` / `{result}`); error kinds (`prerequisite-missing` /
 * `invalid-root` / `internal`) arrive as URN tokens and are translated
 * client-side.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

/**
 * `SyncState` literal-union mirroring the in-process `SyncState` type from
 * `sync-engine.ts`. Sourced here so wire consumers (UI, CLI) can branch on
 * states without importing server-internal modules.
 */
export const SyncStateSchema = z.enum([
  'dormant',
  'idle',
  'fetching',
  'pulling',
  'pushing',
  'conflict',
  'offline',
  'auth-error',
  'disabled',
]) satisfies StandardSchemaV1;
export type SyncStateWire = z.infer<typeof SyncStateSchema>;

/**
 * Origin remote, resolved for display in the Sync UI. Null on the wire when
 * no remote is configured. `webUrl` is non-null only for recognized GitHub
 * origins (the UI renders it as a link); non-GitHub remotes carry a readable
 * `label` with a null `webUrl` (name shown, not linkified).
 */
export const SyncRemoteSchema = z
  .object({
    /** "owner/repo" for GitHub; a host/path label otherwise. */
    label: z.string().min(1),
    /** Browsable https URL, or null when not a recognized GitHub remote. */
    webUrl: z.url().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncRemoteWire = z.infer<typeof SyncRemoteSchema>;

/**
 * Push-permission probe outcome carried in the sync-status payload. Mirrors the
 * server-side `PushPermission` discriminated union in
 * `packages/server/src/github-permissions.ts`, flattened into a single object
 * with `checkStatus` discriminator so the frontend can branch without runtime
 * narrowing. Absent (`undefined`) when the engine hasn't completed a probe yet
 * (e.g. no remote, probe in flight, GHES not yet exercised) — UI treats absent
 * as "no gate" and renders current behavior.
 */
export const PushPermissionSchema = z.discriminatedUnion('checkStatus', [
  z.object({ checkStatus: z.literal('allowed') }).loose(),
  z
    .object({
      checkStatus: z.literal('denied'),
      deniedReason: z.enum(['no-collaborator', 'private-no-access', 'repo-not-found']),
    })
    .loose(),
  z
    .object({
      checkStatus: z.literal('unknown'),
      unknownError: z
        .enum(['network', 'timeout', 'rate-limit', 'token-invalid', 'malformed-response'])
        .optional(),
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type PushPermissionWire = z.infer<typeof PushPermissionSchema>;

/**
 * Bounded UI-localizable sync failure codes — the single source of truth for
 * every site that produces, validates, or formats a sync error code. The wire
 * carries only the code; the UI maps it to localized copy via Lingui. The
 * server's `UserFacingErrorCode` (in `error-classification.ts`) and the app's
 * formatter/hook types all derive from this tuple so the four directions
 * (producer, wire, hook, formatter) can't drift.
 */
export const SYNC_ERROR_CODES = [
  'auth-403',
  'auth-401',
  'auth-scope-mismatch',
  // No credential available — the store had no token for the host, so git fell
  // back to a (no-TTY) interactive prompt. Distinct from `auth-401` (a token
  // exists but was rejected): the user must reconnect, not just retry.
  'auth-no-credential',
  'semantic-protected-branch',
] as const;

export const SyncErrorCodeSchema = z.enum(SYNC_ERROR_CODES);
export type SyncErrorCode = z.infer<typeof SyncErrorCodeSchema>;

/**
 * Full sync engine status — emitted as the flat success body of
 * `GET /api/sync/status` AND as the nested `status` field of
 * `POST /api/sync/set-enabled`. Mirrors the in-process `SyncStatus` interface
 * in `sync-engine.ts`. `.loose()` for forward-compat (sync-engine may add
 * fields without a wire migration).
 */
export const SyncStatusSchema = z
  .object({
    state: SyncStateSchema,
    lastSyncUtc: z.string().nullable(),
    lastFetchUtc: z.string().nullable(),
    lastPushedSha: z.string().nullable(),
    ahead: z.number().int().min(0),
    behind: z.number().int().min(0),
    consecutiveFailures: z.number().int().min(0),
    conflictCount: z.number().int().min(0),
    hasRemote: z.boolean(),
    syncEnabled: z.boolean(),
    identityUnresolved: z.boolean(),
    /** Resolved origin remote for display; null when no remote is configured. */
    remote: SyncRemoteSchema.nullable().optional(),
    /**
     * Per-direction error surfaces. `push*` = sending commits out; `pull*` =
     * bringing remote changes in (fetch + merge). Tracked separately so a
     * success on one leg never clears the other's error (a failed push must
     * stay visible even after a successful fetch). Within each direction at
     * most one of `{<dir>Error, <dir>ErrorCode}` carries content: the bounded
     * code (UI-localized via Lingui) wins at render, else the raw message.
     */
    pushError: z.string().optional(),
    pushErrorCode: SyncErrorCodeSchema.optional(),
    pullError: z.string().optional(),
    pullErrorCode: SyncErrorCodeSchema.optional(),
    pausedReason: z.string().optional(),
    /** Push-permission probe outcome. Absent when no probe has resolved yet. */
    pushPermission: PushPermissionSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncStatusWire = z.infer<typeof SyncStatusSchema>;

/**
 * Request body for `POST /api/sync/trigger`. `op` is optional — server defaults
 * to `'sync'` when omitted. Pre-validation, the legacy handler accepted any
 * unknown shape and silently fell through to `'sync'`; the schema-validated
 * form rejects unknown `op` values explicitly with `urn:ok:error:invalid-request`.
 */
export const SyncTriggerRequestSchema = z
  .object({
    op: z.enum(['sync', 'push', 'pull']).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncTriggerRequest = z.infer<typeof SyncTriggerRequestSchema>;

/**
 * Success body for `POST /api/sync/trigger`. Returns 202 Accepted with the
 * resolved `op` echo — the trigger runs in background.
 */
export const SyncTriggerSuccessSchema = z
  .object({
    op: z.enum(['sync', 'push', 'pull']),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncTriggerSuccess = z.infer<typeof SyncTriggerSuccessSchema>;

/**
 * Single conflict entry shape. Mirrors `ConflictEntry` from
 * `conflict-storage.ts`. SHAs are optional because git can produce
 * delete/edit or add/add conflicts where some stages are missing.
 */
export const ConflictEntrySchema = z
  .object({
    file: z.string().min(1),
    detectedAt: z.string().min(1),
    oursSha: z.string().optional(),
    theirsSha: z.string().optional(),
    baseSha: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type ConflictEntryWire = z.infer<typeof ConflictEntrySchema>;

/** Success body for `GET /api/sync/conflicts`. */
export const SyncConflictsSuccessSchema = z
  .object({
    conflicts: z.array(ConflictEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncConflictsSuccess = z.infer<typeof SyncConflictsSuccessSchema>;

/**
 * Request body for `POST /api/sync/resolve-conflict`. `content` is required
 * iff `strategy === 'content'` — enforced via `.refine()` so `withValidation`
 * emits a typed `urn:ok:error:invalid-request` 400 with the field path,
 * rather than letting the runtime check in `conflict-storage.ts` throw a
 * generic Error that the handler's catch maps to 500.
 */
export const SyncResolveConflictRequestSchema = z
  .object({
    file: z.string().min(1),
    strategy: z.enum(['mine', 'theirs', 'content', 'delete']),
    content: z.string().optional(),
  })
  .loose()
  .refine((d) => d.strategy !== 'content' || (d.content !== undefined && d.content !== ''), {
    message: "content must be a non-empty string when strategy is 'content'",
    path: ['content'],
  }) satisfies StandardSchemaV1;
export type SyncResolveConflictRequest = z.infer<typeof SyncResolveConflictRequestSchema>;

/**
 * Success body for `POST /api/sync/resolve-conflict`. Empty — clients only
 * branch on HTTP status. `.loose()` for forward-compat.
 */
export const SyncResolveConflictSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type SyncResolveConflictSuccess = z.infer<typeof SyncResolveConflictSuccessSchema>;

/**
 * Success body for `GET /api/sync/conflict-content?file=<path>`. Each stage
 * may be missing (delete/edit, add/add) — the handler tolerates by returning
 * empty strings rather than 404, so consumers always see all four fields.
 *
 * `kind` is the stage-presence discriminator derived server-side from which
 * of `git show :2:` / `git show :3:` succeeded. `'both-modified'` when both
 * stages exist (the classical merge conflict). `'delete-modify'` (DU) when
 * stage 2 (ours) is absent — local deleted, remote modified. `'modify-delete'`
 * (UD) when stage 3 (theirs) is absent — local modified, remote deleted.
 * Consumers (UI, MCP agents) branch on this to pick the appropriate
 * resolution affordance — empty-string stages are otherwise indistinguishable
 * from legitimately-empty files.
 *
 * `lifecycleStatus` is populated when `?source=ytext` is set and the requested
 * doc is loaded server-side — lets MCP `conflicts({ kind: 'content' })` callers detect
 * resolution state without a second round-trip. Null otherwise (no loaded doc,
 * default `git show :2:` path, or status unset on the Y.Map).
 */
export const SyncConflictContentSuccessSchema = z
  .object({
    file: z.string().min(1),
    base: z.string(),
    ours: z.string(),
    theirs: z.string(),
    kind: z.enum(['both-modified', 'delete-modify', 'modify-delete']),
    lifecycleStatus: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncConflictContentSuccess = z.infer<typeof SyncConflictContentSuccessSchema>;

/**
 * Success body for `GET /api/seed/plan`. The `plan` field is the in-process
 * `ScaffoldPlan` shape from `@inkeep/open-knowledge-server` — deliberately
 * unconstrained here (typed `unknown`) to avoid a parallel maintenance source
 * for the rich nested structure. Consumers re-cast via `OkScaffoldPlan` (the
 * canonical desktop-bridge type). The translation shim in `seedClient()`
 * converts the flat wire `{plan}` to the in-process `{ok: true, plan}`
 * discriminated union for shared consumption with the IPC bridge.
 *
 * The custom check forces presence — `z.unknown()` alone would accept
 * `{plan: undefined}` (i.e. a missing-key body), defeating the request/
 * response shape contract.
 */
export const SeedPlanSuccessSchema = z
  .object({
    plan: z.custom<unknown>((v) => v !== undefined, { message: 'plan is required' }),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedPlanSuccess = z.infer<typeof SeedPlanSuccessSchema>;

/**
 * Request body for `POST /api/seed/apply`. Carries the `ScaffoldPlan`
 * returned by `/api/seed/plan` (or constructed offline). Same opaque
 * `unknown`-with-presence-check pattern as `SeedPlanSuccessSchema` —
 * `applySeed()` validates structurally during apply.
 */
export const SeedApplyRequestSchema = z
  .object({
    plan: z.custom<unknown>((v) => v !== undefined, { message: 'plan is required' }),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedApplyRequest = z.infer<typeof SeedApplyRequestSchema>;

/**
 * Success body for `POST /api/seed/apply`. The `result` field is the
 * `ApplyResult` shape — same opaque `unknown`-with-presence-check pattern.
 * Translation shim turns this into `{ok: true, result}` for the in-process
 * discriminated union.
 */
export const SeedApplySuccessSchema = z
  .object({
    result: z.custom<unknown>((v) => v !== undefined, { message: 'result is required' }),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedApplySuccess = z.infer<typeof SeedApplySuccessSchema>;

/**
 * Per-folder metadata inside a `SeedPackInfo.folders[]`. `summary` is a
 * UI-friendly first-sentence of the full folder description (the long
 * agent-guidance text stays server-side and lands in `.ok/frontmatter.yml`
 * at apply time).
 */
export const SeedPackFolderInfoSchema = z
  .object({
    path: z.string().min(1),
    summary: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedPackFolderInfo = z.infer<typeof SeedPackFolderInfoSchema>;

/**
 * User-visible entry counts for a pack — what the picker card surfaces as
 * "N files · N folders". Counts only user-meaningful entries: top-level
 * folders the pack scaffolds, starter + extra template `.md` files, and
 * any `rootFiles`. `.ok/` infrastructure (per-folder `.ok/frontmatter.yml`,
 * `.ok/templates/` dirs) is intentionally excluded — the card is a UX
 * preview, not a literal plan count.
 */
export const SeedPackEntryCountsSchema = z
  .object({
    files: z.number().int().nonnegative(),
    folders: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedPackEntryCounts = z.infer<typeof SeedPackEntryCountsSchema>;

/**
 * Per-pack metadata returned by `GET /api/seed/packs` and the parallel
 * `okDesktop.seed.listPacks()` IPC. Static data — `defaultSubfolder` is
 * the recommended subfolder the picker pre-fills (undefined for project-root
 * packs like `plain-notes`). `folders[]` ships per-folder summaries so the
 * picker preview can display a one-line blurb next to each scaffolded
 * folder. `entryCounts` powers the card-level "N files · N folders" line.
 */
export const SeedPackInfoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    defaultSubfolder: z.string().optional(),
    folders: z.array(SeedPackFolderInfoSchema),
    entryCounts: SeedPackEntryCountsSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type SeedPackInfo = z.infer<typeof SeedPackInfoSchema>;

/**
 * Success body for `GET /api/seed/packs`. The picker UI fetches once on
 * dialog mount so a server-side registry change is reflected without a
 * client deploy.
 */
export const SeedListPacksSuccessSchema = z
  .object({
    packs: z.array(SeedPackInfoSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedListPacksSuccess = z.infer<typeof SeedListPacksSuccessSchema>;

/**
 * Request body for `POST /api/install-skill`. Both fields optional — empty
 * body is valid (treated as `{}` by `withValidation`'s zero-length guard).
 * `out` ultimately flows into `path.resolve()` + `mkdir({recursive: true})`
 * + `spawn('cmd', ['/c', 'start', '""', skillPath])` on Windows; the handler
 * applies an additional `isSafeLocalPath` check post-validation to confine
 * to `$HOME` (RFC 9457 invalid-request when the path escapes home, mirrors
 * `handleLocalOpClone`).
 */
export const InstallSkillRequestSchema = z
  .object({
    noOpen: z.boolean().optional(),
    out: z.string().min(1).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type InstallSkillRequest = z.infer<typeof InstallSkillRequestSchema>;

/**
 * Success body for `POST /api/install-skill`. Mirrors the in-process
 * `BuildAndOpenSkillResult` shape from `packages/server/src/skill-install.ts`.
 * `status` discriminates the four outcome paths via `z.discriminatedUnion`
 * so the schema rejects illegal field combinations (e.g.,
 * `{ status: 'failed', outputPath: '...' }` — `outputPath` is meaningless
 * when the build itself failed). Each variant carries only the fields
 * meaningful for that outcome.
 *
 * - `installed` — build + handoff both succeeded. Carries `outputPath`,
 *   `size`, `sha256`, `skillVersion`.
 * - `built` — file on disk, no app launched (`noOpen` flag, unsupported
 *   platform, or handoff failed). Carries the same artifact fields plus
 *   optional `handoffError` for the soft-fail subcase.
 * - `failed` — build itself failed, no file written. Carries `buildError`.
 * - `skip-current` — install-state gate hit, no rebuild. Always carries
 *   `skillVersion` (the current cached version); `recordedAt` is optional
 *   because the install-state file's per-target `recordedAt` field can be
 *   null when an entry was written before the field was introduced.
 */
const InstallSkillHandoffErrorSchema = z
  .object({
    reason: z.enum(['unsupported-platform', 'spawn-error']),
    message: z.string(),
  })
  .loose();
export const InstallSkillSuccessSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('installed'),
      outputPath: z.string(),
      size: z.number().int().nonnegative(),
      sha256: z.string(),
      skillVersion: z.string(),
    })
    .loose(),
  z
    .object({
      status: z.literal('built'),
      outputPath: z.string(),
      size: z.number().int().nonnegative(),
      sha256: z.string(),
      skillVersion: z.string(),
      handoffError: InstallSkillHandoffErrorSchema.optional(),
    })
    .loose(),
  z
    .object({
      status: z.literal('failed'),
      buildError: z.string(),
    })
    .loose(),
  z
    .object({
      status: z.literal('skip-current'),
      skillVersion: z.string(),
      recordedAt: z.string().optional(),
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type InstallSkillSuccess = z.infer<typeof InstallSkillSuccessSchema>;
