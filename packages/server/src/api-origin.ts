/**
 * Shared loopback-origin guard for unauthenticated local HTTP surfaces.
 */
export function isAllowedApiOrigin(origin: string): boolean {
  if (origin === 'null') return true;
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}
