
import { isRelativeUrl } from './safe-url.ts';

function isDevDiagnosticContext(): boolean {
  if (typeof process === 'undefined' || !process.env) return false;
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

function posixDirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return '';
  if (idx === 0) return '/';
  return path.slice(0, idx);
}

function posixNormalizeJoin(dir: string, rel: string): string {
  const combined = dir ? `${dir}/${rel}` : rel;
  const isAbsolute = combined.startsWith('/');
  const out: string[] = [];
  for (const seg of combined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== '..') out.pop();
      else if (!isAbsolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return isAbsolute ? `/${joined}` : joined;
}

export function normalizeDocRelativeAssetUrl(rawUrl: string, sourcePath?: string): string {
  if (typeof rawUrl !== 'string' || rawUrl === '') return rawUrl;
  if (!sourcePath) return rawUrl;
  if (rawUrl.startsWith('/')) return rawUrl;
  if (!isRelativeUrl(rawUrl)) return rawUrl;
  const rel = posixNormalizeJoin(posixDirname(sourcePath), rawUrl);
  if (rel === '' || rel === '..' || rel.startsWith('../')) {
    if (isDevDiagnosticContext()) {
      console.warn(
        `[resolve-image-url] doc-relative path escapes contentDir; emitting raw URL: ${rawUrl} (from sourcePath ${sourcePath})`,
      );
    }
    return rawUrl;
  }
  return `/${rel}`;
}
