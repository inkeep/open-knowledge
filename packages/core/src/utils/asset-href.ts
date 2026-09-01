export function toDesktopAssetHref(src: string): string {
  if (typeof src !== 'string' || !src.startsWith('/')) return src;
  const origin = (globalThis as { window?: { okDesktop?: { config?: { apiOrigin?: unknown } } } })
    .window?.okDesktop?.config?.apiOrigin;
  return typeof origin === 'string' && origin ? origin + src : src;
}
