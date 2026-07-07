/**
 * Cluster A: agent-write / -write-md / -patch / -undo
 *
 * Mutating handlers that write to Y.Docs through the agent attribution path
 * (precedent #24). `withValidation()` enforces these schemas at the wire
 * boundary; the handler receives an already-typed body. Body-shape failures
 * (schema rejection) emit `urn:ok:error:invalid-request` PRE-identity —
 * semantically OK because no Y.Doc mutation is attempted. Semantic failures
 * (reserved docname, target-not-found, stale-target, no-active-session) emit
 * POST-identity. The `attribution-sweep-coverage.test.ts` ordering check
 * enforces this distinction.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { SUPPORTED_DOC_EXTENSIONS } from '../../constants/doc-extensions.ts';

import { FRONTMATTER_TYPES, FrontmatterValueSchema } from '../../frontmatter/schema.ts';
import { agentIdentityFields, safeDocNameField, summaryField } from './_shared.ts';

/**
 * Request body for `POST /api/agent-write`. Free-text content append (the
 * server appends a deterministic test string when `content` is omitted).
 */
export const AgentWriteRequestSchema = z
  .object({
    docName: safeDocNameField,
    summary: summaryField,
    content: z.string().optional(),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteRequest = z.infer<typeof AgentWriteRequestSchema>;

/**
 * Request body for `POST /api/agent-write-md`. The canonical agent-write
 * surface. `markdown` is REQUIRED (the key must be present) but MAY be the
 * empty string: `position: "replace"` with empty `markdown` clears the
 * document body (the write path preserves existing frontmatter). No `.min(1)`
 * — it never actually prevented clears (whitespace satisfied it, so a single
 * space was a working sentinel) while blocking the legitimate empty-clear and
 * surfacing only a generic "invalid request" to the caller. `position` is the
 * enum the handler routes on.
 */
export const AgentWriteMdRequestSchema = z
  .object({
    docName: safeDocNameField,
    summary: summaryField,
    markdown: z.string(),
    position: z.enum(['append', 'prepend', 'replace']).optional(),
    // Explicit on-disk extension, honored only when the doc does not yet
    // exist (a pure create) — lets a caller author a `.mdx` file instead of
    // the `.md` default. For an existing doc the recorded extension wins
    // (switching it would orphan the old file); in-place extension change is
    // not available via the MCP today.
    extension: z.enum(SUPPORTED_DOC_EXTENSIONS).optional(),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteMdRequest = z.infer<typeof AgentWriteMdRequestSchema>;

/**
 * Request body for `POST /api/agent-patch`. `find` REQUIRED non-empty (the
 * search target). `replace` REQUIRED string (may be empty — that deletes
 * the matched segment). `offset`, when provided, must be a non-negative
 * integer; the handler treats it as the exact starting index for the
 * find/replace and emits `urn:ok:error:stale-target` if the substring at
 * that offset no longer matches.
 */
export const AgentPatchRequestSchema = z
  .object({
    docName: safeDocNameField,
    summary: summaryField,
    find: z.string().min(1),
    replace: z.string(),
    offset: z.number().int().nonnegative().optional(),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentPatchRequest = z.infer<typeof AgentPatchRequestSchema>;

/**
 * Request body for `POST /api/agent-undo`. `connectionId` REQUIRED — names
 * the per-session UndoManager whose stack to drain. `scope` defaults to
 * `'last'`; `'file'` is a legacy alias for `'session'` (drains the entire
 * stack in one call) — the handler collapses `'file'` to `'session'` in
 * the response.
 */
export const AgentUndoRequestSchema = z
  .object({
    docName: safeDocNameField,
    connectionId: z.string().min(1),
    scope: z.enum(['last', 'session', 'file']).optional(),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentUndoRequest = z.infer<typeof AgentUndoRequestSchema>;

/**
 * Sub-schema for the optional `summary` field on every mutating-handler
 * success response. `truncatedFrom` and `hint` only appear when the
 * server applied the 80-char cap — `summaryResponseFields` derives the
 * shape from `NormalizedSummary`.
 */
export const SummaryResponseFieldSchema = z
  .object({
    value: z.string(),
    truncatedFrom: z.number().int().nonnegative().optional(),
    hint: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SummaryResponseField = z.infer<typeof SummaryResponseFieldSchema>;

/**
 * The converged document content carried inline on a content-divergence
 * warning so the agent recovers WITHOUT a second `exec("cat …")` read.
 * `inline` carries the full post-write bytes; `truncated` (over the soft cap)
 * carries only the byte length + a re-read hint.
 */
export const ContentDivergenceCurrentStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), content: z.string() }),
  z.object({
    kind: z.literal('truncated'),
    byteLength: z.number().int().nonnegative(),
    hint: z.string(),
  }),
]);
export type ContentDivergenceCurrentState = z.infer<typeof ContentDivergenceCurrentStateSchema>;

/**
 * Post-write content-divergence warning emitted by `handleAgentWriteMd`,
 * `handleAgentPatch`, and `handleRollback` when the converged `Y.Text` does
 * not match the bytes the write composed to. Fires when
 * the primitive contract was violated (regression class) or — in the future —
 * when post-transact peer ops have already produced visible residue
 * (cross-time mutation).
 *
 * `byteDelta = actualBytes - intendedBytes` (signed). When `currentState` is
 * present with `kind: 'inline'`, the agent recovers from it directly — no
 * re-read needed; with `kind: 'truncated'` (over the soft cap) a re-read is
 * required. The gate is observational, not blocking — the underlying write
 * still landed; the warning surfaces that what landed differs from intent.
 */
export const ContentDivergenceWarningSchema = z
  .object({
    kind: z.literal('content-divergence'),
    intendedBytes: z.number().int().nonnegative(),
    actualBytes: z.number().int().nonnegative(),
    byteDelta: z.number().int(),
    /**
     * Coarse classification of the divergence — `<position>-content-mismatch`
     * (e.g. `replace-content-mismatch`, `patch-content-mismatch`,
     * `rollback-content-mismatch`). Open string at the wire so new values
     * don't break agents that pattern-match on it.
     */
    divergenceType: z.string().optional(),
    /** Converged content inline (or a truncation marker over the soft cap). */
    currentState: ContentDivergenceCurrentStateSchema.optional(),
    hint: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type ContentDivergenceWarning = z.infer<typeof ContentDivergenceWarningSchema>;

/**
 * Orphan-hint emitted by `handleAgentWriteMd` when the just-written doc has
 * no backlinks and at least one plausible hub candidate exists in its
 * folder tree. Soft signal — the agent is free to ignore.
 */
export const OrphanHintSchema = z
  .object({
    type: z.literal('orphan'),
    parentCandidates: z.array(z.string()),
    message: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type OrphanHint = z.infer<typeof OrphanHintSchema>;

/**
 * Disk-edit-reconciled warning — a sibling variant to
 * `ContentDivergenceWarningSchema` above on the shared `warning` channel. The
 * write LANDED, but an out-of-band disk edit was reconciled into the document
 * (L1 reconcile-before-write) before the agent's edit applied on top, so the
 * document now reflects that edit plus the agent's; the agent should re-read
 * before continuing.
 *
 * Distinct from `content-divergence` (composed bytes ≠ converged bytes,
 * a primitive-faithfulness gate): this fires when the BASE moved out of band,
 * which the in-transact composed-vs-converged gate structurally cannot detect
 * (by the time it compares, the handler has already composed from the
 * reconciled base, so composed == converged).
 *
 * `byteDelta = actualBytes - intendedBytes` (signed): `intendedBytes` is the
 * base the agent thought it was editing, `actualBytes` is the divergent disk
 * content that was folded in. `.loose()` + optional on the success bodies so
 * older clients ignore it.
 */
export const DiskEditReconciledWarningSchema = z
  .object({
    kind: z.literal('disk-edit-reconciled'),
    intendedBytes: z.number().int().nonnegative(),
    actualBytes: z.number().int().nonnegative(),
    byteDelta: z.number().int(),
    /**
     * How the out-of-band edit was folded in — `clean` (the loaded CRDT had
     * no un-flushed edits; disk ingested as-is) or `merged` (a three-way
     * block merge preserved concurrent un-flushed CRDT edits alongside the
     * disk edit). Open string at the wire, like `divergenceType`, so new
     * values don't break agents that pattern-match on it.
     */
    mergeOutcome: z.string().optional(),
    hint: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type DiskEditReconciledWarning = z.infer<typeof DiskEditReconciledWarningSchema>;

/**
 * The `warning` channel on a mutating-write success body: either
 * post-write `content-divergence` (composed bytes ≠ converged bytes) or
 * `disk-edit-reconciled` (an out-of-band disk edit folded in before the write).
 * Discriminated on `kind`; additive + optional so older clients ignore it.
 */
export const WriteWarningSchema = z.discriminatedUnion('kind', [
  ContentDivergenceWarningSchema,
  DiskEditReconciledWarningSchema,
]);
export type WriteWarning = z.infer<typeof WriteWarningSchema>;

/**
 * Advisory render-validation warning: a mermaid fence in the post-write
 * document state fails `mermaid.parse` and will show the editor's error
 * chrome instead of a diagram. Emitted by `handleAgentWriteMd` and
 * `handleAgentPatch` on the post-write body — so a pre-existing broken fence
 * also surfaces on the next body write/edit to that doc, with the locator
 * fields (`fenceIndex`/`fenceFirstLine`) disambiguating which fence failed.
 *
 * Strictly advisory: the write landed byte-faithfully regardless (storage
 * never sanitizes). `kind` is the extension point for future
 * render-validating fence types; one write can carry several broken fences
 * (bounded server-side), so these ride the plural `warnings` channel.
 */
export const RenderWarningSchema = z
  .object({
    kind: z.literal('mermaid-parse-error'),
    /** 1-based ordinal among the mermaid fences of the post-write body. */
    fenceIndex: z.number().int().positive(),
    /** First non-empty line of the fence body (e.g. "sequenceDiagram"). */
    fenceFirstLine: z.string(),
    /** Mermaid's own error text (bounded), so agent and reader see the same vocabulary. */
    message: z.string(),
    /** Line number within the fence body, when mermaid's message carries one. */
    line: z.number().int().positive().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type RenderWarning = z.infer<typeof RenderWarningSchema>;

/**
 * Unified advisory channel on mutating-write success bodies: every advisory
 * the write produced, discriminated by `kind`. Two families with different
 * remedies coexist here — write-integrity entries (`content-divergence`,
 * `disk-edit-reconciled`: what landed differs from what you composed, or the
 * base moved out-of-band; remedy = re-read) and content-renderability
 * entries (`mermaid-parse-error`: the write landed byte-faithfully but that
 * fence will not render; remedy = fix the fence and re-edit).
 *
 * Plural by design: advisories legitimately co-occur (an out-of-band
 * reconcile and a broken fence can land on the same write) and render
 * warnings are per-fence. Unlike the single-valued `warning` field this
 * supersedes, no entry ever masks another — the deprecated `warning` keeps
 * emitting its highest-precedence integrity entry in parallel for one
 * deprecation window, but new consumers read `warnings`.
 */
export const AdvisoryWarningSchema = z.discriminatedUnion('kind', [
  ContentDivergenceWarningSchema,
  DiskEditReconciledWarningSchema,
  RenderWarningSchema,
]);
export type AdvisoryWarning = z.infer<typeof AdvisoryWarningSchema>;

/** min(1) encodes the server invariant: the field is absent rather than `[]`. */
export const AdvisoryWarningsSchema = z.array(AdvisoryWarningSchema).min(1);

/**
 * The reason an outbound link fails to resolve. Single source of truth for
 * BOTH the Zod wire enum below AND the server-side type (derived in
 * `backlink-index.ts`), so the two can never drift — a drift would let the
 * extractor produce a reason the parser's `safeParse` then silently drops.
 *
 * - `no-such-doc` — the href resolved to a content-root docName but no such
 *   doc exists (a `.md`/`.mdx` link, or an extensionless path).
 * - `no-such-file` — the href resolved to a non-doc file path inside the
 *   content root (a linked asset or source file — anything with a non-md/mdx
 *   extension), but nothing exists there on disk.
 * - `unresolvable` — the href can't resolve to any location: empty, or a
 *   relative path that escapes the content root via `../` (the off-by-one
 *   depth footgun — the dominant real-world break).
 */
export const BROKEN_LINK_REASONS = ['no-such-doc', 'no-such-file', 'unresolvable'] as const;
export type BrokenLinkReason = (typeof BROKEN_LINK_REASONS)[number];

/**
 * One unresolved outbound link in a just-written doc — the entries of the
 * `brokenLinks` field on write/edit success bodies (write-time link
 * validation).
 *
 * Report-only: the write always landed regardless (storage never rejects on a
 * broken link, so authoring a doc before its link target exists is legitimate
 * and must not be blocked). `href` is the link exactly as the author wrote it
 * (a markdown href like `./wiki/x`, or the reconstructed `[[Page]]` form for a
 * wiki link), so the agent can grep for it and fix it. `resolvedTo` is the
 * path the href pointed at but which doesn't exist — a content-root docName
 * (`reason: 'no-such-doc'`) or a content-root file path (`reason:
 * 'no-such-file'`, for linked assets / source files) — or `null` when the href
 * can't resolve to any location at all (`reason: 'unresolvable'` — an empty
 * href, or a relative path that escapes the content root). `.loose()` keeps
 * room for a future per-entry nearest-match `suggestion` without a
 * schema-breaking change.
 */
export const BrokenLinkSchema = z
  .object({
    href: z.string(),
    resolvedTo: z.string().nullable(),
    reason: z.enum(BROKEN_LINK_REASONS),
  })
  .loose() satisfies StandardSchemaV1;
export type BrokenLink = z.infer<typeof BrokenLinkSchema>;

/**
 * The `brokenLinks` field shared by write/edit (and batch per-doc) success
 * bodies. Unlike the optional `warnings`/`hints` channels, this is **always
 * present** — an empty array is the positive "all outbound links resolve"
 * confirmation an agent reads in the same response, replacing the separate
 * `links({ kind: 'dead' })` round-trip.
 */
export const BrokenLinksSchema = z.array(BrokenLinkSchema);

/** Success body for `POST /api/agent-write`. Flat shape (no `ok: true`). */
export const AgentWriteSuccessSchema = z
  .object({
    timestamp: z.string().min(1),
    summary: SummaryResponseFieldSchema.optional(),
    /** @deprecated Read `warnings` — kept emitting in parallel for one deprecation window. */
    warning: WriteWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteSuccess = z.infer<typeof AgentWriteSuccessSchema>;

/**
 * Success body for `POST /api/agent-write-md`. `subscriberCount` and
 * `systemSubscriberCount` drive the once-per-session preview-attach hint
 * contract; `hints` carries the orphan nudge.
 */
export const AgentWriteMdSuccessSchema = z
  .object({
    timestamp: z.string().min(1),
    subscriberCount: z.number().int().nonnegative(),
    systemSubscriberCount: z.number().int().nonnegative(),
    hints: z.array(OrphanHintSchema).optional(),
    summary: SummaryResponseFieldSchema.optional(),
    /** @deprecated Read `warnings` — kept emitting in parallel for one deprecation window. */
    warning: WriteWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
    /** Write-time outbound-link validation. Always present, `[]` when all links resolve. */
    brokenLinks: BrokenLinksSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteMdSuccess = z.infer<typeof AgentWriteMdSuccessSchema>;

/** Success body for `POST /api/agent-patch`. */
export const AgentPatchSuccessSchema = z
  .object({
    timestamp: z.string().min(1),
    subscriberCount: z.number().int().nonnegative(),
    systemSubscriberCount: z.number().int().nonnegative(),
    summary: SummaryResponseFieldSchema.optional(),
    /** @deprecated Read `warnings` — kept emitting in parallel for one deprecation window. */
    warning: WriteWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
    /** Write-time outbound-link validation. Always present, `[]` when all links resolve. */
    brokenLinks: BrokenLinksSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentPatchSuccess = z.infer<typeof AgentPatchSuccessSchema>;

/**
 * Success body for `POST /api/agent-undo`. `scope` reflects the resolved
 * scope after collapsing `'file'` → `'session'`. `undone` is `false` when
 * the UM stack was empty (a no-op undo).
 */
export const AgentUndoSuccessSchema = z
  .object({
    docName: z.string().min(1),
    scope: z.enum(['last', 'session']),
    undone: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentUndoSuccess = z.infer<typeof AgentUndoSuccessSchema>;

/**
 * Request body for `POST /api/frontmatter-patch`. Merge-patch semantics apply
 * at the TOP-LEVEL key only: a top-level key mapped to `null` deletes that
 * property; any other value sets or creates the key. Values may be scalar
 * (string | number | boolean), a scalar array, a nested object, or an array of
 * objects — the recursive `FrontmatterValueSchema` accepts arbitrary depth.
 *
 * Nested values are NOT recursively deep-merged (a deliberate deviation from
 * RFC 7396, which would merge nested objects key-by-key): a nested object at a
 * top-level key REPLACES that key's value wholesale, so sibling nested keys
 * absent from the patch value are dropped. To change one nested leaf, send the
 * FULL subtree for its top-level key; to delete one nested leaf, send the full
 * subtree without it; to drop a whole subtree, null out the top-level key. (A
 * `null` nested INSIDE a subtree value is rejected.) The handler validates
 * every entry atomically — if any key fails, the whole patch rejects with HTTP
 * 400 + per-key `fieldErrors`.
 *
 * `types` is shape-validated for forward-compat but not persisted today.
 */
export const FrontmatterPatchRequestSchema = z
  .object({
    docName: safeDocNameField,
    patch: z.record(z.string(), z.union([FrontmatterValueSchema, z.null()])),
    types: z.record(z.string(), z.enum(FRONTMATTER_TYPES)).optional(),
    summary: summaryField,
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type FrontmatterPatchRequest = z.infer<typeof FrontmatterPatchRequestSchema>;

/** Success body for `POST /api/frontmatter-patch`. */
export const FrontmatterPatchSuccessSchema = z
  .object({
    timestamp: z.string().min(1),
    subscriberCount: z.number().int().nonnegative(),
    systemSubscriberCount: z.number().int().nonnegative(),
    appliedKeys: z.array(z.string()),
    summary: SummaryResponseFieldSchema.optional(),
    /** @deprecated Read `warnings` — kept emitting in parallel for one deprecation window. */
    warning: WriteWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
    /**
     * Write-time outbound-link validation. Always present, `[]` when all
     * links resolve. A frontmatter merge-patch leaves the body untouched, so
     * these reflect the doc's current body links — the `edit` tool surfaces the
     * same signal whether you patched the body or the frontmatter.
     */
    brokenLinks: BrokenLinksSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type FrontmatterPatchSuccess = z.infer<typeof FrontmatterPatchSuccessSchema>;
