/**
 * Reconstruct a database as a markdown table.
 *
 * A Notion database exports as a stub page (`# Title` + a link to the CSV), a
 * `<db>_all.csv` of every row, and a folder of one markdown file per row. OK
 * cannot render the `.csv`, so we render the CSV as a markdown pipe table into
 * the stub page. The row-page folder is kept intact (19% of rows carry a
 * body the CSV lacks) and the title column links to each row page when the match
 * is unambiguous. Cell values are made table-safe (newlines -> <br>, `|`
 * escaped) so every row stays single-line. Idempotent: the stub is regenerated
 * deterministically from (title, CSV).
 */

import { parseCsv } from './csv.ts';

export interface RenderTableOptions {
  /** Columns beyond this flag the table as wide (default 15). */
  wideThreshold?: number;
  /** Index of the title column to link (default 0). */
  titleColumn?: number;
  /** Resolve a row's title to a relative link to its page, or null. */
  linkForTitle?: (title: string) => string | null;
}

export interface RenderedTable {
  table: string;
  columns: number;
  wide: boolean;
}

/** Make a cell value safe for a single-line markdown table cell. */
function escapeCell(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '<br>').replace(/\|/g, '\\|');
}

/** Wrap a link target in angle brackets when it contains spaces (CommonMark). */
function linkTarget(path: string): string {
  return /\s/.test(path) ? `<${path}>` : path;
}

export function renderCsvTable(csvText: string, opts: RenderTableOptions = {}): RenderedTable {
  const { header, rows } = parseCsv(csvText);
  const columns = header.length;
  if (columns === 0) return { table: '', columns: 0, wide: false };

  const wideThreshold = opts.wideThreshold ?? 15;
  const titleCol = opts.titleColumn ?? 0;

  const headerLine = `| ${header.map(escapeCell).join(' | ')} |`;
  const sepLine = `| ${header.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.map((row) => {
    const cells = header.map((_h, ci) => {
      const raw = row[ci] ?? '';
      const display = escapeCell(raw);
      if (ci === titleCol && opts.linkForTitle && raw.trim() !== '') {
        const link = opts.linkForTitle(raw);
        if (link) return `[${display}](${linkTarget(link)})`;
      }
      return display;
    });
    return `| ${cells.join(' | ')} |`;
  });

  return {
    table: [headerLine, sepLine, ...bodyLines].join('\n'),
    columns,
    wide: columns > wideThreshold,
  };
}

/** Extract the H1 title from a stub page, or fall back. */
export function extractStubTitle(stubMarkdown: string, fallback: string): string {
  const match = stubMarkdown.match(/^#\s+(.+)$/m);
  return match ? (match[1] as string).trim() : fallback;
}

/** Deterministically build a database stub page from its title and table. */
export function buildStubPage(title: string, table: string): string {
  return `# ${title}\n\n${table}\n`;
}
