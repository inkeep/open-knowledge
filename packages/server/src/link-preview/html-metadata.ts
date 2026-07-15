/**
 * Parse the fetched page's `<head>` into normalized preview fields, and derive
 * the shown domain from the request URL. The HTML arrives as untrusted bytes,
 * so this layer is deliberately narrow: only a handful of known tags are read,
 * every text field runs through {@link sanitizeText}, and the domain never comes
 * from the fetched markup — only from the URL the user actually hovered.
 *
 * The head is read by a hand-rolled bounded scanner rather than a DOM, a parser
 * dependency, or a runtime built-in. The production server runs under Node (the
 * desktop app spawns it with ELECTRON_RUN_AS_NODE=1; the npm CLI is a node
 * script) while tests run under Bun, so an engine-specific parser (Bun's
 * HTMLRewriter) is silently absent in production; one portable scanner keeps a
 * single parse path on both runtimes. The scan is single-pass and
 * index-monotonic (indexOf/charCode, no regex over the markup), so hostile
 * input stays linear-time; input size is capped by the fetch layer.
 */

/** Display caps; fetched text is truncated to keep the card bounded. */
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 500;
const MAX_SITE_NAME = 100;

/**
 * The known metadata fields read from the head. Every field is optional: a page
 * with no usable tags returns `{}` and the caller falls back to domain-only.
 * `faviconHref` is the raw icon href (relative or absolute) for the favicon
 * fetcher to resolve — it is a URL, not display text, so it is not sanitized
 * here (the `URL` constructor validates it at resolution time).
 */
export interface RawHtmlMetadata {
  title?: string;
  description?: string;
  siteName?: string;
  faviconHref?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeCodePoint(code: number): string | null {
  // Reject out-of-range and lone surrogates so decoding can't emit an
  // ill-formed scalar; `String.fromCodePoint` cannot throw after this guard.
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

/**
 * Decode the core named entities plus decimal/hex numeric character references.
 * The head scanner hands text and attribute values back raw (entities
 * undecoded), so this runs BEFORE control-character stripping — otherwise a
 * numeric-encoded bidi override such as `&#x202e;` would survive stripping and
 * reach the card. The long tail of named entities is intentionally left literal
 * (rare in titles); they render harmlessly as text.
 */
function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        return decodeCodePoint(code) ?? match;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

// Bidi overrides/isolates and zero-width/format controls that can visually
// reorder or hide text to misrepresent the destination.
function isFormatControl(code: number): boolean {
  return (
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

// C0/C1 controls and DEL.
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Drop format/bidi controls and turn C0/C1 controls into spaces (so text on
 * either side stays separated). Matched by code point rather than a regex both
 * to keep control characters out of the source and to make the intent explicit.
 */
function stripUnsafeChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (isFormatControl(code)) continue;
    out += isControl(code) ? ' ' : ch;
  }
  return out;
}

function truncate(text: string, maxLen: number): string {
  // Count by code point so a surrogate pair (emoji) is never split at the cap.
  const chars = Array.from(text);
  if (chars.length <= maxLen) return text;
  return `${chars
    .slice(0, maxLen - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * Turn a raw fetched string into safe, bounded display text: decode entities,
 * remove format/control characters, collapse whitespace, then cap length. An
 * empty result signals an absent field (the caller omits it).
 */
function sanitizeText(raw: string, maxLen: number): string {
  const decoded = decodeHtmlEntities(raw);
  const stripped = stripUnsafeChars(decoded);
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return truncate(collapsed, maxLen);
}

function relTokens(rel: string): string[] {
  return rel.trim().toLowerCase().split(/\s+/);
}

// ---------------------------------------------------------------------------
// Bounded head scanner
//
// The scanner walks the markup once, tag by tag, and stops at `</head>` or
// `<body>` so nothing below the head can spoof the card. All structural
// matching (tag names, close-tag searches) runs against an ASCII-lowercased
// copy of the input so `<TITLE>` and `</SCRIPT>` match case-insensitively;
// extracted text and attribute values slice from the original string. Only
// A-Z is folded (never full Unicode lowercasing, which can change string
// length and would misalign the two views).
// ---------------------------------------------------------------------------

function asciiLowerCase(input: string): string {
  return input.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function isWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

/**
 * Elements whose content is raw text (or inert markup) to a browser: nothing
 * inside them may contribute tags, so the scanner skips their content wholesale
 * until the matching close tag. This is what keeps
 * `<script>document.title="<title>evil</title>"</script>` from contributing a
 * title. `noscript` is deliberately absent: its head content is real metadata
 * markup (`meta`/`link`/`style` are valid there) for non-scripting agents.
 */
const RAW_TEXT_TAGS = new Set([
  'script',
  'style',
  'template',
  'textarea',
  'iframe',
  'xmp',
  'noembed',
  'noframes',
  'plaintext',
]);

/** Read a tag name (letters/digits/hyphen) from the lowercased view. */
function readTagName(lower: string, start: number): { name: string; end: number } {
  let i = start;
  while (i < lower.length) {
    const c = lower.charCodeAt(i);
    const isNameChar = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d;
    if (!isNameChar) break;
    i++;
  }
  return { name: lower.slice(start, i), end: i };
}

/**
 * Scan a tag's attributes from just after the tag name to just past its `>`,
 * returning that end index. Handles double-quoted, single-quoted, and unquoted
 * values, `=` spacing variants, and self-closing `/`; a quoted value may
 * contain `>` without ending the tag. When `attrs` is provided, each
 * attribute's first occurrence is recorded (duplicates ignored, matching how
 * browsers resolve repeated attributes); names come from the lowercased view,
 * values from the original string. An unterminated tag consumes to the end of
 * input.
 */
function scanAttributes(
  html: string,
  lower: string,
  start: number,
  attrs: Map<string, string> | null,
): number {
  const len = lower.length;
  let i = start;
  while (i < len) {
    let c = lower.charCodeAt(i);
    if (isWhitespaceCode(c) || c === 0x2f /* / */) {
      i++;
      continue;
    }
    if (c === 0x3e /* > */) return i + 1;
    const nameStart = i;
    while (i < len) {
      c = lower.charCodeAt(i);
      if (isWhitespaceCode(c) || c === 0x3d /* = */ || c === 0x3e || c === 0x2f) break;
      i++;
    }
    const name = lower.slice(nameStart, i);
    while (i < len && isWhitespaceCode(lower.charCodeAt(i))) i++;
    let value = '';
    if (i < len && lower.charCodeAt(i) === 0x3d) {
      i++;
      while (i < len && isWhitespaceCode(lower.charCodeAt(i))) i++;
      if (i < len) {
        const quote = lower.charCodeAt(i);
        if (quote === 0x22 /* " */ || quote === 0x27 /* ' */) {
          i++;
          const close = lower.indexOf(quote === 0x22 ? '"' : "'", i);
          value = html.slice(i, close === -1 ? len : close);
          i = close === -1 ? len : close + 1;
        } else {
          const valueStart = i;
          while (i < len) {
            c = lower.charCodeAt(i);
            if (isWhitespaceCode(c) || c === 0x3e) break;
            i++;
          }
          value = html.slice(valueStart, i);
        }
      }
    }
    if (attrs && name && !attrs.has(name)) attrs.set(name, value);
  }
  return len;
}

/**
 * Find a raw-text element's close tag: the first case-insensitive `</name`
 * followed by `>`, `/`, whitespace, or end of input (so `</scripty` does not
 * close a script). Returns the content end (start of the close tag) and the
 * index just past the close tag's `>`, or `null` when the element never
 * closes, in which case the rest of the input is inert raw text.
 */
function findCloseTag(
  lower: string,
  tagName: string,
  from: number,
): { textEnd: number; end: number } | null {
  const needle = `</${tagName}`;
  let i = from;
  while (i < lower.length) {
    const at = lower.indexOf(needle, i);
    if (at === -1) return null;
    const afterIdx = at + needle.length;
    const after = afterIdx < lower.length ? lower.charCodeAt(afterIdx) : -1;
    if (after === 0x3e || after === 0x2f || after === -1 || isWhitespaceCode(after)) {
      const gt = lower.indexOf('>', afterIdx);
      return { textEnd: at, end: gt === -1 ? lower.length : gt + 1 };
    }
    i = at + 1;
  }
  return null;
}

/**
 * Extract the preview fields from a page's head. Title prefers `og:title` over
 * `<title>`; description prefers `og:description` over the `description` meta;
 * site name is `og:site_name`. Only content inside the head (before `</head>`
 * or `<body>`) counts, so a stray `<title>`/`<meta>` in the body cannot spoof
 * the card; a document with no explicit `<head>` (title before `<body>`) still
 * yields its head fields. Script/style content and HTML comments are skipped
 * wholesale, so markup-shaped strings inside them cannot contribute fields.
 */
export function extractHtmlMetadata(html: string): RawHtmlMetadata {
  let rawTitle = '';
  const metaContent = new Map<string, string>();
  let faviconHref: string | undefined;

  try {
    const lower = asciiLowerCase(html);
    const len = lower.length;
    let i = 0;
    while (i < len) {
      const lt = lower.indexOf('<', i);
      if (lt === -1) break;
      const next = lt + 1 < len ? lower.charCodeAt(lt + 1) : -1;

      if (next === 0x21 /* ! */) {
        if (lower.startsWith('<!--', lt)) {
          // Comment: nothing inside may contribute fields. Searching from
          // lt + 2 lets the abrupt closings `<!-->` and `<!--->` terminate
          // instead of swallowing the markup after them; an unterminated
          // comment swallows the rest of the input.
          const close = lower.indexOf('-->', lt + 2);
          if (close === -1) break;
          i = close + 3;
        } else {
          // <!doctype ...> and other markup declarations.
          const gt = lower.indexOf('>', lt + 2);
          if (gt === -1) break;
          i = gt + 1;
        }
        continue;
      }

      if (next === 0x3f /* ? */) {
        const gt = lower.indexOf('>', lt + 2);
        if (gt === -1) break;
        i = gt + 1;
        continue;
      }

      if (next === 0x2f /* / */) {
        const { name, end } = readTagName(lower, lt + 2);
        if (name === 'head') break;
        const gt = lower.indexOf('>', end);
        if (gt === -1) break;
        i = gt + 1;
        continue;
      }

      if (!(next >= 0x61 && next <= 0x7a)) {
        // A '<' that opens no tag ('<<', '< ', trailing '<') is literal text.
        i = lt + 1;
        continue;
      }

      const { name, end: nameEnd } = readTagName(lower, lt + 1);

      if (name === 'body') break;

      if (name === 'title') {
        const contentStart = scanAttributes(html, lower, nameEnd, null);
        const close = findCloseTag(lower, 'title', contentStart);
        if (close === null) {
          // Unterminated title: the rest of the input is its text (sanitize
          // caps the displayed length).
          rawTitle += html.slice(contentStart);
          break;
        }
        rawTitle += html.slice(contentStart, close.textEnd);
        i = close.end;
        continue;
      }

      if (RAW_TEXT_TAGS.has(name)) {
        const contentStart = scanAttributes(html, lower, nameEnd, null);
        const close = findCloseTag(lower, name, contentStart);
        if (close === null) break;
        i = close.end;
        continue;
      }

      if (name === 'meta') {
        const attrs = new Map<string, string>();
        i = scanAttributes(html, lower, nameEnd, attrs);
        const content = attrs.get('content');
        if (content) {
          const property = attrs.get('property');
          const metaName = attrs.get('name');
          if (property) metaContent.set(property.toLowerCase(), content);
          else if (metaName) metaContent.set(metaName.toLowerCase(), content);
        }
        continue;
      }

      if (name === 'link') {
        const attrs = new Map<string, string>();
        i = scanAttributes(html, lower, nameEnd, attrs);
        // First icon link wins; ignore the rest so a head stuffed with
        // <link> tags cannot grow this unbounded.
        if (faviconHref === undefined) {
          const href = attrs.get('href');
          const rel = attrs.get('rel');
          if (href && rel && relTokens(rel).includes('icon')) faviconHref = href;
        }
        continue;
      }

      // Any other open tag (html, head, base, ...): step past it.
      i = scanAttributes(html, lower, nameEnd, null);
    }
  } catch {
    // The bytes are untrusted; if the scan fails on a hostile document, return
    // whatever was captured before the throw rather than propagating into the
    // request handler.
  }

  const title = sanitizeText(metaContent.get('og:title') ?? rawTitle, MAX_TITLE);
  const description = sanitizeText(
    metaContent.get('og:description') ?? metaContent.get('description') ?? '',
    MAX_DESCRIPTION,
  );
  const siteName = sanitizeText(metaContent.get('og:site_name') ?? '', MAX_SITE_NAME);

  const result: RawHtmlMetadata = {};
  if (title) result.title = title;
  if (description) result.description = description;
  if (siteName) result.siteName = siteName;
  if (faviconHref) result.faviconHref = faviconHref;
  return result;
}

/**
 * The domain shown on the card, derived from the request URL only. `URL`
 * normalizes IDN hosts to punycode, so a look-alike Unicode host renders as its
 * ASCII `xn--` form. A leading `www.` is dropped for cleanliness, but only when
 * a registrable label remains (so `www.com` stays `www.com`).
 */
export function deriveDomain(requestUrl: string): string {
  let host: string;
  try {
    host = new URL(requestUrl).hostname;
  } catch {
    // Reached only if a caller passes an unparseable string; a fetch already
    // validated production URLs. Fall back so the domain field stays non-empty.
    return requestUrl;
  }
  if (host.startsWith('www.') && host.slice(4).includes('.')) host = host.slice(4);
  return host;
}
