/**
 * Zod-typed shape of the JSON token browsers and agent clients send in the
 * Hocuspocus WebSocket `token` field. Every `onAuthenticate` hook that parses
 * a token MUST route through `HocuspocusAuthTokenSchema.safeParse` — never
 * call `JSON.parse` + ad-hoc field checks.
 *
 * Design decisions:
 *
 * - **All fields optional.** Legacy clients and test harnesses that never
 *   set a token (or set a minimal token) must continue to authenticate
 *   cleanly. A parse error or a fully-optional schema both lead to the
 *   same `principalId: undefined` path downstream.
 *
 * - **`.loose()` (v4 idiom for v3's `.passthrough()`).** Unknown fields
 *   are preserved rather than stripped so a new client sending an
 *   undiscovered field against an old server doesn't lose information
 *   (forward-compat). Equally, old clients omitting newer fields hit the
 *   `.optional()` branches (backward-compat).
 *
 * - **String types, not branded.** `principalId`/`tabSessionId`/
 *   `expectedServerInstanceId` are transport-layer identifiers; they are
 *   consumed immediately by the auth hook and don't travel further. Zod
 *   branding earns its weight on long-lived domain types, not on
 *   here-and-gone auth payloads.
 *
 * - **Schema IS the single source of truth.** `HocuspocusAuthToken` is
 *   `z.infer<typeof HocuspocusAuthTokenSchema>` — adding a field to the
 *   schema automatically picks up in the type.
 *
 * Fields:
 * - `principalId` — browser-principal identity (stable UUID from
 *   `.ok/local/principal.json`). Empty/absent → write falls through
 *   to SERVICE_WRITER attribution.
 * - `tabSessionId` — per-tab UUID, generated once at tab open. Used by the
 *   server only for telemetry/correlation today.
 * - `expectedServerInstanceId` — defense-in-depth for the CRDT clientID-
 *   mismatch bug class. Clients cache the last-observed server instance ID
 *   and claim it on every reconnect; server rejects on mismatch so a
 *   stale-client reconnect is recycled BEFORE Yjs sync can merge.
 * - `expectedBranch` — late-join backstop for the cross-branch invalidation
 *   flow. Mirrors `expectedServerInstanceId`. Clients cache the last
 *   observed branch (boot HTTP fetch + CC1 server-info) and claim it on
 *   every reconnect; server rejects with `reason: 'branch-mismatch'` on
 *   non-empty mismatch so a client reconnecting after a branch switch they
 *   missed (offline window, fresh tab restored from stale IDB) is forced
 *   through `handleBranchSwitched` BEFORE Yjs sync can union-merge stale
 *   branch state. Empty / absent claims are accepted (legacy / non-git).
 * - `expectedDocLineageEpoch` — per-doc lineage fence, the third axis of
 *   the stale-client-persistence defense (instance → branch → doc
 *   lineage). The server mints a fresh lineage epoch into the doc's
 *   `lifecycle` Y.Map whenever persistence seeds it from disk; clients
 *   record the epoch they synced per doc and claim it on reconnect. The
 *   `doc-lineage-guard` extension rejects with
 *   `reason: 'doc-lineage-mismatch'` when the claim doesn't match the
 *   live doc's epoch — including when the doc is currently unloaded,
 *   where any claim is stale by construction because the next load
 *   re-mints. Rejection lands BEFORE Yjs sync can union-merge stale
 *   client-persisted state into the fresh lineage. Empty / absent claims
 *   are accepted (legacy clients; post-recovery reopens).
 * - `clientProtocolVersion` / `clientRuntimeVersion` / `clientKind` — the
 *   connecting client's own version metadata (the WS carrier of the v1 wire
 *   contract; see `@inkeep/open-knowledge-core` `clientVersionTokenFields`).
 *   Present on every browser/desktop-renderer connect. The server does not
 *   read them today; a future spec validates them in `onAuthenticate`.
 */
import { LINEAGE_EPOCH_KEY } from '@inkeep/open-knowledge-core';
import { z } from 'zod';

export const HocuspocusAuthTokenSchema = z
  .object({
    // String fields are NOT `.min(1)` — empty fields are treated as
    // "absent" by individual consumers, but the rest of a partial token
    // (`{principalId, tabSessionId, expectedServerInstanceId: ''}`) must
    // still parse so the principal claim flows through. Schema-level
    // `.min(1)` would discard every field of such tokens.
    principalId: z.string().optional(),
    tabSessionId: z.string().optional(),
    expectedServerInstanceId: z.string().optional(),
    expectedBranch: z.string().optional(),
    expectedDocLineageEpoch: z.string().optional(),
    // Client version metadata — the WS carrier of the v1 wire contract. Every
    // browser/desktop-renderer connect now sends these (so the token is always
    // present, even for an anonymous tab). The server is read-blind today; a
    // future spec reads them in `onAuthenticate` to refuse an incompatible
    // client. `clientKind` is `z.string()` (not an enum) so a future client-
    // kind never fails an older server's parse — forward-compat by design.
    clientProtocolVersion: z.number().optional(),
    clientRuntimeVersion: z.string().optional(),
    clientKind: z.string().optional(),
  })
  .loose();

export type HocuspocusAuthToken = z.infer<typeof HocuspocusAuthTokenSchema>;

// Re-exported from `@inkeep/open-knowledge-core` so `./auth-token-schema.ts`
// consumers (persistence.ts, doc-lineage-guard.ts) and the server barrel keep
// their import paths. Canonical definition lives in core's browser+Node
// constants module — the client provider-pool imports it from there directly,
// keeping the server package (and its native file-watcher deps) out of the
// client bundle graph.
export { LINEAGE_EPOCH_KEY };

/**
 * Reasons the server may attach to an `Error` thrown from `onAuthenticate`.
 * Hocuspocus surfaces the `reason` field to the client as the second
 * argument of `provider.on('authenticationFailed', ({ reason }) => …)`.
 *
 * Defining the union as a const-string and the carrier as a typed
 * subclass closes the cross-process drift gap: a rename on either side
 * now fails the TypeScript build instead of silently letting the client
 * see `reason: undefined` and skipping its recycle path.
 */
export const HOCUSPOCUS_AUTH_REJECTION_REASONS = [
  'server-instance-mismatch',
  'branch-mismatch',
  'rename-redirect',
  'doc-deleted',
  'doc-lineage-mismatch',
] as const;
export type HocuspocusAuthRejectionReason = (typeof HOCUSPOCUS_AUTH_REJECTION_REASONS)[number];

/**
 * Trust-boundary type guard for wire-foreign reason strings. The
 * Hocuspocus provider emits `reason: string` from
 * `provider.on('authenticationFailed', ...)` — a future server-side
 * addition (e.g. `principal-revoked`) would silently fall through an
 * `as` cast. Callers should narrow before switching so unknown reasons
 * surface as observable structured warns instead of silent no-ops.
 */
export function isHocuspocusAuthRejectionReason(
  reason: string,
): reason is HocuspocusAuthRejectionReason {
  return (HOCUSPOCUS_AUTH_REJECTION_REASONS as readonly string[]).includes(reason);
}

const WIRE_PAYLOAD_SEPARATOR = ':';

/**
 * Encode an auth-rejection kind plus optional payload into the single
 * varString that Hocuspocus's PermissionDenied frame carries (the
 * framework reads `error.reason` and forwards it verbatim — see
 * `@hocuspocus/server` `writePermissionDenied`).
 *
 * Wire format: `<kind>` when payload is absent or empty, `<kind>:<payload>`
 * otherwise. Splitting is on the FIRST colon so a payload that itself
 * contains `:` (docNames are not byte-restricted) round-trips intact.
 *
 * Empty-string payload is treated as absent so callers can pass through
 * uncertain values (`payload ?? undefined`) without producing an
 * unparseable trailing colon.
 */
export function formatAuthRejectionWire(
  kind: HocuspocusAuthRejectionReason,
  payload?: string,
): string {
  if (typeof payload !== 'string' || payload.length === 0) return kind;
  return `${kind}${WIRE_PAYLOAD_SEPARATOR}${payload}`;
}

/**
 * Decode a wire reason string emitted by the server into its kind +
 * optional payload. Returns `kind: null` when the prefix is not in
 * `HOCUSPOCUS_AUTH_REJECTION_REASONS` so callers (notably the client-side
 * `authenticationFailed` switch) can fall through to a structured warn
 * instead of mis-dispatching on a future server-side addition.
 *
 * Round-trip identity holds: `parseAuthRejectionWire(formatAuthRejectionWire(k, p))`
 * returns `{ kind: k, payload: p && p.length > 0 ? p : undefined }` for
 * every known kind.
 */
export function parseAuthRejectionWire(wire: string): {
  kind: HocuspocusAuthRejectionReason | null;
  payload: string | undefined;
} {
  if (wire.length === 0) return { kind: null, payload: undefined };
  const colonIdx = wire.indexOf(WIRE_PAYLOAD_SEPARATOR);
  const candidateKind = colonIdx === -1 ? wire : wire.slice(0, colonIdx);
  if (!isHocuspocusAuthRejectionReason(candidateKind)) {
    return { kind: null, payload: undefined };
  }
  if (colonIdx === -1) {
    return { kind: candidateKind, payload: undefined };
  }
  const rawPayload = wire.slice(colonIdx + 1);
  return {
    kind: candidateKind,
    payload: rawPayload.length > 0 ? rawPayload : undefined,
  };
}

export class HocuspocusAuthRejection extends Error {
  readonly kind: HocuspocusAuthRejectionReason;
  readonly payload: string | undefined;
  readonly reason: string;

  constructor(kind: HocuspocusAuthRejectionReason, message: string, payload?: string) {
    super(message);
    this.name = 'HocuspocusAuthRejection';
    this.kind = kind;
    this.payload = typeof payload === 'string' && payload.length > 0 ? payload : undefined;
    this.reason = formatAuthRejectionWire(kind, this.payload);
  }
}

/**
 * Parse a token string into the typed shape. Returns `undefined` on any
 * parse failure (malformed JSON, schema mismatch) — callers should treat
 * `undefined` identically to "no token provided" per the existing legacy
 * compatibility path.
 *
 * Using a dedicated helper (rather than inlining `safeParse`) keeps the
 * error-swallow behavior consistent across every consumer.
 */
export function parseHocuspocusAuthToken(
  tokenStr: string | undefined | null,
): HocuspocusAuthToken | undefined {
  if (typeof tokenStr !== 'string' || tokenStr.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tokenStr);
  } catch {
    return undefined;
  }
  const result = HocuspocusAuthTokenSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}
