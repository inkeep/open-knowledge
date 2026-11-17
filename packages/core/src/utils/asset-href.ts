import { ASSET_EXTENSIONS } from '../constants/upload.ts';

export function toDesktopAssetHref(src: string): string {
  if (typeof src !== 'string' || !src.startsWith('/')) return src;
  const origin = (globalThis as { window?: { okDesktop?: { config?: { apiOrigin?: unknown } } } })
    .window?.okDesktop?.config?.apiOrigin;
  return typeof origin === 'string' && origin ? origin + src : src;
}

export function matchAssetUrl(url: string, editorOrigin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const origin = parsed.origin;
  if (origin !== editorOrigin) return null;

  const raw = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!path) return null;

  const lastSegment = path.split('/').pop() ?? '';
  const extMatch = lastSegment.match(/\.([a-z0-9]+)$/i);
  if (!extMatch) return null;
  const ext = (extMatch[1] ?? '').toLowerCase();
  if (ext === 'html' || ext === 'htm') return null;
  if (!ASSET_EXTENSIONS.has(ext)) return null;

  return path;
}
