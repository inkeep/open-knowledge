/**
 * Pure, editor-independent recognizer for the three GFM autolink-literal
 * token shapes — protocol URLs (`https?://…`), `www.` domains, and bare
 * emails (`local@domain`). Given a single whitespace-free token it answers:
 * would the markdown pipeline's own parse turn this into a link, and to
 * what href?
 *
 * Linkification only fires when GFM itself would, so a converted token
 * serializes to a bare literal that re-parses to the identical link. That
 * is why bare domains (`example.com`), filenames (`AGENTS.md`), and
 * `localhost:5173` must NOT match: GFM never linkifies them, so the
 * recognizer must not either. The dotted-domain requirement applies to the
 * schemeless (`www.`) arm only — micromark's `http_autolink` production
 * skips it when an explicit scheme is present (a documented divergence from
 * the GFM spec prose), so `http://localhost:5174` linkifies and round-trips
 * as a bare literal. The logic is ported from
 * `mdast-util-gfm-autolink-literal` (the pipeline's own transform) so the
 * two agree by construction; the co-located parity test pins the agreement
 * against the real `MarkdownManager.parse`.
 *
 * Href transforms mirror GFM exactly: `www.` prepends `http://` (NOT
 * https — the pipeline's own default), email prepends `mailto:`, and
 * protocol URLs keep their scheme verbatim with original casing. Trailing
 * sentence punctuation and unbalanced closing parens are excluded from the
 * linkified span, matching how GFM splits them off.
 *
 * No ProseMirror / editor imports: `clipboard/lone-url.ts` (a plain string
 * module) and unit tests both consume this as a pure string function.
 *
 * Coupled artifact: this is a hand-port of `mdast-util-gfm-autolink-literal`
 * (which exposes no synchronous string classifier) and must track it on every
 * markdown dependency bump. The drift guards are the parity tests in
 * `gfm-link-detector.test.ts` (token matrix incl. trailing punctuation,
 * balanced parens, structural bad-domain rejection, all checked against the
 * real `MarkdownManager.parse`) — they run in `bun run check`.
 */

import { SAFE_URL_SCHEMES } from '@inkeep/open-knowledge-core';

export type GfmLinkToken = {
  /** Resolved link target: scheme-prepended for www/email, verbatim otherwise. */
  href: string;
  /** The linkified literal — the display text and the bytes that serialize back. */
  text: string;
};

// Head-anchored ports of the two `transformGfmAutolinkLiterals` regexes. The
// token is already whitespace-delimited, so the upstream "previous character"
// guard (start / whitespace / punctuation) is always satisfied at index 0 and
// is omitted here.
const URL_HEAD = /^(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/i;
const EMAIL_HEAD = /^([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/;
// GFM rejects an email whose domain's final label ends in `-`, a digit, or `_`.
const EMAIL_LABEL_BAD_TAIL = /[-\d_]$/;

const ALLOWED_SCHEME_PREFIXES = SAFE_URL_SCHEMES.map((scheme) => `${scheme}:`);

function schemeAllowed(href: string): boolean {
  const lower = href.toLowerCase();
  return ALLOWED_SCHEME_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function countChar(haystack: string, char: string): number {
  let n = 0;
  for (const c of haystack) {
    if (c === char) n++;
  }
  return n;
}

/** GFM's per-label check on the final two dot-separated labels: neither may
 *  contain `_` or lack an alphanumeric character. Applies to BOTH url arms —
 *  micromark keeps the underscore restriction even for scheme'd URLs. */
function hasCorrectDomainLabels(domain: string): boolean {
  const parts = domain.split('.');
  const last = parts[parts.length - 1];
  const penultimate = parts[parts.length - 2];
  if (last && (/_/.test(last) || !/[a-zA-Z\d]/.test(last))) return false;
  if (penultimate && (/_/.test(penultimate) || !/[a-zA-Z\d]/.test(penultimate))) return false;
  return true;
}

/** The schemeless (`www.`) arm additionally requires a dotted host. An
 *  explicit `http(s)://` scheme skips this — micromark's `http_autolink`
 *  accepts dotless hosts (`http://localhost:5174`), and the detector must
 *  match the parse or typed conversions would diverge from round-trip. */
function isCorrectSchemelessDomain(domain: string): boolean {
  return domain.split('.').length >= 2 && hasCorrectDomainLabels(domain);
}

/** GFM's trailing-punctuation split: peel a run of sentence punctuation off
 *  the end, but keep closing parens that balance an opening paren inside the
 *  URL (Wikipedia-style `…/Foo_(disambiguation)`). Returns [linkified, trailing]. */
function splitUrl(url: string): [string, string] {
  const trailMatch = /[!"&'),.:;<>?\]}]+$/.exec(url);
  if (!trailMatch) return [url, ''];

  let head = url.slice(0, trailMatch.index);
  let trail = trailMatch[0];
  let closingParenIndex = trail.indexOf(')');
  const openingParens = countChar(head, '(');
  let closingParens = countChar(head, ')');

  while (closingParenIndex !== -1 && openingParens > closingParens) {
    head += trail.slice(0, closingParenIndex + 1);
    trail = trail.slice(closingParenIndex + 1);
    closingParenIndex = trail.indexOf(')');
    closingParens++;
  }

  return [head, trail];
}

function detectUrl(token: string): GfmLinkToken | null {
  const match = URL_HEAD.exec(token);
  if (!match) return null;

  let protocol = match[1];
  let domain = match[2];
  const path = match[3];
  let prefix = '';

  // A `www.` match carries no scheme in the source; fold it into the domain
  // and let the pipeline's `http://` prefix supply one.
  const schemeless = /^w/i.test(protocol);
  if (schemeless) {
    domain = protocol + domain;
    protocol = '';
    prefix = 'http://';
  }

  if (schemeless ? !isCorrectSchemelessDomain(domain) : !hasCorrectDomainLabels(domain)) {
    return null;
  }

  const [core] = splitUrl(domain + path);
  if (!core) return null;

  const text = protocol + core;
  const href = prefix + protocol + core;
  if (!schemeAllowed(href)) return null;
  return { href, text };
}

function detectEmail(token: string): GfmLinkToken | null {
  const match = EMAIL_HEAD.exec(token);
  if (!match) return null;

  const local = match[1];
  const label = match[2];
  if (EMAIL_LABEL_BAD_TAIL.test(label)) return null;

  const text = `${local}@${label}`;
  const href = `mailto:${text}`;
  if (!schemeAllowed(href)) return null;
  return { href, text };
}

/**
 * Classify a completed token. Returns the `{ href, text }` to link, or null
 * when GFM would leave the token as plain text. `text` is the exact literal
 * to keep in the document (which may be shorter than the input token when
 * trailing punctuation is split off); `href` is its resolved target.
 */
export function detectGfmLinkToken(token: string): GfmLinkToken | null {
  if (!token) return null;
  return detectUrl(token) ?? detectEmail(token);
}
