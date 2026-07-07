/**
 * Shared client-side parser for RFC 9457 Problem Details error bodies.
 *
 * Single canonical site for direct-HTTP consumers — the client-side analog of
 * `normalizeResponse` in the MCP shim (`packages/server/src/mcp/tools/shared.ts`).
 * Routing every direct-HTTP consumer through this helper keeps the wire-format
 * coupling in one place: if the server-side envelope ever evolves (localized
 * messages, machine-readable extensions, etc.), the adaptation lands in the
 * helper, not at every call site.
 */

// Hand-rolled structural type rather than `z.infer<typeof ProblemDetailsSchema>`
// or `ProblemDetailsSchema.safeParse()` is intentional: this module is the
// lightweight extraction site (7 call sites) where pulling Zod into the
// consumer bundle for a single-field title-extraction would be wasteful.
// Heavier consumers (`parse-server-response.ts`, `useQuery`-style sites that
// branch on `.type`/`.instance`) use `ProblemDetailsSchema` directly. See
// the "Client-side error parsing" section in `packages/server/src/http/README.md`
// for the three-pattern taxonomy and when to use each.
interface RfcProblemBody {
  title?: unknown;
  detail?: unknown;
}

/**
 * Extract the most useful diagnostic string from an RFC 9457 problem+json body.
 *
 * Returns `body.title` (RFC 9457 §3.1.4 — "short, human-readable summary")
 * when present and non-empty. Returns `undefined` when the body isn't an
 * object, isn't RFC 9457-shaped, or carries an empty title — caller falls
 * back to `HTTP <status>` or another channel.
 *
 * Does NOT consume `body.detail` (the longer explanation, RFC 9457 §3.1.5).
 * Most consumers only need a short diagnostic; if a caller needs the longer
 * body, the helper can be extended without changing call sites that only
 * want the summary.
 */
export function parseApiError(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const candidate = body as RfcProblemBody;
  if (typeof candidate.title === 'string' && candidate.title.length > 0) {
    return candidate.title;
  }
  return undefined;
}
