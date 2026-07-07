/**
 * Clipboard sanitization helpers — leaf module with no intra-clipboard
 * imports.
 *
 * Both the walker (`clipboard-walker.ts` — DOM traversal) and the fallback
 * palette (`clipboard-walker-fallback-palette.ts` — static element
 * construction) need URL / event-handler / style sanitization at the
 * cross-app re-emit boundary. Hosting these helpers inside the walker
 * created a circular dependency (palette imported `isSafeWalkerUrl` from
 * walker; walker imported `paletteFor` from palette). ESM resolved the
 * cycle correctly via deferred binding, but the cycle reflected a
 * conflated concern: the security helpers are a distinct responsibility
 * from DOM walking.
 *
 * This file is a leaf — it imports only from `@inkeep/open-knowledge-core`
 * (`SAFE_URL_SCHEME_RE`, `isRelativeUrl`). Both walker and palette import
 * from here, eliminating the cycle.
 *
 * Filter contract (cross-app re-emit boundary):
 *   - URL-scheme allowlist for href / src / srcset / poster / formaction /
 *     xlink:href via `isSafeWalkerUrl` + `isSrcsetSafe`.
 *   - Embedded-URL substitution for aria-label / aria-description / title
 *     via `sanitizeEmbeddedUrlValue`.
 *   - Style-payload filter for `style` via `sanitizeStyleAttrValue`.
 *   - Event-handler attribute classifier via `isDangerousEventHandlerAttr`.
 *   - URL-portability classifier (`classifyUrlPortability`) — the walker
 *     / palette use this to decide when to emit a source-fallback shape
 *     instead of a non-portable URL on the destination's `text/html`
 *     payload. Allowlist semantics: only public unicast http(s), portable
 *     navigation schemes, and bare fragments classify as portable.
 */

import { isRelativeUrl, SAFE_URL_SCHEME_RE } from '@inkeep/open-knowledge-core';
import * as ipaddr from 'ipaddr.js';

/**
 * URL-scheme attributes that the walker filters through `isSafeWalkerUrl`.
 * Includes `srcset` as a special case — see `isSrcsetSafe` for the
 * comma-separated candidate parser.
 */
export const URL_SCHEME_ATTRS: ReadonlySet<string> = new Set([
  'href',
  'src',
  'srcset',
  'poster',
  'formaction',
  'xlink:href',
]);

/**
 * Human-readable attributes that may carry an embedded URL — internal-link's
 * `aria-label="Link: <href>"` is the canonical OK shape. The walker scrubs
 * unsafe-scheme URLs appearing inside these values; safe schemes pass
 * through unchanged.
 */
export const URL_BEARING_TEXT_ATTRS: ReadonlySet<string> = new Set([
  'aria-label',
  'aria-description',
  'title',
]);

// Match URL-shaped tokens that are unambiguously URLs:
//   - `<scheme>://...` (authority-bearing — covers https/http/ftp/blob/intent/etc.)
//   - One of the explicit code-execution schemes that browsers and
//     destinations may attempt to navigate (no authority component).
//
// Intentionally narrower than `isSafeWalkerUrl`'s allowlist (which fail-closes
// on novel schemes for href/src). Embedded URL scanning runs against
// human-readable label content (`aria-label` / `title`), which is read by
// assistive tech as text — it does NOT navigate. The trade is: novel safe
// schemes in labels (e.g., `Visit magnet:?xt=...`) survive unblocked, in
// exchange for label fidelity ("Item:value", "Status:active", "Type:warning"
// no longer get rewritten to `[blocked]`).
const URL_LIKE_TOKEN_RE =
  /(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+|(?:javascript|vbscript|data|file|chrome-extension|moz-extension):[^\s"'<>]*)/gi;

/**
 * Dangerous CSS-in-`style` patterns. The pre-walker pipeline ran
 * `sanitizeStyleString` on JSX-component props, but mark-rendered DOM
 * (TipTap built-ins, raw HTML inline) bypasses that gate. Walker mirrors
 * the same coarse denylist (DOMPurify CSS-hook parity) at the cross-app
 * re-emit boundary: `url(javascript:...)` / `url(data:...)` payloads in
 * `background-image` / `content` / `list-style-image` / `cursor`, plus
 * legacy IE `expression(...)`.
 *
 * `MAX_STYLE_SCAN_LEN` mirrors the sibling guard in
 * `sanitize-url.ts:sanitizeStyleString` — defense-in-depth ceiling on
 * regex-scan cost for adversarial mega-payloads. A 10KB inline `style`
 * value is already two orders of magnitude above any legitimate use; the
 * sanitizer drops the value entirely above the threshold (no regex scan,
 * no opportunity for ReDoS-style amplification).
 */
const DANGEROUS_STYLE_URL_RE = /url\s*\(\s*['"]?\s*(?:javascript|vbscript|data)\s*:/i;
const DANGEROUS_STYLE_EXPRESSION_RE = /\bexpression\s*\(/i;
export const MAX_STYLE_SCAN_LEN = 10_000;

/**
 * Modern CSS color functions (CSS Color Level 4) that resolve at copy
 * time but cannot be rendered by destination HTML sanitizers (Gmail,
 * Notion, Slack, Apple Mail). `getComputedStyle()` returns the literal
 * `oklch(...)` / `oklab(...)` / `lab(...)` / `lch(...)` form on modern
 * browsers (Chrome 111+ / Safari 16.4+ / Firefox 113+); destinations
 * downstream cannot parse these and fall back to default colors —
 * invisible chevrons, transparent backgrounds, missing accent borders.
 *
 * `convertCssColors` resolves all four to `rgb()` / `rgba()` so the
 * cross-app payload renders correctly even on destinations stuck in the
 * pre-2023 color-function era.
 */
const MODERN_COLOR_RE = /(oklch|oklab|lab|lch)\(\s*([^)]+)\s*\)/gi;
export const MAX_COLOR_VALUE_LEN = 10_000;

/**
 * Descriptor opt-out marker: any element rendered into the editor DOM
 * that should NOT reach the clipboard payload sets this attribute to
 * `'true'`. The walker's top-level slice iteration and per-child walk
 * both check the LIVE element for this attribute; a match removes the
 * subtree from the cloned output entirely.
 *
 * Use this for editor-only chrome (toolbar buttons, drag handles,
 * settings popovers) that must remain interactive in the editor but
 * has no business in cross-app paste destinations. Reference the
 * constant rather than hardcoding `'data-clipboard-omit'` — a typo
 * (`'data-clipboard-ommit'`) would silently fail to opt out.
 */
export const OPT_OUT_ATTR = 'data-clipboard-omit' as const;

/**
 * Allowlist URL classifier — accepts `http(s):` / `mailto:` / `tel:` /
 * `ftp:` / `sms:` and any relative URL form (bare filenames, root-relative
 * paths, fragments, queries); rejects everything else. Trims leading and
 * trailing ASCII whitespace per WHATWG URL preprocessing so a leading-space
 * bypass (`" javascript:..."`) cannot evade the regex.
 *
 * Relative-URL detection delegated to the canonical `isRelativeUrl` helper
 * in `@inkeep/open-knowledge-core` — `sanitize-url.ts` reuses the same
 * helper, so a future refinement of relative-URL semantics propagates to
 * both sites by construction.
 *
 * Empty / whitespace-only values are treated as benign no-op hrefs and
 * pass through.
 */
export function isSafeWalkerUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') return true;
  if (SAFE_URL_SCHEME_RE.test(trimmed)) return true;
  return isRelativeUrl(trimmed);
}

/**
 * Per-candidate `srcset` validator. WHATWG HTML §4.8.4.3.2 defines
 * `srcset` as a comma-separated list of image-candidate strings, each with
 * a URL plus optional density / width descriptor. A head-anchored regex on
 * the entire attribute value misses dangerous URLs after the first comma
 * (`safe.jpg 1x, javascript:alert(1) 2x`).
 *
 * Returns `true` only if every non-empty candidate's URL is safe. Empty
 * candidates (between consecutive commas) are skipped.
 */
export function isSrcsetSafe(srcset: string): boolean {
  const candidates = srcset.split(',');
  for (const raw of candidates) {
    const candidate = raw.trim();
    if (candidate === '') continue;
    const url = candidate.split(/\s+/)[0] ?? '';
    if (!isSafeWalkerUrl(url)) return false;
  }
  return true;
}

/**
 * Substitute unsafe-scheme URLs inside a human-readable attribute value
 * (aria-label / aria-description / title) with `[blocked]`. Wrapping
 * label text is preserved so screen readers still surface the descriptor's
 * role ("Link: [blocked]").
 *
 * Returns the rewritten string when something was substituted. With
 * `reportNoChange: true`, returns `null` when the input is already safe so
 * the caller can avoid an unnecessary `setAttribute` write.
 */
export function sanitizeEmbeddedUrlValue(value: string): string;
export function sanitizeEmbeddedUrlValue(
  value: string,
  options: { reportNoChange: true },
): string | null;
export function sanitizeEmbeddedUrlValue(
  value: string,
  options?: { reportNoChange: boolean },
): string | null {
  let changed = false;
  const sanitized = value.replace(URL_LIKE_TOKEN_RE, (token) => {
    if (isSafeWalkerUrl(token)) return token;
    changed = true;
    return '[blocked]';
  });
  if (options?.reportNoChange && !changed) return null;
  return sanitized;
}

/**
 * Match DOM event-handler attributes (`onclick`, `onerror`, `onload`, etc.).
 * Mirrors `isDangerousPropName`'s `on*` rule at
 * `packages/app/src/editor/utils/sanitize-url.ts`, but operates on
 * attribute names (already lowercased by the DOM API on `Attr.name`).
 * Length discriminator avoids matching the bare `on` prefix.
 */
export function isDangerousEventHandlerAttr(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.length >= 3 && lower.startsWith('on');
}

/**
 * Coarse CSS-in-style filter. Drops the entire value when it carries a
 * `url(javascript:...)` / `url(vbscript:...)` / `url(data:...)` payload or
 * a legacy IE `expression(...)` call. Returns the input unchanged when
 * safe, or `''` when unsafe.
 *
 * Mirrors `sanitizeStyleString` in `packages/app/src/editor/utils/sanitize-url.ts`
 * but operates on the walker's `style` attribute boundary. We do not parse
 * CSS — DOMPurify uses the same denylist shape because the false-positive
 * class on legitimate inline styles is empty (no benign use of
 * `expression(...)` or `url(javascript:...)` exists in modern web content).
 */
export function sanitizeStyleAttrValue(value: string): string {
  if (value.length > MAX_STYLE_SCAN_LEN) return '';
  if (DANGEROUS_STYLE_URL_RE.test(value)) return '';
  if (DANGEROUS_STYLE_EXPRESSION_RE.test(value)) return '';
  return value;
}

// ─── Modern CSS color → rgb conversion ──────────────────────────────────
//
// Matrix coefficients and companding formulas from Björn Ottosson's oklab
// derivation (https://bottosson.github.io/posts/oklab/) and CSS Color Level
// 4. Implementation is intentionally inline (no dep): the math is small and
// well-bounded, and adding a color library would cost ~8KB+ against the
// app's bundle ceiling for one re-emit-boundary helper.

/** Parse the body of a modern color function to `[c1, c2, c3, alpha?]`. */
function parseColorBody(body: string): [number, number, number, number | null] | null {
  // Body shape: `L C H` or `L C H / A` (slash-separated alpha) or
  // comma-separated legacy form (`L, C, H`). Whitespace flexible.
  const slashIdx = body.indexOf('/');
  const main = (slashIdx === -1 ? body : body.slice(0, slashIdx)).trim();
  const alphaStr = slashIdx === -1 ? null : body.slice(slashIdx + 1).trim();
  const parts = main.split(/[\s,]+/).filter((p) => p.length > 0);
  if (parts.length !== 3) return null;
  const c1 = parseColorComponent(parts[0], 1);
  const c2 = parseColorComponent(parts[1], 1);
  const c3 = parseColorComponent(parts[2], 1);
  if (Number.isNaN(c1) || Number.isNaN(c2) || Number.isNaN(c3)) return null;
  let alpha: number | null = null;
  if (alphaStr !== null) {
    alpha = parseColorComponent(alphaStr, 1);
    if (Number.isNaN(alpha)) return null;
    alpha = Math.max(0, Math.min(1, alpha));
  }
  return [c1, c2, c3, alpha];
}

/**
 * Parse a single color component, handling `none` (treated as 0 per CSS
 * Color 4) and `%` suffix (treated as fraction-of-fullScale; for L it
 * means / 100, for chroma it's typically already 0..1 so % isn't standard
 * but some authors use it).
 */
function parseColorComponent(s: string, fullScale: number): number {
  if (s === 'none') return 0;
  if (s.endsWith('%')) {
    const n = Number.parseFloat(s.slice(0, -1));
    return (n / 100) * fullScale;
  }
  return Number.parseFloat(s);
}

/** oklch (L, C, H°) → oklab (L, a, b). */
function oklchToOklab(l: number, c: number, h: number): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  return [l, c * Math.cos(hRad), c * Math.sin(hRad)];
}

/**
 * oklab (L, a, b) → linear sRGB. Coefficients from
 * https://bottosson.github.io/posts/oklab/ — the inverse of the matrix
 * defining oklab from linear sRGB.
 */
function oklabToLinearSrgb(l: number, a: number, b: number): [number, number, number] {
  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;
  const lc = lp ** 3;
  const mc = mp ** 3;
  const sc = sp ** 3;
  return [
    +4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
}

/** Linear sRGB component → gamma-encoded sRGB component (CSS spec). */
function linearToSrgbChannel(x: number): number {
  if (x <= 0.0031308) return 12.92 * x;
  return 1.055 * x ** (1 / 2.4) - 0.055;
}

/** Clamp a channel to [0, 255] integer. Out-of-gamut → clip (no NaN). */
function toByte(channel: number): number {
  if (!Number.isFinite(channel)) return 0;
  return Math.max(0, Math.min(255, Math.round(channel * 255)));
}

/** oklch / oklab / lab / lch → rgb-channel triple [r, g, b] in [0, 255]. */
function modernColorToRgb(
  fn: string,
  c1: number,
  c2: number,
  c3: number,
): [number, number, number] {
  // L for ok* is on a 0..1 scale; CSS-spec lab/lch use 0..100. Normalize
  // L to 0..1 for the conversion path.
  // For lab/lch we approximate by treating them as oklab/oklch — the
  // gamut and white-point differ slightly (CIE illuminants for lab/lch
  // vs oklab/oklch) but the error is well below typical
  // destination-renderer fidelity. Documenting the trade here so it's
  // discoverable.
  const fnLower = fn.toLowerCase();
  let l: number;
  let a: number;
  let b: number;
  if (fnLower === 'oklch') {
    [l, a, b] = oklchToOklab(c1, c2, c3);
  } else if (fnLower === 'oklab') {
    [l, a, b] = [c1, c2, c3];
  } else if (fnLower === 'lch') {
    [l, a, b] = oklchToOklab(c1 / 100, c2 / 100, c3);
  } else {
    // lab
    [l, a, b] = [c1 / 100, c2 / 100, c3 / 100];
  }
  const [lr, lg, lb] = oklabToLinearSrgb(l, a, b);
  return [
    toByte(linearToSrgbChannel(lr)),
    toByte(linearToSrgbChannel(lg)),
    toByte(linearToSrgbChannel(lb)),
  ];
}

/**
 * Convert any modern CSS color function (`oklch`, `oklab`, `lab`, `lch`)
 * inside a CSS value string to its `rgb()` / `rgba()` form. Compound
 * values (e.g. `1px solid oklch(0.62 0.15 240)`) and gradients with
 * multiple color stops are handled by single-pass regex replacement.
 *
 * Pass-through invariants (no-ops): `rgb()` / `rgba()` / `#hex` / `hsl()`
 * / named colors / `transparent` / `currentColor` / `inherit` / `initial`
 * / empty / unrecognized text — all returned unchanged.
 *
 * Defense-in-depth: values exceeding `MAX_COLOR_VALUE_LEN` short-circuit
 * to passthrough rather than running the regex over a mega-payload.
 *
 * Error handling: malformed function bodies (`oklch(garbage)`) leave the
 * source string unchanged at that match site — never throws.
 */
export function convertCssColors(value: string): string {
  if (value.length > MAX_COLOR_VALUE_LEN) return value;
  // Hot-path optimization: most computed-style values are not modern color
  // functions. Lowercase the haystack once and skim for any of the four
  // function names; if absent, skip the regex entirely. Case-insensitive
  // because browsers can return either case from `getPropertyValue`.
  const lower = value.toLowerCase();
  if (
    !lower.includes('oklch') &&
    !lower.includes('oklab') &&
    !lower.includes('lab') &&
    !lower.includes('lch')
  ) {
    return value;
  }
  return value.replace(MODERN_COLOR_RE, (match, fn: string, body: string) => {
    const parsed = parseColorBody(body);
    if (parsed === null) return match;
    const [c1, c2, c3, alpha] = parsed;
    const [r, g, b] = modernColorToRgb(fn, c1, c2, c3);
    return alpha === null ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
  });
}

// ─── URL portability classifier (sister of `isSafeWalkerUrl`) ───────────
//
// `isSafeWalkerUrl` answers a security question ("is the destination
// renderer safe to navigate to?"); `classifyUrlPortability` answers an
// orthogonal transport question ("does this URL resolve from outside the
// source machine?"). Both gates compose at the walker post-pass: an
// unsafe URL is dropped first; a safe-but-non-portable URL triggers the
// source-fallback emission shape (`<pre class="mdx-component">` / `<span
// class="mdx-inline">`) so cross-app destinations show informative
// markdown source instead of a broken-image icon or dead link.
//
// Allowlist semantics: the IP-literal branch returns `true` ONLY when
// `range() === 'unicast'`. Every other range — `private`, `loopback`,
// `linkLocal`, `carrierGradeNat`, `uniqueLocal`, `multicast`, `broadcast`,
// `reserved`, `unspecified`, `ipv4Mapped`, `as112`, `amt`, `6to4`,
// `teredo`, plus any future range names `ipaddr.js` adds — is treated as
// non-portable by default. Errs toward source-fallback for ambiguous ranges
// rather than enumerating a blocklist that has to track upstream additions.

/**
 * Schemes whose destination renderer hands the URL off to a native OS
 * handler (mail composer, dialer, SMS app, FTP client) rather than
 * navigating in-page. These are portable regardless of host: the recipient
 * machine has its own handler that will resolve the URL locally.
 *
 * `ftps` is included alongside `ftp` for symmetry — both are surfaced by
 * destination renderers as clickable links even though browsers have
 * largely dropped in-browser FTP support. The helper is pure and
 * decoupled from `SAFE_URL_SCHEMES` (the upstream walker-safety
 * allowlist), so a future safety-allowlist expansion to include `ftps`
 * does not require a parallel change here.
 */
const PORTABLE_NAVIGATION_SCHEMES: ReadonlySet<string> = new Set([
  'mailto',
  'tel',
  'sms',
  'ftp',
  'ftps',
]);

/**
 * Bounded reason taxonomy for non-portable URLs. Canonical source — the
 * walker post-pass, the fallback palette parity path, and the
 * `clipboard-walker-url-source-emitted` telemetry dimension all consume
 * this type. `instrument.ts` imports `UrlPortabilityReason` directly via
 * `import type` so dashboards see exactly the same literal set.
 *
 *   - `relative` — bare relative path (`./photo.jpg`, `photo.png`)
 *   - `server-absolute` — root-relative path (`/foo/bar`)
 *   - `localhost` — literal `localhost` hostname
 *   - `private-ip` — any IP literal whose `range()` ≠ `'unicast'`
 *     (private, loopback, link-local, multicast, reserved, etc. —
 *     collapsed into one bucket because per-range cardinality has no
 *     operability value and would inflate dashboard cardinality)
 *   - `other` — non-portable schemes (`data:`, `blob:`, `file:`,
 *     novel schemes), empty hosts, query-only refs, defensive default.
 */
export type UrlPortabilityReason =
  | 'relative'
  | 'server-absolute'
  | 'localhost'
  | 'private-ip'
  | 'other';

type UrlPortability = { portable: true } | { portable: false; reason: UrlPortabilityReason };

/**
 * Classify a URL as portable + (when non-portable) the reason bucket. Used
 * by the walker URL-portability filter, the fallback palette parity path,
 * and the source-mode wrapper telemetry path. Single source of truth so
 * dashboards and tests see byte-identical decisions across every emission
 * site.
 *
 * Portable (`{ portable: true }`):
 *   - Fragment-only refs (`#section`) — resolve in destination's own
 *     pasted content if the heading is included; harmless if not.
 *   - Schemes in `PORTABLE_NAVIGATION_SCHEMES` (`mailto:`, `tel:`, `sms:`,
 *     `ftp:`, `ftps:`) — natively handled by destination.
 *   - `http(s):` URLs whose host is NOT `'localhost'` AND whose host is
 *     either a non-IP-literal hostname (`example.com`) OR an IP literal
 *     classifying as `'unicast'` per `ipaddr.js` (allowlist semantics —
 *     only `'unicast'` returns portable, every other range bucketizes
 *     into `private-ip`).
 *
 * Non-portable (`{ portable: false, reason }`):
 *   - `'relative'` — bare relative path / query-only / empty.
 *   - `'server-absolute'` — root-relative path (`/foo/bar`).
 *   - `'localhost'` — literal `localhost` hostname on `http(s):`.
 *   - `'private-ip'` — any non-`unicast` IP literal on `http(s):`.
 *   - `'other'` — non-http(s)/non-portable scheme, or http(s) with
 *     empty host.
 *
 * Throws on inputs that survive the relative-URL short-circuit but cannot
 * be parsed by the URL constructor (`':::'`, `'http://'`, etc.). The walker
 * call site wraps this in try/catch and surfaces the failure via telemetry.
 */
export function classifyUrlPortability(rawUrl: string): UrlPortability {
  const trimmed = rawUrl.trim();

  // (a) Fragment-only refs — cheapest check, runs first.
  if (trimmed.startsWith('#')) return { portable: true };

  // Relative URLs (no scheme, server-absolute, query-only, empty) cannot
  // resolve in a destination that doesn't share the source machine's base
  // URL. Short-circuit BEFORE `new URL()` because the URL constructor
  // throws on relative inputs without a base — return a clean non-portable
  // result for these, not a throw the caller has to swallow. Discriminate
  // `/foo` (server-absolute) from `./foo` and bare paths (relative) for
  // telemetry; both classify as non-portable.
  if (isRelativeUrl(trimmed)) {
    if (trimmed.startsWith('/')) return { portable: false, reason: 'server-absolute' };
    return { portable: false, reason: 'relative' };
  }

  // From here on, `new URL()` is expected to succeed. If it throws, the
  // input was malformed in a way `isRelativeUrl` couldn't detect — let it
  // propagate so the walker call site catches it and emits telemetry.
  const parsed = new URL(trimmed);
  // `URL.protocol` includes the trailing colon (`'https:'`); strip it
  // and lowercase for the scheme set lookup.
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();

  // (b) Natively-handled schemes — portable regardless of host.
  if (PORTABLE_NAVIGATION_SCHEMES.has(scheme)) return { portable: true };

  // (c) http(s) — host-portability check.
  if (scheme !== 'http' && scheme !== 'https') return { portable: false, reason: 'other' };

  // `URL.hostname` strips the port but PRESERVES IPv6 brackets per
  // WHATWG URL spec — `https://[2001:db8::1]:8080/x` arrives as
  // `'[2001:db8::1]'`, NOT `'2001:db8::1'`. Strip brackets before
  // handing the value to `ipaddr.js`, which expects the bare address.
  // WHATWG URL parsing already lowercases hostnames, so a defensive
  // lowercase here costs nothing and protects against future parser
  // changes. Zone identifiers are NOT a concern: WHATWG URL parsing
  // rejects zone-ID syntax in the host (`https://[fe80::1%25eth0]/x`
  // throws), so the bracketed content never carries a `%` segment.
  const rawHost = parsed.hostname.toLowerCase();
  if (rawHost === '') return { portable: false, reason: 'other' };
  // Trailing-dot variant (`localhost.`) bypasses an exact-equality check
  // because URL parsing preserves the dot. Per RFC 6761 §6.3 the entire
  // `.localhost` TLD is reserved for loopback, so any subdomain ending in
  // `.localhost` (with or without trailing dot) must classify as
  // non-portable too.
  const hostNoDot = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;
  if (hostNoDot === 'localhost' || hostNoDot.endsWith('.localhost')) {
    return { portable: false, reason: 'localhost' };
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

  // IP literal — only `'unicast'` is portable (allowlist semantics).
  if (ipaddr.IPv4.isValid(host)) {
    return ipaddr.IPv4.parse(host).range() === 'unicast'
      ? { portable: true }
      : { portable: false, reason: 'private-ip' };
  }
  if (ipaddr.IPv6.isValid(host)) {
    return ipaddr.IPv6.parse(host).range() === 'unicast'
      ? { portable: true }
      : { portable: false, reason: 'private-ip' };
  }

  // Non-IP-literal hostname — portable by default.
  return { portable: true };
}
