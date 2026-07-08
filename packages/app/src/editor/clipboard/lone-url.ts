/**
 * Lone-URL classification for the paste/drop dispatcher and the link
 * popover's clipboard pre-fill.
 *
 * A payload whose text/plain trims to a single whitespace-free token can be
 * "a pasted URL" in two senses, and the dispatcher's two paste contexts
 * deliberately apply two different policies:
 *
 * - At a cursor the conversion is autolink-shaped: only tokens the markdown
 *   pipeline's own parse would linkify (the GFM autolink-literal shapes)
 *   convert, so the inserted bytes are exactly what a markdown author would
 *   have typed and they re-parse to the identical link. Anything else —
 *   bare domains, filenames — inserts verbatim, unchanged from before this
 *   step existed.
 *
 * - Over a selected range the paste gesture itself carries link intent (the
 *   Notion/Docs "paste a URL onto selected text" idiom), so the policy is
 *   trust-the-gesture: any allowlisted-scheme URL verbatim, GFM-shape
 *   emails as `mailto:`, and schemeless dotted hosts (`example.com`,
 *   `www.example.com` — and filename-shaped tokens like `AGENTS.md`, a
 *   deliberately accepted edge of trusting the gesture) get `https://`
 *   prepended. This is
 *   deliberately looser than the typed-autolink policy because the result
 *   is an explicit `[text](url)` link whose bytes never need to re-parse as
 *   an autolink literal — and because an unwanted conversion is one undo
 *   away, on a gesture that rarely means anything but "link this".
 *
 * Both dispatcher classifiers return null for everything else; the
 * dispatcher falls through to its normal branch tree, so a non-matching
 * payload pastes exactly as it always did.
 *
 * The link popover's pre-fill applies a third, strictest policy: opening
 * the popover is an authoring gesture, not a gesture at the clipboard, so
 * the guess is speculative — only a token that is already unambiguously a
 * URL (explicit allowlisted scheme) qualifies, verbatim. No https://
 * prepending, no mailto: minting: a wrong pre-fill costs a clear-and-retype
 * with no gesture to blame, where the paste policies' conversions cost one
 * undo on a gesture that asked for a link.
 */

import { isAllowedLinkUri } from '@inkeep/open-knowledge-core';
import { detectGfmLinkToken } from '../gfm-link-detector.ts';

// RFC 3986 scheme grammar. Note the collision with host:port shorthand:
// `example.com:8080` and `localhost:5173` both match as a "scheme", fail the
// allowlist, and therefore never convert — the URL grammar itself is
// ambiguous there, and fail-closed keeps port shorthands out of both paste
// policies just as they are out of the typed-autolink policy.
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function loneToken(raw: string): string | null {
  const token = raw.trim();
  if (!token || /\s/.test(token)) return null;
  return token;
}

/**
 * Cursor-paste classification: is the whole payload one GFM autolink-literal
 * token? Returns the trimmed token — the caller feeds it through the
 * markdown parse, which mints the link mark and canonical bare-literal
 * bytes (including GFM's own trailing-punctuation split) — or null when the
 * pipeline would leave the token as plain text.
 */
export function detectLoneGfmUrl(raw: string): string | null {
  const token = loneToken(raw);
  if (!token) return null;
  return detectGfmLinkToken(token) ? token : null;
}

/**
 * Over-selection paste classification (trust-the-gesture policy). Returns
 * the href to link the selected text to, or null when the payload should
 * not convert the selection (the dispatcher then pastes normally).
 */
export function detectLoneTrustedUrl(raw: string): string | null {
  const token = loneToken(raw);
  if (!token) return null;

  if (EXPLICIT_SCHEME.test(token)) {
    return isAllowedLinkUri(token) ? token : null;
  }

  // Schemeless email → mailto:, reusing the GFM email grammar so the two
  // paste policies (and the typed path) share one definition of "an email".
  const gfm = detectGfmLinkToken(token);
  if (gfm && gfm.text === token && gfm.href.startsWith('mailto:')) {
    return gfm.href;
  }

  // Bare-domain arm: the authority part (up to the first `/`, `?`, or `#`)
  // must look like a dotted host. An `@` there is an email-shaped token the
  // grammar above rejected — prepending https:// would mint a userinfo URL
  // the user never intended, so refuse instead. An `@` later in the token is
  // just a path (`example.com/@user`) and stays eligible.
  const host = token.split(/[/?#]/, 1)[0] ?? '';
  if (host.includes('@')) return null;
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;

  const href = `https://${token}`;
  return isAllowedLinkUri(href) ? href : null;
}

/**
 * Link-popover pre-fill classification: pre-fill iff the clipboard is
 * already an explicit allowlisted-scheme URL, returned verbatim. See the
 * header for why this is stricter than both paste policies.
 */
export function detectClipboardPrefillUrl(raw: string): string | null {
  const token = loneToken(raw);
  if (!token) return null;
  if (!EXPLICIT_SCHEME.test(token)) return null;
  return isAllowedLinkUri(token) ? token : null;
}
