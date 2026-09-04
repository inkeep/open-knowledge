import { readFileSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { parseCsv } from './csv.ts';
import { buildIndex } from './normalized-index.ts';

const TRAILING_ID = /\s+[0-9a-f]{32}$/i;
const MD = /\.mdx?$/i;

export interface DatabaseInfo {
  csvPath: string;
  stubPath: string | null;
  stubTargetPath: string;
  folderPath: string;
  propertyKeys: Set<string>;
  csvText: string;
  rowFiles: string[];
  folderIndex: Map<string, string[]>;
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
    const base = csvPath.slice(0, -'_all.csv'.length);
    const stubPath = fileSet.has(`${base}.md`)
      ? `${base}.md`
      : fileSet.has(`${base}.mdx`)
        ? `${base}.mdx`
        : null;
    const folderPath = base.replace(TRAILING_ID, '');

    let csvText = '';
    try {
      csvText = readFileSync(csvPath, 'utf8');
    } catch {
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
