import { readFileSync } from 'node:fs';
import { walkFiles } from './fs-walk.ts';

/** A file named `... <32-hex-id>.md` — Notion's per-page export naming. */
const ID_SUFFIXED_MD = / [0-9a-f]{32}\.mdx?$/i;
/** An inline base64 image blob (`[](data:image/png;base64,...)`). */
const BASE64_IMAGE = /data:image\/[a-z0-9.+-]+;base64,/i;

/**
 * Detect whether `dir` looks like a Notion `Markdown & CSV` export. Any one of
 * three signals suffices: an id-suffixed markdown filename, a database
 * `*_all.csv`, or an inline base64 image blob. Cheap filename signals are
 * checked first; the content scan is a fallback only when neither fires.
 */
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
    } catch {
      // Unreadable file — not a detection signal.
    }
  }
  return false;
}
