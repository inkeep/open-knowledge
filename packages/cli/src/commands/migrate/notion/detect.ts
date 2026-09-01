import { readFileSync } from 'node:fs';
import { walkFiles } from './fs-walk.ts';

const ID_SUFFIXED_MD = / [0-9a-f]{32}\.mdx?$/i;
const BASE64_IMAGE = /data:image\/[a-z0-9.+-]+;base64,/i;

export function isNotionExport(dir: string): boolean {
  const files = walkFiles(dir);
  for (const f of files) {
    if (f.endsWith('_all.csv')) return true;
    if (ID_SUFFIXED_MD.test(f)) return true;
  }
  for (const f of files) {
    if (!/\.mdx?$/i.test(f)) continue;
    try {
      if (BASE64_IMAGE.test(readFileSync(f, 'utf8'))) return true;
    } catch {}
  }
  return false;
}
