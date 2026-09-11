export const SAFE_URL_SCHEMES = ['https', 'http', 'mailto', 'tel', 'ftp', 'sms'] as const;

const SCHEME_ALT = SAFE_URL_SCHEMES.map((s) => `${s}:`).join('|');
const PATH_PREFIX_ALT = '\\/|#|\\?|\\.\\/|\\.\\.\\/';

export const SAFE_URL_SCHEME_RE = new RegExp(`^(?:${SCHEME_ALT}|${PATH_PREFIX_ALT})`, 'i');

export function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') return true;
  return SAFE_URL_SCHEME_RE.test(trimmed);
}

export function isRelativeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') return true;
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return true;
  const slashIdx = trimmed.indexOf('/');
  const questionIdx = trimmed.indexOf('?');
  const hashIdx = trimmed.indexOf('#');
  const firstSep = Math.min(
    slashIdx === -1 ? Number.POSITIVE_INFINITY : slashIdx,
    questionIdx === -1 ? Number.POSITIVE_INFINITY : questionIdx,
    hashIdx === -1 ? Number.POSITIVE_INFINITY : hashIdx,
  );
  return colonIdx > firstSep;
}
