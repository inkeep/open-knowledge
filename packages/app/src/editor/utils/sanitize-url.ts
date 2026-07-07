/**
 * Render-layer XSS mitigation for MDX-authored component props.
 *
 * The editor renders live React components authored as MDX. User-authored
 * MDX expression-attrs can land arbitrary values on every live-rendered
 * component (fumadocs Card forwards `{...props}` to a DOM `<a>`/`<div>`).
 * Storage-layer fidelity is unchanged (raw bytes pass through); this
 * helper is the render-layer mitigation per CLAUDE.md "Storage never
 * sanitizes; render-time layers do."
 *
 * Three surfaces are policed here:
 *   1. URL-typed props (`href`, `src`, `action`, …) — strip
 *      javascript:/vbscript:/data: schemes (replace with `#`).
 *   2. Dangerous prop names (`dangerouslySetInnerHTML`, `on*`, `ref`, `key`,
 *      React internals) — DROP. These are XSS gadgets regardless of value.
 *   3. `style` prop — reject non-string *and* filter `url(javascript:…)` /
 *      `expression(…)` / `javascript:` from string values.
 *
 * URL rules:
 *   - Empty / falsy strings pass through unchanged.
 *   - Relative paths (`/docs/foo`, `./sibling`, `../`) and fragments (`#id`)
 *     pass through — they resolve against the current origin.
 *   - Schemes in URL_SCHEME_ALLOWLIST pass through unchanged.
 *   - Protocol-relative URLs (`//evil.example`) pass through.
 *   - Everything else is replaced with `#` — visually preserving the "link"
 *     shape but inert on click.
 *
 * URL props are matched case-insensitively against URL_PROP_NAMES so the
 * React camelCase form (`formAction`, `xlinkHref`) and the HTML lowercase
 * form (`formaction`, `action`) both hit the filter.
 *
 * Nested URL traversal: arrays + plain objects are walked recursively for
 * URL-shaped keys so patterns like `<InlineTOC items={[{url:"javascript:…"}]} />`
 * cannot bypass at any nesting depth. MDX expression-attrs are parsed from
 * text via `mdast-util-mdx` and produce JSON-like trees with no cycles
 * (object identity is fresh per parse), so the recursion is bounded by the
 * parser's own input-size limits — no runtime cap needed. Earlier revisions
 * of this module capped recursion at depth 4 to "protect against cyclic /
 * pathological shapes," which fail-opened a real attack class
 * (`{a:{b:{c:{d:{url:'javascript:…'}}}}}`) for no actual safety benefit.
 *
 * Matches the shape shipped by React itself for `href` in development
 * builds (see reactjs/rfcs#186 + createSanitizeURL) and by DOMPurify's
 * `ALLOWED_URI_REGEXP` default.
 *
 * Telemetry:
 *   Drop events go to `console.warn` (above the default log-aggregator
 *   threshold) and bump `incrementJsxPropDropped` so
 *   `/api/metrics/parse-health` exposes attack volume. A per-prop-name
 *   rate limit caps warn emissions at 10/min/prop so legitimate MDX
 *   authoring mistakes (`<Callout onClick={handler}>`) don't flood logs
 *   while still surfacing targeted XSS probes (where attack cadence blows
 *   past the rate limit and produces visible aggregate counters).
 */

import {
  incrementJsxPropDropped,
  isRelativeUrl,
  SAFE_URL_SCHEMES,
} from '@inkeep/open-knowledge-core';

// Derived from the canonical `SAFE_URL_SCHEMES` array so the JSX-prop
// sanitizer, the markdown pipeline (`isSafeUrl`), and the clipboard
// walker (`isSafeWalkerUrl`) all classify URL schemes from a single
// source. Adding / removing a scheme in `SAFE_URL_SCHEMES` updates all
// three sites by construction.
const URL_SCHEME_ALLOWLIST = new Set(SAFE_URL_SCHEMES.map((s) => `${s}:`));

/**
 * Per-prop-name warn-emit rate limit window. 10 warns per minute per
 * prop-name is enough to surface a targeted XSS probe (attacker cadence
 * blows past this and the counter tells the story) while absorbing
 * legitimate authoring mistakes (`<Callout onClick={handler}>` typed
 * once) without log spam. Counter emission is unlimited — the rate cap
 * only gates the per-event `console.warn`.
 */
const DROP_WARN_WINDOW_MS = 60_000;
const DROP_WARN_LIMIT_PER_WINDOW = 10;
const dropWarnState = new Map<string, { windowStart: number; count: number }>();

function emitPropDroppedEvent(reason: string, key: string): void {
  const lower = key.toLowerCase();
  incrementJsxPropDropped(lower);
  const now = Date.now();
  const state = dropWarnState.get(lower);
  if (!state || now - state.windowStart >= DROP_WARN_WINDOW_MS) {
    dropWarnState.set(lower, { windowStart: now, count: 1 });
  } else {
    state.count += 1;
    if (state.count > DROP_WARN_LIMIT_PER_WINDOW) return;
  }
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(
      JSON.stringify({
        event: 'jsx-prop-dropped',
        reason,
        prop: key,
      }),
    );
  }
}

/**
 * Prop names whose string value is rendered as a DOM URL attribute.
 * Stored lowercased; callers compare via `key.toLowerCase()` so both the
 * React camelCase form (`formAction`) and the HTML lowercase form
 * (`formaction`) route through the filter.
 *
 * Covers the 5-pack foundation surface (Image.src, Video.src, Audio.src, and
 * Callout.icon when namespaced lucide:X), the full HTML URL-attribute set,
 * and SVG xlink:* (xlinkHref on <use>/<image> is an under-documented XSS
 * vector).
 */
export const URL_PROP_NAMES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'cite',
  'data',
  'manifest',
  'background',
  'ping',
  'xlinkhref',
  'xlinkactuate',
  'xlinkrole',
  'xlinkarcrole',
  'xlinkshow',
  // Non-HTML-attr conventions common in component prop shapes. Nested
  // traversal reaches these inside arrays / objects (e.g.
  // `InlineTOC items={[{url: ...}]}` flows to `<a href={item.url}>`).
  // Also included at the top level so a hypothetical `url` prop on any
  // future descriptor inherits the filter.
  'url',
  'link',
]);

/**
 * React-special / security-sensitive prop names that must never flow from
 * user-authored MDX to a live-rendered component. Stored lowercased; `on*`
 * handlers matched via prefix check in `isDangerousPropName`.
 *
 *   - `dangerouslysetinnerhtml` — direct HTML injection → arbitrary JS.
 *   - `ref` / `key` — React internals (object `ref` object from MDX is
 *     meaningless and could pierce component isolation).
 *   - `defaultvalue` / `defaultchecked` — React form uncontrolled-component
 *     seeding; harmless in isolation but not something MDX authors need.
 *   - `on*` — every DOM event handler. A string `onClick="alert(1)"` is
 *     ignored by React (requires a function), but an MDX expression-attr
 *     CAN carry a function via complex serialization paths. Drop all.
 *   - `__html` — any prop whose shape includes this key is a DIY-dangerous-
 *     HTML gadget.
 */
const DANGEROUS_PROP_NAMES = new Set([
  'dangerouslysetinnerhtml',
  'ref',
  'key',
  'defaultvalue',
  'defaultchecked',
  // Prototype-pollution guards. JSON.parse + Object.entries don't
  // enumerate inherited properties, so these rarely reach user code —
  // but MDX expression-attrs can technically carry any key shape, and
  // a renderer that forwards `{...props}` to a non-React consumer
  // could see the prototype walked. Belt-and-braces denylist is cheap.
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Max CSS `style` string length that is scanned. Longer values are
 * preserved (no-op — the scanner would be quadratic on adversarial
 * input). Typical inline-style values are < 500 chars; 10 KB is
 * a generous ceiling before falling back to "pass through as plain
 * string, no parse."
 */
const MAX_STYLE_SCAN_LEN = 10_000;

/** Lowercase + rule check — pure, exported for unit tests. */
export function isDangerousPropName(rawName: string): boolean {
  const name = rawName.toLowerCase();
  if (DANGEROUS_PROP_NAMES.has(name)) return true;
  // `onClick`, `onMouseDown`, `onError`, … — every DOM event handler.
  // React requires `on` + uppercase letter; but we normalize to lowercase
  // first, so check any prop starting with `on` followed by another char.
  if (name.length >= 3 && name.startsWith('on')) return true;
  return false;
}

/** URL prop match — case-insensitive. Exported for unit tests. */
export function isUrlPropName(rawName: string): boolean {
  return URL_PROP_NAMES.has(rawName.toLowerCase());
}

/**
 * Return a safe value for a URL-typed prop. Non-strings pass through so
 * this can be applied blindly across the prop set (callers check
 * `isUrlPropName(key)` first to avoid rewriting non-URL string props).
 *
 * Exported for unit tests; callers should prefer `sanitizeComponentProps`
 * for the whole-props-object shape.
 */
export function sanitizeUrlValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const value = raw.trim();
  if (!value) return raw;

  // Fragment-only (`#id`) — same-document anchor.
  if (value.startsWith('#')) return raw;

  // Protocol-relative (`//host/path`) — resolves against the current origin's
  // protocol; browsers reject the combination with `javascript:`, so this
  // can't be used as a scheme-smuggling path.
  if (value.startsWith('//')) return raw;

  // Relative paths (no scheme, no leading `//`) — defer to the canonical
  // `isRelativeUrl` helper from @inkeep/open-knowledge-core. The clipboard
  // walker shares the same helper, so a future refinement of relative-URL
  // semantics propagates to both sites by construction.
  if (isRelativeUrl(value)) return raw;

  const colonIdx = value.indexOf(':');
  const scheme = value.slice(0, colonIdx + 1).toLowerCase();
  if (URL_SCHEME_ALLOWLIST.has(scheme)) return raw;
  return '#';
}

/**
 * Sanitize a CSS `style` STRING value. Drops the whole value if it contains
 * a `javascript:` / `vbscript:` scheme inside `url(…)` (covers background /
 * content / list-style-image etc.) or a CSS `expression(…)` call (legacy IE,
 * still a gadget class). We do not attempt a full CSS parser; the filter
 * is a coarse denylist matching DOMPurify's CSS-hook behavior.
 *
 * Returns the input string unchanged when safe. Returns `''` when unsafe.
 * Non-string input is rejected at the caller before reaching this helper.
 */
function sanitizeStyleString(value: string): string {
  if (value.length > MAX_STYLE_SCAN_LEN) return '';
  const lower = value.toLowerCase();
  // url(…) with javascript:/vbscript:/data: scheme
  if (/url\s*\(\s*['"]?\s*(?:javascript|vbscript|data)\s*:/.test(lower)) return '';
  // IE legacy expression() — still used in phishing payloads.
  if (/\bexpression\s*\(/.test(lower)) return '';
  return value;
}

/**
 * Walk a prop value, sanitizing URL-shaped keys in nested arrays/objects.
 * Returns a structurally-equivalent value; non-plain objects (class
 * instances, functions, DOM nodes) pass through untouched — MDX expression
 * attributes can only produce primitives, plain objects, and arrays, so
 * this catches every realistic attack shape without interfering with
 * descriptor-provided React.ReactNode values.
 *
 * Recurses to arbitrary depth. MDX expression-attrs are parsed from text
 * (no runtime object identity), so the input is acyclic and bounded by the
 * parser's own input-size limit. Earlier revisions capped recursion at
 * depth 4 and fail-opened nested URLs past that depth — see module header.
 */
function sanitizeNested(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const sanitized = sanitizeNested(value[i]);
      next[i] = sanitized;
      if (sanitized !== value[i]) changed = true;
    }
    return changed ? next : value;
  }
  if (typeof value !== 'object') return value;
  // Guard against non-plain objects (Map, Set, Date, DOM nodes, React
  // elements, class instances). JSON.parse always produces plain objects,
  // so MDX-derived props won't hit this, but defensive belt-and-braces.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const obj = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // Dangerous prop names (`dangerouslySetInnerHTML`,
    // `on*`, React internals) are dropped outright at the TOP level by
    // `sanitizeComponentProps`. Mirror that policy at depth so a future
    // descriptor that spreads a nested attr — e.g. `<InlineTOC items={[
    // {label, href, onClick: 'alert(1)'}]} />` — cannot smuggle an event
    // handler past the top-level filter. Today the 5-pack doesn't spread
    // nested attrs onto React elements, but the surrounding sanitize-url
    // tests anticipate that consumer shape. Adding the
    // filter here closes the matching gap before the first consumer lands.
    if (isDangerousPropName(k)) {
      emitPropDroppedEvent('dangerous-prop-name-nested', k);
      changed = true;
      continue;
    }
    if (isUrlPropName(k) && typeof v === 'string') {
      const safe = sanitizeUrlValue(v);
      if (safe !== v) changed = true;
      out[k] = safe;
    } else {
      const safe = sanitizeNested(v);
      if (safe !== v) changed = true;
      out[k] = safe;
    }
  }
  return changed ? out : value;
}

/**
 * Policy pass over a whole props object. Applies (in order):
 *   - Drops dangerous prop names outright (`dangerouslySetInnerHTML`, `on*`,
 *     React internals). Logs a structured debug event per drop.
 *   - Rewrites URL-typed props with `sanitizeUrlValue`.
 *   - Rewrites `style` string values with `sanitizeStyleString`; drops
 *     non-string `style` entirely (React accepts objects, but an MDX
 *     expression-authored style object can smuggle `background:"url(js:)"`
 *     values that bypass the string scanner; the safer default is to
 *     require descriptor-declared style props if a component needs them).
 *   - Recursively sanitizes nested URL-shaped keys (arrays + plain objects)
 *     to arbitrary depth — see `sanitizeNested` for the bounded-cost rationale.
 *
 * Returns a new object when anything was rewritten; returns the input
 * unchanged otherwise (avoids unnecessary re-renders in React Compiler's
 * equality memo).
 */
export function sanitizeComponentProps(props: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isDangerousPropName(key)) {
      // DROP. Promoted from `console.debug` so drop events land above
      // default log-aggregator thresholds (DevTools / Sentry / Datadog
      // / Grafana all hide `debug` by default). Per-prop-name rate limit
      // absorbs author mistakes; aggregate counter is unlimited.
      emitPropDroppedEvent('dangerous-prop-name', key);
      changed = true;
      continue;
    }
    if (isUrlPropName(key)) {
      const safe = sanitizeUrlValue(value);
      if (safe !== value) changed = true;
      result[key] = safe;
      continue;
    }
    if (key === 'style') {
      if (typeof value === 'string') {
        const safe = sanitizeStyleString(value);
        if (safe !== value) changed = true;
        result[key] = safe;
      } else {
        // Object / non-string styles are dropped. Descriptor-declared style
        // props should be modeled as explicit typed fields.
        changed = true;
      }
      continue;
    }
    const safe = sanitizeNested(value);
    if (safe !== value) changed = true;
    result[key] = safe;
  }
  return changed ? result : props;
}
