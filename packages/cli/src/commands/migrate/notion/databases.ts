/**
 * Discover Notion database exports from a file list.
 *
 * Each database is a trio: `<Name> <id>_all.csv` (all rows), a sibling
 * `<Name> <id>.md` stub, and a title-only companion folder `<Name>/` holding one
 * markdown file per row (empirically the folder drops the id — 118/119 in a real
 * export). We derive all three from the CSV path.
 */

import { readFileSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { parseCsv } from './csv.ts';
import { buildIndex } from './normalized-index.ts';

const TRAILING_ID = /\s+[0-9a-f]{32}$/i;
const MD = /\.mdx?$/i;

export interface DatabaseInfo {
  csvPath: string;
  /** Sibling stub page `<Name> <id>.md`, if it already exists. */
  stubPath: string | null;
  /** Canonical stub path `<Name> <id>.md` — where a stub goes, existing or not. */
  stubTargetPath: string;
  /** Title-only companion folder `<Name>`. */
  folderPath: string;
  /** CSV header, used as the authoritative property-key set for frontmatter. */
  propertyKeys: Set<string>;
  csvText: string;
  /** Markdown row-page files under the folder. */
  rowFiles: string[];
  /** Normalized index over the row files, for title-column linking. */
  folderIndex: Map<string, string[]>;
  /** Title used when a stub has no H1. */
  fallbackTitle: string;
}

export function detectDatabases(
  files: readonly string[],
  opts: { onUnreadable?: (path: string) => void } = {},
): DatabaseInfo[] {
  const fileSet = new Set(files);
  const out: DatabaseInfo[] = [];

  for (const csvPath of files) {
    if (!csvPath.endsWith('_all.csv')) continue;
    const base = csvPath.slice(0, -'_all.csv'.length); // `.../Name <id>`
    const stubPath = fileSet.has(`${base}.md`)
      ? `${base}.md`
      : fileSet.has(`${base}.mdx`)
        ? `${base}.mdx`
        : null;
    const folderPath = base.replace(TRAILING_ID, ''); // `.../Name`

    let csvText = '';
    try {
      csvText = readFileSync(csvPath, 'utf8');
    } catch {
      // Unreadable CSV — treat as no rows/keys, but let the caller surface it.
      opts.onUnreadable?.(csvPath);
    }
    const header = parseCsv(csvText).header;
    const propertyKeys = new Set(header.map((h) => h.trim()).filter((h) => h.length > 0));

    const rowFiles = files.filter(
      (f) => f !== stubPath && MD.test(f) && f.startsWith(`${folderPath}${sep}`),
    );

    out.push({
      csvPath,
      stubPath,
      stubTargetPath: `${base}.md`,
      folderPath,
      propertyKeys,
      csvText,
      rowFiles,
      folderIndex: buildIndex(rowFiles),
      fallbackTitle: basename(folderPath),
    });
  }

  return out;
}
