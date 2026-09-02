import { isAllowedLinkUri } from '@inkeep/open-knowledge-core';
import { detectGfmLinkToken } from '../gfm-link-detector.ts';

const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function loneToken(raw: string): string | null {
  const token = raw.trim();
  if (!token || /\s/.test(token)) return null;
  return token;
}

export function detectLoneGfmUrl(raw: string): string | null {
  const token = loneToken(raw);
  if (!token) return null;
  return detectGfmLinkToken(token) ? token : null;
}

export function detectLoneTrustedUrl(raw: string): string | null {
  const token = loneToken(raw);
  if (!token) return null;

  if (EXPLICIT_SCHEME.test(token)) {
    return isAllowedLinkUri(token) ? token : null;
  }

  const gfm = detectGfmLinkToken(token);
  if (gfm && gfm.text === token && gfm.href.startsWith('mailto:')) {
    return gfm.href;
  }

  const host = token.split(/[/?#]/, 1)[0] ?? '';
  if (host.includes('@')) return null;
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;

  const href = `https://${token}`;
  return isAllowedLinkUri(href) ? href : null;
}

export function detectClipboardPrefillUrl(raw: string): string | null {
  const token = loneToken(raw);
  if (!token) return null;
  if (!EXPLICIT_SCHEME.test(token)) return null;
  return isAllowedLinkUri(token) ? token : null;
}
