
const NAVIGATION_ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'mailto:',
  'tel:',
]);

export function isSafeNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return NAVIGATION_ALLOWED_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}
