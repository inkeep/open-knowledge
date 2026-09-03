import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_ROOT = fileURLToPath(new URL('.', import.meta.url));

const ROUTER_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx'] as const;

const spellings = (stem: string): string[] =>
  ROUTER_EXTENSIONS.map((extension) => `${stem}.${extension}`);

export const ROUTE_FILES: readonly string[] = spellings('route');
export const PAGE_FILES: readonly string[] = spellings('page');

const METADATA_ROUTE_STEMS: Readonly<Record<string, string>> = {
  sitemap: 'sitemap.xml',
  robots: 'robots.txt',
  manifest: 'manifest.webmanifest',
  'opengraph-image': 'opengraph-image',
  'twitter-image': 'twitter-image',
  icon: 'icon',
  'apple-icon': 'apple-icon',
};

export const METADATA_ROUTE_FILES: readonly string[] =
  Object.keys(METADATA_ROUTE_STEMS).flatMap(spellings);

export function metadataRouteName(fileName: string, sourcePath: string): string | null {
  const stem = fileName.slice(0, fileName.indexOf('.'));
  const served = METADATA_ROUTE_STEMS[stem];
  if (!served || !METADATA_ROUTE_FILES.includes(fileName)) return null;
  const grouped = sourcePath.split('/').some((segment) => /^[(@].+/.test(segment));
  return served.startsWith('sitemap') || !grouped ? served : `${served}-a1b2c3`;
}

export function filesNamed(name: string | readonly string[], dir = APP_ROOT, base = ''): string[] {
  const names = typeof name === 'string' ? [name] : name;
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return filesNamed(names, `${dir}${entry.name}/`, rel);
    return names.includes(entry.name) ? [rel] : [];
  });
}

export function readAppFile(relativePath: string): string {
  return readFileSync(`${APP_ROOT}${relativePath}`, 'utf8');
}
