/**
 * Anti-proxy admission for `POST /api/link-preview` — pure header logic, kept
 * out of the route handler so the security decision can be exercised directly.
 *
 * This gate is deliberately STRICTER than the shared `/api/*` origin allowlist.
 * The shared gate accepts an absent Origin and the opaque `"null"` Origin, so a
 * sandboxed iframe (opaque origin) or a no-Origin simple request could reach a
 * route through it. This endpoint performs outbound fetches on the user's
 * behalf, so a caller that slipped through would be a readable server-side
 * request-forgery proxy for any local browser tab. To close that door the gate
 * admits ONLY a same-machine http(s) loopback Origin, and rejects absent /
 * `"null"` / non-loopback Origins outright; it also requires an
 * `application/json` content type so a CORS "simple request" (which can carry
 * only `text/plain` / form encodings and thus dodges the JSON preflight) cannot
 * be used as a bypass.
 *
 * Trade-off worth knowing: a packaged Electron renderer loaded from `file://`
 * presents Origin `"null"` and is therefore refused here just like an attacker
 * would be — the two are indistinguishable at the HTTP layer. That renderer
 * degrades to the plain URL pill; it is not served a preview. Loosening the
 * gate to admit `"null"` to serve it would reopen the readable-proxy hole, so
 * the strict form is intentional.
 */

/**
 * Why a request was refused, so the caller can pick the right problem type.
 * @lintignore Referenced by the exported LinkPreviewGateVerdict type; no direct importer.
 */
export type LinkPreviewGateRejection = 'origin' | 'content-type';

export type LinkPreviewGateVerdict = { ok: true } | { ok: false; reason: LinkPreviewGateRejection };

/**
 * A loopback http(s) Origin — the only Origin this endpoint serves. Absent and
 * the opaque `"null"` Origin both return false (rejected): they are the exact
 * shapes the shared gate would wave through. Hostname is compared after URL
 * parsing so a crafted authority like `http://127.0.0.1.evil.com` (hostname
 * `127.0.0.1.evil.com`) does not match the loopback set.
 */
export function isLoopbackHttpOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  return (
    host === 'localhost' ||
    // WHATWG URL keeps the brackets on an IPv6 hostname, so the loopback IPv6
    // literal presents as `[::1]` here — never a bare `::1`.
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * True only for an `application/json` content type (with or without parameters
 * like `; charset=utf-8`). A missing type, `text/plain`, and the multipart /
 * form encodings all return false — those are the simple-request media types a
 * cross-origin caller can send without triggering a CORS preflight.
 */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return base === 'application/json';
}

/**
 * Decide whether a request may proceed to the preview fetch. Returns the reason
 * on refusal so the route can map it to the matching RFC 9457 problem type.
 * Origin is checked before content type so a cross-origin caller is refused for
 * the more informative reason.
 */
export function classifyLinkPreviewRequest(headers: {
  origin: string | undefined;
  contentType: string | undefined;
}): LinkPreviewGateVerdict {
  if (!isLoopbackHttpOrigin(headers.origin)) return { ok: false, reason: 'origin' };
  if (!isJsonContentType(headers.contentType)) return { ok: false, reason: 'content-type' };
  return { ok: true };
}
