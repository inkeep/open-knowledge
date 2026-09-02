import { parseCsv } from './csv.ts';

export interface RenderTableOptions {
  wideThreshold?: number;
  titleColumn?: number;
  linkForTitle?: (title: string) => string | null;
}

export interface RenderedTable {
  table: string;
  columns: number;
  wide: boolean;
}

function escapeCell(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '<br>').replace(/\|/g, '\\|');
}

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

export function extractStubTitle(stubMarkdown: string, fallback: string): string {
  const match = stubMarkdown.match(/^#\s+(.+)$/m);
  return match ? (match[1] as string).trim() : fallback;
}

export function buildStubPage(title: string, table: string): string {
  return `# ${title}\n\n${table}\n`;
}
