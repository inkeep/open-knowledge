/**
 * metrics + agent activity + test handlers.
 *
 * Eight handlers — `handleAgentActivity`, `handleAgentBurstDiff`,
 * `handleTestReset`, `handleTestRescanBacklinks`,
 * `handleMetricsReconciliation`, `handleMetricsParseHealth`,
 * `handleMetricsAgentPresence`, `handleInstalledAgentsRoute`. No new URN
 * tokens — every error path reuses existing tokens (`invalid-request`,
 * `reserved-doc-name`, `no-active-session`, `not-found`, `loopback-required`,
 * `host-not-allowed`, `invalid-origin`, `method-not-allowed`,
 * `backlink-index-not-configured`, `internal-server-error`).
 *
 * Several success bodies are operator-only metric snapshots whose field
 * shapes change frequently (`ReconciliationMetrics`, `ParseHealthMetrics`).
 * We keep their schemas permissive (`.loose()` over `z.record`) rather than
 * pinning every counter — operators and dashboards read fields by name, not
 * via discriminated narrowing, so a tightening here would just add lockstep
 * maintenance with `metrics.ts` / `parse-health.ts` without catching real
 * regressions.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

/** One unified-diff burst entry on `AgentActivitySuccessSchema.files[].bursts[]`. */
export const ActivityBurstSchema = z
  .object({
    stackIndex: z.number().int().min(0),
    ts: z.number().int().min(0),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
  })
  .loose() satisfies StandardSchemaV1;
export type ActivityBurst = z.infer<typeof ActivityBurstSchema>;

/** One file-level activity entry on `AgentActivitySuccessSchema.files`. */
export const ActivityFileSchema = z
  .object({
    docName: z.string().min(1),
    additionsTotal: z.number().int().min(0),
    deletionsTotal: z.number().int().min(0),
    lastTs: z.number().int().min(0),
    bursts: z.array(ActivityBurstSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type ActivityFile = z.infer<typeof ActivityFileSchema>;

/** Header info for the agent on `AgentActivitySuccessSchema.agent`. */
export const ActivityAgentHeaderSchema = z
  .object({
    displayName: z.string().min(1),
    color: z.string().min(1),
    icon: z.string().optional(),
    connectionId: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type ActivityAgentHeader = z.infer<typeof ActivityAgentHeaderSchema>;

/**
 * Success response for `GET /api/agent-activity?agentId=<connId>`. Returns
 * the per-agent activity ledger — every doc the agent has touched in the
 * current session, ordered most-recent first, with per-burst stack indexes
 * + +/- counts. `agent` is `null` when the connId isn't bound to a live
 * session (returns the zero-state ledger so the panel can render "no
 * active session"). Bodies that fail this schema are non-contract responses
 * → `HttpResponseParseError`.
 */
export const AgentActivitySuccessSchema = z
  .object({
    sessionAlive: z.boolean(),
    agent: ActivityAgentHeaderSchema.nullable(),
    files: z.array(ActivityFileSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentActivitySuccess = z.infer<typeof AgentActivitySuccessSchema>;

/**
 * Success response for
 * `GET /api/agent-burst-diff?agentId=<connId>&docName=<path>&stackIndex=<n>`.
 *
 * `diff` is unified-diff text (CommonMark-style — empty string when the
 * StackItem produces a no-op diff). `generatedAt` is the server's wall
 * clock at response-emit time; clients use it for staleness detection
 * against `bursts[].ts` (already returned by `/api/agent-activity`).
 */
export const AgentBurstDiffSuccessSchema = z
  .object({
    diff: z.string(),
    generatedAt: z.number().int().min(0),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentBurstDiffSuccess = z.infer<typeof AgentBurstDiffSuccessSchema>;

/**
 * Success response for `POST /api/test-reset?docName=<name>`,
 * `POST /api/test-rescan-backlinks`, and `POST /api/test-rescan-files`. All
 * three are dev-only routes and return an empty flat object on success — the
 * HTTP 200 status alone is the confirmation. `.loose()` preserves
 * forward-compat for adding diagnostic fields if needed (nothing relies on
 * emptiness today).
 */
export const TestResetSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type TestResetSuccess = z.infer<typeof TestResetSuccessSchema>;

export const TestRescanBacklinksSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type TestRescanBacklinksSuccess = z.infer<typeof TestRescanBacklinksSuccessSchema>;

export const TestRescanFilesSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type TestRescanFilesSuccess = z.infer<typeof TestRescanFilesSuccessSchema>;

/** Success body for `POST /api/test-flush-git` — flat empty object, same
 * dev-only test-route convention as the rescan siblings above. */
export const TestFlushGitSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type TestFlushGitSuccess = z.infer<typeof TestFlushGitSuccessSchema>;

/**
 * Success response for `GET /api/metrics/reconciliation`. Returns the raw
 * `ReconciliationMetrics` object from `packages/server/src/metrics.ts`
 * (~30 numeric counters + a `cc1LastSeq` map). The schema is intentionally
 * permissive — operators read fields by name and dashboards iterate the
 * counter map; pinning every field would force lockstep maintenance with
 * every counter addition without catching a real regression.
 */
export const MetricsReconciliationSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type MetricsReconciliationSuccess = z.infer<typeof MetricsReconciliationSuccessSchema>;

/**
 * Success response for `GET /api/metrics/parse-health`. Returns the raw
 * `ParseHealthMetrics` object from `packages/core/src/metrics/parse-health.ts`
 * (a mix of nested counters and per-descriptor records). Permissive for the
 * same reason as `MetricsReconciliationSuccessSchema`.
 */
export const MetricsParseHealthSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type MetricsParseHealthSuccess = z.infer<typeof MetricsParseHealthSuccessSchema>;

/** One agent-presence entry on `MetricsAgentPresenceSuccessSchema.presence`. */
export const AgentPresenceEntrySchema = z
  .object({
    displayName: z.string().min(1),
    icon: z.string(),
    color: z.string().min(1),
    currentDoc: z.string().nullable(),
    mode: z.enum(['idle', 'writing']),
    ts: z.number().int().min(0),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentPresenceEntryWire = z.infer<typeof AgentPresenceEntrySchema>;

/**
 * Success response for `GET /api/metrics/agent-presence`. Returns the
 * filtered presence map (entries within `BROADCASTER_EVICTION_MS` of the
 * server clock — same threshold the broadcaster uses). Loopback +
 * Host-allowlist gated; cross-origin / DNS-rebinding attempts are refused.
 */
export const MetricsAgentPresenceSuccessSchema = z
  .object({
    presence: z.record(z.string().min(1), AgentPresenceEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type MetricsAgentPresenceSuccess = z.infer<typeof MetricsAgentPresenceSuccessSchema>;

/**
 * Success response for `GET /api/installed-agents`. Returns a flat boolean
 * record keyed by agent scheme name (`claude` / `codex` / `cursor`). The
 * route is flat (no `ok: true` wrapper) because the consumer
 * (`probeViaFetch`'s `obj[key] === true` check) reads each scheme directly.
 *
 * `z.record(...)` is natively open — the value type's index signature
 * already admits arbitrary string keys. Adding a new scheme on the server
 * (e.g. `windsurf: true`) is wire-compatible with existing clients without
 * any schema-side migration. `.loose()` would be redundant on a record.
 */
export const InstalledAgentsSuccessSchema = z.record(z.string().min(1), z.boolean()).meta({
  description:
    'Flat boolean record keyed by agent-scheme name (claude / codex / cursor). True = installed.',
}) satisfies StandardSchemaV1;
export type InstalledAgentsSuccess = z.infer<typeof InstalledAgentsSuccessSchema>;

/**
 * Request body for `POST /api/spawn-cursor`. The renderer sends the
 * absolute filesystem path the user wants Cursor to open. The server
 * applies `isPathWithinDir` post-validation to confine to `contentDir`
 * (RFC 9457 `path-escape` 403 when the path escapes the workspace).
 */
export const SpawnCursorRequestSchema = z
  .object({
    path: z.string().min(1, 'path must be non-empty'),
  })
  .loose() satisfies StandardSchemaV1;
export type SpawnCursorRequest = z.infer<typeof SpawnCursorRequestSchema>;

/**
 * Success body for `POST /api/spawn-cursor`. Empty `{}` — HTTP 200 alone
 * confirms the spawn succeeded; any failure mode (not-installed / timeout /
 * spawn-failed) emits `application/problem+json` via `errorResponse(...)`
 * with the matching `urn:ok:error:cursor-*` URN. Renderer adapter at
 * `packages/app/src/lib/handoff/cursor-two-step.ts` translates problem+json
 * → `SpawnCursorOutcome` so dispatch stays transport-agnostic.
 */
export const SpawnCursorSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type SpawnCursorSuccess = z.infer<typeof SpawnCursorSuccessSchema>;
