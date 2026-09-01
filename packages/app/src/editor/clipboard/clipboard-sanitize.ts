import { isRelativeUrl, SAFE_URL_SCHEME_RE } from '@inkeep/open-knowledge-core';
import * as ipaddr from 'ipaddr.js';

export const URL_SCHEME_ATTRS: ReadonlySet<string> = new Set([
  'href',
  'src',
  'srcset',
  'poster',
  'formaction',
  'xlink:href',
]);

export const URL_BEARING_TEXT_ATTRS: ReadonlySet<string> = new Set([
  'aria-label',
  'aria-description',
  'title',
]);

const URL_LIKE_TOKEN_RE =
  /(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+|(?:javascript|vbscript|data|file|chrome-extension|moz-extension):[^\s"'<>]*)/gi;

const DANGEROUS_STYLE_URL_RE = /url\s*\(\s*['"]?\s*(?:javascript|vbscript|data)\s*:/i;
const DANGEROUS_STYLE_EXPRESSION_RE = /\bexpression\s*\(/i;
export const MAX_STYLE_SCAN_LEN = 10_000;

const MODERN_COLOR_RE = /(oklch|oklab|lab|lch)\(\s*([^)]+)\s*\)/gi;
export const MAX_COLOR_VALUE_LEN = 10_000;

export const OPT_OUT_ATTR = 'data-clipboard-omit' as const;

export function isSafeWalkerUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') return true;
  if (SAFE_URL_SCHEME_RE.test(trimmed)) return true;
  return isRelativeUrl(trimmed);
}

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

export function isDangerousEventHandlerAttr(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.length >= 3 && lower.startsWith('on');
}

export function sanitizeStyleAttrValue(value: string): string {
  if (value.length > MAX_STYLE_SCAN_LEN) return '';
  if (DANGEROUS_STYLE_URL_RE.test(value)) return '';
  if (DANGEROUS_STYLE_EXPRESSION_RE.test(value)) return '';
  return value;
}

function parseColorBody(body: string): [number, number, number, number | null] | null {
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

function parseColorComponent(s: string, fullScale: number): number {
  if (s === 'none') return 0;
  if (s.endsWith('%')) {
    const n = Number.parseFloat(s.slice(0, -1));
    return (n / 100) * fullScale;
  }
  return Number.parseFloat(s);
}

function oklchToOklab(l: number, c: number, h: number): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  return [l, c * Math.cos(hRad), c * Math.sin(hRad)];
}

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

function linearToSrgbChannel(x: number): number {
  if (x <= 0.0031308) return 12.92 * x;
  return 1.055 * x ** (1 / 2.4) - 0.055;
}

function toByte(channel: number): number {
  if (!Number.isFinite(channel)) return 0;
  return Math.max(0, Math.min(255, Math.round(channel * 255)));
}

function modernColorToRgb(
  fn: string,
  c1: number,
  c2: number,
  c3: number,
): [number, number, number] {
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
    [l, a, b] = [c1 / 100, c2 / 100, c3 / 100];
  }
  const [lr, lg, lb] = oklabToLinearSrgb(l, a, b);
  return [
    toByte(linearToSrgbChannel(lr)),
    toByte(linearToSrgbChannel(lg)),
    toByte(linearToSrgbChannel(lb)),
  ];
}

export function convertCssColors(value: string): string {
  if (value.length > MAX_COLOR_VALUE_LEN) return value;
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

const PORTABLE_NAVIGATION_SCHEMES: ReadonlySet<string> = new Set([
  'mailto',
  'tel',
  'sms',
  'ftp',
  'ftps',
]);

export type UrlPortabilityReason =
  | 'relative'
  | 'server-absolute'
  | 'localhost'
  | 'private-ip'
  | 'other';

type UrlPortability = { portable: true } | { portable: false; reason: UrlPortabilityReason };

export function classifyUrlPortability(rawUrl: string): UrlPortability {
  const trimmed = rawUrl.trim();

  if (trimmed.startsWith('#')) return { portable: true };

  if (isRelativeUrl(trimmed)) {
    if (trimmed.startsWith('/')) return { portable: false, reason: 'server-absolute' };
    return { portable: false, reason: 'relative' };
  }

  const parsed = new URL(trimmed);
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();

  if (PORTABLE_NAVIGATION_SCHEMES.has(scheme)) return { portable: true };

  if (scheme !== 'http' && scheme !== 'https') return { portable: false, reason: 'other' };

  const rawHost = parsed.hostname.toLowerCase();
  if (rawHost === '') return { portable: false, reason: 'other' };
  const hostNoDot = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;
  if (hostNoDot === 'localhost' || hostNoDot.endsWith('.localhost')) {
    return { portable: false, reason: 'localhost' };
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

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

  return { portable: true };
}
