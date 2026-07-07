/**
 * Two-step boundary parser for direct-HTTP server responses.
 *
 * Step 1 — `parseServerResponse(res, fallback)`: shape-discriminate on the
 * HTTP status. 2xx returns `{ ok: true, body }` with the raw JSON record so
 * the caller can apply a per-handler success schema. 4xx/5xx returns
 * `{ ok: false, title }` where `title` is the RFC 9457 problem+json `title`
 * (via `parseApiError`) or the caller's fallback when the body isn't
 * RFC 9457-shaped. A body read aborted by the caller's own `AbortSignal`
 * rejects with the original `AbortError` instead of returning — cancellation
 * is never representable in the return value, mirroring how an abort before
 * headers rejects `fetch()` itself.
 *
 * Step 2 — `parseSuccessOrWarn(schema, body, handler, fallback)`: apply a
 * per-handler success schema to the body returned by step 1. On schema
 * drift (server emits a shape the client doesn't recognize), `console.warn`
 * the divergence and return the caller's typed fallback. Mid-mutation flows
 * (rename / delete / create) cannot recover from a thrown parse error
 * mid-transaction — the server already committed the operation. The
 * fallback keeps the UI consistent while making the schema drift loud
 * rather than silent.
 *
 * Single canonical site for the wire-shape parser. Both `FileTree`
 * and `EditorTabs` (and any future consumer of mutating endpoints) route
 * through this module so the parsing convention stays uniform.
 */

import type { z } from 'zod';
import { parseApiError } from './parse-api-error.ts';

export async function parseServerResponse(
  res: Response,
  fallbackErrorTitle: string,
): Promise<{ ok: true; body: unknown } | { ok: false; title: string }> {
  let body: unknown = null;
  let parseErr: unknown;
  try {
    body = await res.json();
  } catch (err) {
    parseErr = err;
  }
  // A client-initiated abort landing mid-body-read is a cancellation, not a
  // wire outcome: rethrow before any status branching so it surfaces to the
  // caller exactly like an abort before headers rejects `fetch()` itself —
  // one abort channel, routing into the caller's existing abort guard —
  // rather than being laundered into the 204-shaped `{ok: true, body: null}`
  // (2xx) or a server-error title (4xx/5xx). Detection is by the WebIDL
  // `DOMException.name`, the same discriminator `api-config.ts` and
  // `show-all-stream.ts` use; a future `AbortSignal.timeout()` consumer
  // (`TimeoutError`) would not be caught here.
  if (parseErr instanceof Error && parseErr.name === 'AbortError') {
    throw parseErr;
  }
  // 2xx with non-JSON body (e.g., 204 No Content from a DELETE-style
  // endpoint) is a success, not an error. The HTTP status is the
  // canonical wire-level success/error discriminator; body shape only
  // matters when there's a body to parse. Surface as `{ok: true, body: null}`
  // so callers route through their success path (typically
  // `parseSuccessOrWarn` with a per-endpoint fallback) rather than
  // showing a spurious error toast.
  if (res.ok) {
    if (parseErr !== undefined) {
      // Surface the actual root cause (non-JSON body at a JSON endpoint —
      // e.g., misconfigured reverse proxy returning HTML, OOM truncating
      // mid-stream) so an engineer debugging downstream sees the transport
      // issue instead of investigating fictitious schema drift in
      // `parseSuccessOrWarn`'s fallback path. Asymmetric with the 4xx/5xx
      // branch below which already includes parseErr in the title.
      console.warn(
        '[parse-server-response] 2xx response with non-JSON body:',
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
    }
    return { ok: true, body: parseErr === undefined ? body : null };
  }
  // 4xx/5xx with non-JSON body: forward the parse-error detail so the
  // UI can distinguish "truncated body" from "non-JSON content-type" —
  // matches the MCP-side `httpGet`/`httpPost` pattern in
  // `packages/server/src/mcp/tools/shared.ts`.
  if (parseErr !== undefined) {
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return { ok: false, title: `Server error (HTTP ${res.status}): ${detail}` };
  }
  return { ok: false, title: parseApiError(body) ?? fallbackErrorTitle };
}

export function parseSuccessOrWarn<TIn, TOut>(
  schema: z.ZodType<TIn>,
  body: unknown,
  handler: string,
  fallback: TOut,
): TIn | TOut {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  // Log only field-name shapes + Zod issue paths — never the raw body, which
  // can carry user content (markdown, file paths, contributor metadata) that
  // shouldn't reach centralized observability via console capture. Mirrors
  // the bodyKeys discipline in successResponse's safeParse fallback.
  const bodyShape =
    typeof body === 'object' && body !== null
      ? Object.keys(body as Record<string, unknown>)
      : typeof body;
  console.warn(
    '[parse-server-response] schema drift:',
    handler,
    'bodyShape=',
    bodyShape,
    'issues=',
    result.error.issues,
  );
  return fallback;
}
