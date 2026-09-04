import { SAFE_URL_SCHEMES } from '@inkeep/open-knowledge-core';

export type GfmLinkToken = {
  href: string;
  text: string;
};

const URL_HEAD = /^(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/i;
const EMAIL_HEAD = /^([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/;
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

function hasCorrectDomainLabels(domain: string): boolean {
  const parts = domain.split('.');
  const last = parts[parts.length - 1];
  const penultimate = parts[parts.length - 2];
  if (last && (/_/.test(last) || !/[a-zA-Z\d]/.test(last))) return false;
  if (penultimate && (/_/.test(penultimate) || !/[a-zA-Z\d]/.test(penultimate))) return false;
  return true;
}

function isCorrectSchemelessDomain(domain: string): boolean {
  return domain.split('.').length >= 2 && hasCorrectDomainLabels(domain);
}

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

export function detectGfmLinkToken(token: string): GfmLinkToken | null {
  if (!token) return null;
  return detectUrl(token) ?? detectEmail(token);
}
