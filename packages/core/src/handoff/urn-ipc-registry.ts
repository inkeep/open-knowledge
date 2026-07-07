/**
 * URN → (channel, reason) translation registry.
 *
 * Single source of truth for translating RFC 9457 problem-types
 * (`urn:ok:error:*` from `packages/core/src/schemas/api/_envelope.ts`) into
 * the typed IPC reason tokens that desktop channels speak.
 *
 * Why channel-keyed (not URN-keyed): the same HTTP URN can map to
 * different IPC reasons depending on which channel is consuming it. For
 * example, `urn:ok:error:path-escape` maps to:
 *   - `'invalid-path'` on `ok:shell:spawn-cursor` (cursor's 4-value reason union)
 *   - `'path-escape'` on `ok:shell:open-asset` (asset's 4-value reason union with literal `'path-escape'`)
 * A flat URN→reason map would conflate these. The channel-keyed shape
 * makes the binding explicit, and the meta-test coverage gate ensures
 * every URN has a deliberate decision recorded.
 *
 * Why a separate `URN_HTTP_ONLY` set: most URNs (e.g., upload-side errors,
 * local-op security gates, schema validation errors) have no desktop IPC
 * counterpart by design. Adding such a URN to a channel's mapping would
 * be wrong — but adding it to the registry under a fictional channel
 * would also be wrong. The Set captures "intentionally HTTP-only" so the
 * coverage meta-test can distinguish "no decision" (build fail) from
 * "no IPC counterpart" (passes).
 *
 * **Type-safety architecture (as-const data + derived union, validate at
 * boundaries and trust downstream):** the registry data is declared with
 * `as const satisfies RegistryDataShape` (a non-circular structural
 * constraint) so that the data site itself catches shape violations
 * (channel→reason map shape, reason values are strings) with localized
 * diagnostics — and the public `URN_IPC_REGISTRY: Registry = RAW_REGISTRY`
 * widening assignment below catches typo'd URN keys (because the target
 * `Registry` type binds keys to `ProblemType`). The two-step pattern
 * achieves both narrow-value preservation AND closed-key validation that
 * a single `as const` (no shape check) or a single typed `const` (no
 * narrow values) wouldn't:
 *
 *   1. The registry data IS the type — `IpcChannelReason<C>` is derived
 *      directly from `(typeof RAW_REGISTRY)[C]` values. A typo'd reason
 *      value (e.g., `'not-instaled'`) narrows `IpcChannelReason<C>` to
 *      include the typo and fails typecheck at the consumer's expected
 *      union (e.g., `cursor-two-step.ts`).
 *
 *   2. The lookup function is generic over the channel type — callers
 *      that pass `'ok:shell:spawn-cursor'` get a `UrnIpcLookup<'ok:shell:spawn-cursor'>`
 *      result whose `mapped.reason` is typed as the channel's actual
 *      4-value union (`'invalid-path' | 'not-installed' | 'timeout' |
 *      'spawn-error'`), NOT a wide `string`.
 *
 *   3. Consumers of `lookupUrnInRegistry` don't re-narrow at the call
 *      site — the boundary parse via `ProblemTypeSchema.safeParse` proves
 *      the input is a valid URN, and the typed registry result carries
 *      that proof forward. The previous design (with `IpcReason = string`)
 *      forced `cursor-two-step.ts` to do an `if (reason === 'invalid-path'
 *      || reason === ...)` chain — exactly the "narrow at call site"
 *      anti-pattern this design avoids.
 *
 * Wire-policy invariant: adding a URN to ProblemTypeSchema and
 * forgetting to update this file fails
 * `packages/app/tests/integration/urn-ipc-registry-coverage.test.ts`. The
 * meta-test is fail-on-any-occurrence.
 */

import type { ProblemType } from '../schemas/api/_envelope.ts';
import { ProblemTypeSchema } from '../schemas/api/_envelope.ts';

/**
 * Shape-only structural constraint for `RAW_REGISTRY`. Validates that each
 * channel maps URN-shaped keys to string reason values, WITHOUT widening
 * the narrow literal types that `as const` produces (that's the contract
 * `satisfies` provides — assignability check without type widening).
 *
 * Non-circular: this shape doesn't reference `RawRegistry` / `IpcChannelWithUrn`
 * / `IpcChannelReason<C>` (which would create a circular dependency since
 * those types are derived FROM `typeof RAW_REGISTRY`). It's a purely
 * structural shape that says "an object whose values are objects whose
 * values are strings."
 *
 * Catches at the data site:
 *   - Non-string reason value (e.g., `'urn:...': 42` would fail).
 *   - Non-object channel value (e.g., `'ok:shell:spawn-cursor': null` would fail).
 *   - Wrong nesting depth (flat string-to-string map without the channel layer).
 *
 * Does NOT catch at the data site (caught later, by the public-registry
 * assignment):
 *   - Typo'd URN keys (e.g., `'urn:ok:error:typoo'`) — `string` accepts any
 *     key string, so `Record<string, string>` doesn't bind URNs to
 *     `ProblemType`. The widening assignment `URN_IPC_REGISTRY: Registry =
 *     RAW_REGISTRY` rejects typo'd URNs because `Registry`'s value type is
 *     `Partial<Record<ProblemType, ...>>` which only admits known URNs.
 */
type RegistryDataShape = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Internal registry — narrow `as const satisfies RegistryDataShape` types,
 * used as the SOURCE of truth for both the public registry AND the derived
 * `IpcChannelReason<C>` per-channel union. Not exported; consumers use
 * `URN_IPC_REGISTRY` for runtime access (which has the same data but a
 * wider indexing type that admits any `ProblemType` key).
 *
 * The `satisfies` clause shape-checks the data at this site. Adding a
 * malformed reason value (e.g., `'urn:...': 42`) fails typecheck here;
 * typo'd URN keys are caught by the public-registry widening assignment
 * (because `Registry` requires keys to be `ProblemType`).
 */
const RAW_REGISTRY = {
  'ok:shell:spawn-cursor': {
    'urn:ok:error:cursor-not-installed': 'not-installed',
    'urn:ok:error:cursor-spawn-timeout': 'timeout',
    'urn:ok:error:cursor-spawn-failed': 'spawn-error',
    'urn:ok:error:invalid-request': 'invalid-path',
    'urn:ok:error:path-escape': 'invalid-path',
  },
  // Future channels with desktop IPC counterparts add entries here.
  // E.g., `ok:shell:open-asset` if the renderer ever needs to translate
  // an HTTP-side asset error to its IPC reason union.
} as const satisfies RegistryDataShape;

type RawRegistry = typeof RAW_REGISTRY;

/**
 * The set of IPC channels for which the registry has at least one URN
 * mapping. Derived from the raw registry's keys, so adding a new channel
 * to `RAW_REGISTRY` automatically widens this type.
 */
export type IpcChannelWithUrn = keyof RawRegistry;

/**
 * The reason union for a given channel — derived from the raw registry's
 * literal-typed values. For `'ok:shell:spawn-cursor'` this evaluates to
 * `'not-installed' | 'timeout' | 'spawn-error' | 'invalid-path'` (the four
 * distinct values currently in the cursor channel's map).
 *
 * Adding a new reason value to a channel's `RAW_REGISTRY` entry
 * automatically widens this type. Removing the last URN that maps to a
 * particular reason narrows it. The meta-test ensures the registry stays
 * exhaustive across `ProblemTypeSchema.options`.
 */
export type IpcChannelReason<C extends IpcChannelWithUrn> = RawRegistry[C][keyof RawRegistry[C]];

/**
 * Public registry type — same data as `RAW_REGISTRY`, but each channel's
 * value is widened to `Partial<Record<ProblemType, IpcChannelReason<C>>>`
 * so that callers can index by any URN and get `IpcChannelReason<C> |
 * undefined` (instead of a "key not in {5 specific URNs}" compile error).
 *
 * The narrow per-channel reason union (`IpcChannelReason<C>`) is preserved
 * on the value side — typed as the channel's literal union, not `string`.
 */
type Registry = {
  readonly [C in IpcChannelWithUrn]: Readonly<Partial<Record<ProblemType, IpcChannelReason<C>>>>;
};

/**
 * URN → IPC-reason mapping per channel — public surface. Same data as
 * `RAW_REGISTRY`, widened-key type so consumers can query by any
 * `ProblemType`.
 *
 * The assignment `URN_IPC_REGISTRY: Registry = RAW_REGISTRY` is sound
 * because:
 *   1. Each key in `RAW_REGISTRY[C]` is a valid `ProblemType` (verified
 *      by the structural fit — the keys are literal URN strings that
 *      ProblemTypeSchema's enum admits).
 *   2. Each value in `RAW_REGISTRY[C]` is structurally a member of
 *      `IpcChannelReason<C>` (because that's how the type is derived).
 *   3. `Partial<Record<ProblemType, X>>` permits a value with FEWER keys
 *      than the full ProblemType domain — the missing keys evaluate to
 *      undefined at runtime, which is exactly what the lookup function
 *      handles.
 *
 * No `as` cast is used — TypeScript validates the assignability at this
 * site.
 */
export const URN_IPC_REGISTRY: Registry = RAW_REGISTRY;

/**
 * URNs that have NO desktop IPC counterpart by design. Every URN in
 * ProblemTypeSchema.options must appear EITHER in at least one channel's
 * URN_IPC_REGISTRY entry OR in this set; the coverage meta-test fails the
 * build otherwise. Ordered by cluster to match `_envelope.ts` for diff
 * legibility.
 *
 * "HTTP-only" includes:
 *   - Upload-side errors: requests reach the HTTP boundary, no IPC channel
 *     binds the same operation (the desktop's file-import flow is a
 *     different code path with its own discriminated unions).
 *   - Local-op security gates: loopback / origin / host-allowlist refusals
 *     fire before the handler ever runs; IPC bypasses these gates.
 *   - Schema-validation errors that only surface on the HTTP wire: agent-
 *     write-md, frontmatter-patch, document CRUD shape errors. The IPC
 *     surface for these operations exists at a higher layer (Hocuspocus)
 *     where the discriminated unions are different.
 *   - Diagnostic-only URNs (`backlink-index-not-configured`, `tag-index-not-configured`,
 *     `shadow-not-configured`, `principal-not-available`, etc.) that are
 *     server-startup-state markers, not user-actionable IPC failures.
 */
export const URN_HTTP_ONLY: ReadonlySet<ProblemType> = new Set<ProblemType>([
  // Upload-side
  'urn:ok:error:malformed-upload',
  'urn:ok:error:collision-exhaustion',
  'urn:ok:error:storage-full',
  'urn:ok:error:storage-readonly',
  'urn:ok:error:storage-error',
  'urn:ok:error:no-file-received',
  // Cross-handler shared (path-escape is mapped via spawn-cursor; rest are HTTP-only)
  'urn:ok:error:method-not-allowed',
  'urn:ok:error:payload-too-large',
  'urn:ok:error:request-timeout',
  'urn:ok:error:internal-server-error',
  // Local-op security gates (fire before IPC; bypassed by IPC channels by design)
  'urn:ok:error:loopback-required',
  'urn:ok:error:invalid-origin',
  // Local-op clone (HTTP-only — desktop has dedicated ok:local-op:clone:start IPC channel
  // with its own free-form `error: string` shape; HTTP URNs map nowhere over IPC because
  // the IPC channel doesn't speak in URNs)
  'urn:ok:error:url-not-allowed',
  'urn:ok:error:dir-outside-home',
  'urn:ok:error:concurrent-operation',
  'urn:ok:error:clone-failed',
  'urn:ok:error:clone-timeout',
  'urn:ok:error:server-start-failed',
  // Cluster A — agent-write/-write-md/-patch/-undo (HTTP-only; no IPC counterpart for agent writes)
  'urn:ok:error:reserved-doc-name',
  'urn:ok:error:target-not-found',
  'urn:ok:error:stale-target',
  'urn:ok:error:frontmatter-edit-not-supported',
  'urn:ok:error:invalid-frontmatter-patch',
  // Refuses agent writes that introduce unparseable YAML into
  // the FM region. Fires from `applyAgentMarkdownWriteInner` at the same
  // HTTP write surfaces as `frontmatter-edit-not-supported` /
  // `invalid-frontmatter-patch` — no IPC counterpart.
  'urn:ok:error:frontmatter-malformed',
  'urn:ok:error:no-active-session',
  'urn:ok:error:too-many-agent-sessions',
  // Store-time disk-divergence revert (HTTP-only). Emitted by the
  // mutating write handlers (write / edit / frontmatter / undo / rollback) when
  // disk diverged and the overwrite was aborted; no IPC counterpart for agent writes.
  'urn:ok:error:disk-divergence',
  // Conflict-aware refusal (HTTP-only; the gate is enforced on the same
  // HTTP handlers that already lack IPC counterparts above — write /
  // edit / rollback / rename / delete / template / agent_undo).
  'urn:ok:error:doc-in-conflict',
  // 404 surfaced by handleSyncConflictContent when the conflict store
  // doesn't track the requested file. HTTP-only (same surface as the rest
  // of /api/sync/*).
  'urn:ok:error:no-conflict-tracked',
  // Cluster B — pages CRUD (HTTP-only; desktop binds CRUD via Hocuspocus, not IPC)
  'urn:ok:error:doc-not-found',
  'urn:ok:error:doc-already-exists',
  'urn:ok:error:doc-not-open',
  'urn:ok:error:rollback-not-configured',
  // Cluster C — read (HTTP-only diagnostic markers)
  'urn:ok:error:doc-not-available',
  'urn:ok:error:backlink-index-not-configured',
  // `file-rescan-not-configured` is emitted only by the test-only
  // `POST /api/test-rescan-files` endpoint — gated behind `enableTestRoutes`
  // and never reached via any IPC channel.
  'urn:ok:error:file-rescan-not-configured',
  // Cluster E — history (HTTP-only)
  'urn:ok:error:shadow-not-configured',
  'urn:ok:error:host-not-allowed',
  'urn:ok:error:principal-not-available',
  'urn:ok:error:not-found',
  // Cluster G — auth (HTTP-only; desktop has ok:local-op:auth:* with free-form error)
  'urn:ok:error:auth-failed',
  'urn:ok:error:no-project-dir',
  'urn:ok:error:server-open-failed',
  // Cluster H — sync + seed (seed has IPC counterpart but it speaks in `kind` enums, not URNs;
  // sync is HTTP-only)
  'urn:ok:error:sync-not-active',
  'urn:ok:error:project-repo-not-configured',
  'urn:ok:error:seed-prerequisite-missing',
  'urn:ok:error:seed-invalid-root',
  // Cluster I — tags/templates/asset (HTTP-only; assets have IPC channel but its reason union
  // is internally defined, not URN-derived)
  'urn:ok:error:tag-index-not-configured',
  'urn:ok:error:template-not-found',
  'urn:ok:error:unsupported-asset-type',
  'urn:ok:error:asset-not-found',
  // No-project single-file mode (`PUT /api/folder-config`, `PUT /api/template`
  // refusal). HTTP-only — there is no IPC counterpart, and single-file mode
  // never wires MCP/agent surfaces.
  'urn:ok:error:single-file-mode',
  // `ok ui` proxy (HTTP-only)
  'urn:ok:error:collab-server-not-running',
  'urn:ok:error:gateway-timeout',
  // `/api/handoff` (HTTP-only — both web and Electron renderers hit the same
  // HTTP endpoint; there's no IPC counterpart for the unified handoff
  // dispatcher because the renderer-side `dispatch.ts` `fetch()` works
  // identically in both modes against the embedded server. Cursor's
  // `spawn-cursor-*` URNs remain mapped above because `/api/spawn-cursor`
  // still has its sibling IPC channel.)
  'urn:ok:error:handoff-target-not-installed',
  'urn:ok:error:handoff-spawn-timeout',
  'urn:ok:error:handoff-spawn-failed',
]);

/**
 * Lookup result discriminated union, parameterized by the channel the
 * caller asked about. Three cases:
 *   - `mapped` — the URN has a defined translation for this channel. The
 *     `reason` field is typed as the channel's actual reason union
 *     (e.g., `'not-installed' | 'timeout' | ...` for spawn-cursor), not a
 *     wide `string`. Consumers can `return { ok: false, reason: lookup.reason }`
 *     directly.
 *   - `http-only` — the URN is intentionally HTTP-only; callers translating
 *     to an IPC-shaped result should use their channel's fallback reason
 *     (typically the same as the unknown case).
 *   - `unknown` — the input string is not a recognized URN OR is a known
 *     URN with no entry for the requested channel. Callers branch as
 *     needed; the registry's coverage meta-test ensures `unknown` cannot
 *     happen for a known URN that's mapped or HTTP-only.
 *
 * Switch consumers should terminate in `default: assertNeverUrnIpcLookup(...)`
 * to ensure adding a fourth case (e.g., 'deprecated') breaks every consumer
 * site at typecheck time.
 */
export type UrnIpcLookup<C extends IpcChannelWithUrn> =
  | { kind: 'mapped'; channel: C; reason: IpcChannelReason<C> }
  | { kind: 'http-only' }
  | { kind: 'unknown'; problemType: string };

/**
 * Resolve a URN+channel pair to its IPC reason translation, or to a
 * discriminated `http-only` / `unknown` result.
 *
 * Boundary discipline ("validate at boundaries, trust downstream"):
 *   - Input string is parsed through `ProblemTypeSchema.safeParse` at this
 *     boundary so callers don't need to pre-narrow.
 *   - Output type carries the proof forward: `mapped.reason` is typed as
 *     the channel's narrow reason union, NOT `string`. Callers can pass
 *     it directly to a typed `{ ok: false; reason }` discriminated-union
 *     return without re-checking literal values.
 *
 * No `as` casts in this implementation. The
 * `channelMap[known]` indexing types as `IpcChannelReason<C> | undefined`
 * naturally because the registry's `as const` declaration carries through
 * the channel's specific literal values.
 *
 * @param problemType — the URN string (typically from a server's
 *   `application/problem+json` `type` field). Untrusted input — parsed at
 *   the boundary.
 * @param channel — the IPC channel context the caller wants to translate
 *   into. Must be a key of URN_IPC_REGISTRY (compile-time constraint).
 */
export function lookupUrnInRegistry<C extends IpcChannelWithUrn>(
  problemType: string,
  channel: C,
): UrnIpcLookup<C> {
  const parsed = ProblemTypeSchema.safeParse(problemType);
  if (!parsed.success) {
    return { kind: 'unknown', problemType };
  }
  const known: ProblemType = parsed.data;
  // URN_IPC_REGISTRY is typed as `Registry` (above), so URN_IPC_REGISTRY[channel]
  // has type `Readonly<Partial<Record<ProblemType, IpcChannelReason<C>>>>` —
  // indexing by any ProblemType returns `IpcChannelReason<C> | undefined`
  // naturally. No `as` cast needed: the public registry's wider type IS
  // the indexing surface. The narrow data still drives `IpcChannelReason<C>`
  // because that type is derived from `RAW_REGISTRY` (the as-const source).
  const channelMap = URN_IPC_REGISTRY[channel];
  const reason = channelMap[known];
  if (reason !== undefined) {
    return { kind: 'mapped', channel, reason };
  }
  if (URN_HTTP_ONLY.has(known)) {
    return { kind: 'http-only' };
  }
  return { kind: 'unknown', problemType };
}

/**
 * Exhaustiveness helper for `UrnIpcLookup` switches. Named
 * `assertNever<TypeName>` to match the codebase convention — every other
 * per-DU helper follows the same shape (`assertNeverProblemType` in
 * `_envelope.ts`, `assertNeverLinkTarget` in `link-targets.ts`,
 * `assertNeverDiskEvent` in `file-watcher.ts`, the latter also being a
 * `kind`-discriminated struct DU; none use a discriminator-suffix in the
 * helper name).
 *
 * Throws if reached at runtime — adding a fourth `kind` to UrnIpcLookup
 * (e.g., `'deprecated'`) without updating every consumer's switch will
 * fail typecheck at each unhandled site, AND if a runtime value somehow
 * evades the type system (e.g., via `as` cast), this helper crashes
 * loudly rather than silently miscategorizing.
 */
export function assertNeverUrnIpcLookup(value: never): never {
  throw new Error(`Unhandled UrnIpcLookup: ${JSON.stringify(value)}`);
}
