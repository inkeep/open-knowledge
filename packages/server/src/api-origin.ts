const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string | undefined): boolean {
  return SAFE_METHODS.has(method ?? 'GET');
}

export function isOpaqueOrigin(origin: string): boolean {
  return origin === 'null' || origin.toLowerCase().startsWith('file:');
}

export function isAllowedApiOrigin(origin: string): boolean {
  if (origin === 'file://') return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'file:') return false;
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
