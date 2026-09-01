import type { SimpleGit } from 'simple-git';

export function splitNulSeparatedPaths(out: string): string[] {
  return out.split('\0').filter((path) => path.length > 0);
}

export function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  const records = porcelain.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') i++;
  }
  return paths;
}

export interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
  origPath?: string;
}

export function parsePorcelainEntries(porcelain: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  const records = porcelain.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (record.length < 4) continue;
    const x = record[0] ?? ' ';
    const y = record[1] ?? ' ';
    const entry: PorcelainEntry = { x, y, path: record.slice(3) };
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const origin = records[i + 1];
      if (origin !== undefined && origin.length > 0) entry.origPath = origin;
      i++;
    }
    entries.push(entry);
  }
  return entries;
}

export interface NameStatusRow {
  status: string;
  from: string;
  to: string;
}

export function parseNameStatusZ(out: string): NameStatusRow[] {
  const fields = out.split('\0');
  const rows: NameStatusRow[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i] ?? '';
    if (status === '') break;
    if (status[0] === 'R' || status[0] === 'C') {
      rows.push({ status, from: fields[i + 1] ?? '', to: fields[i + 2] ?? '' });
      i += 3;
    } else {
      const path = fields[i + 1] ?? '';
      rows.push({ status, from: path, to: path });
      i += 2;
    }
  }
  return rows;
}

export interface TreeLongEntry {
  mode: string;
  type: string;
  object: string;
  size: number;
  path: string;
}

export function parseTreeLongEntriesZ(out: string): TreeLongEntry[] {
  const entries: TreeLongEntry[] = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const tabIdx = record.indexOf('\t');
    if (tabIdx < 0) continue;
    const [mode = '', type = '', object = '', sizeRaw = '0'] = record
      .slice(0, tabIdx)
      .trim()
      .split(/\s+/);
    const size = Number(sizeRaw);
    entries.push({
      mode,
      type,
      object,
      size: Number.isFinite(size) ? size : 0,
      path: record.slice(tabIdx + 1),
    });
  }
  return entries;
}

function rawZ(git: SimpleGit, args: string[]): Promise<string> {
  const [subcommand = '', ...rest] = args;
  return git.raw([subcommand, '-z', ...rest]);
}

export async function listNames(git: SimpleGit, args: string[]): Promise<string[]> {
  return splitNulSeparatedPaths(await rawZ(git, args));
}

export async function listPorcelainPaths(
  git: SimpleGit,
  args: string[] = ['status', '--porcelain'],
): Promise<string[]> {
  return parsePorcelainPaths(await rawZ(git, args));
}

export async function listPorcelainEntries(
  git: SimpleGit,
  args: string[] = ['status', '--porcelain'],
): Promise<PorcelainEntry[]> {
  return parsePorcelainEntries(await rawZ(git, args));
}

export async function listNameStatus(git: SimpleGit, args: string[]): Promise<NameStatusRow[]> {
  return parseNameStatusZ(await rawZ(git, args));
}

export async function listTreeLongEntries(
  git: SimpleGit,
  args: string[],
): Promise<TreeLongEntry[]> {
  return parseTreeLongEntriesZ(await rawZ(git, args));
}
