import { compileAppliesTo, summarizeAppliesTo } from '@inkeep/open-knowledge-core';

export function folderRecursiveGlob(folder: string): string {
  return `${folder}/**`;
}

export function folderOfGlob(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed === '' || trimmed.startsWith('!')) return null;
  const { includes, excludes } = summarizeAppliesTo(trimmed);
  if (excludes.length > 0 || includes.length !== 1) return null;
  const only = includes[0];
  return only !== undefined && only.kind === 'folder-recursive' ? only.folder : null;
}

export function selectedFolders(globs: readonly string[]): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const glob of globs) {
    const folder = folderOfGlob(glob);
    if (folder !== null) selected.add(folder);
  }
  return selected;
}

export function toggleFolderGlob(globs: readonly string[], folder: string, on: boolean): string[] {
  if (on) {
    if (selectedFolders(globs).has(folder)) return [...globs];
    return [...globs, folderRecursiveGlob(folder)];
  }
  return globs.filter((glob) => folderOfGlob(glob) !== folder);
}

export function coveredByAncestor(folder: string, selected: ReadonlySet<string>): boolean {
  let slash = folder.lastIndexOf('/');
  while (slash > 0) {
    if (selected.has(folder.slice(0, slash))) return true;
    slash = folder.lastIndexOf('/', slash - 1);
  }
  return false;
}

export interface FolderTreeRow {
  path: string;
}

export function buildFolderRows(folderPaths: Iterable<string>): FolderTreeRow[] {
  const paths = new Set<string>();
  for (const raw of folderPaths) {
    const path = raw.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '');
    if (path === '' || path === '.') continue;
    paths.add(path);
    let slash = path.lastIndexOf('/');
    while (slash > 0) {
      paths.add(path.slice(0, slash));
      slash = path.lastIndexOf('/', slash - 1);
    }
  }

  const childrenOf = new Map<string, string[]>();
  for (const path of paths) {
    const slash = path.lastIndexOf('/');
    const parent = slash === -1 ? '' : path.slice(0, slash);
    const siblings = childrenOf.get(parent);
    if (siblings === undefined) childrenOf.set(parent, [path]);
    else siblings.push(path);
  }

  const rows: FolderTreeRow[] = [];
  const visit = (parent: string): void => {
    const children = childrenOf.get(parent);
    if (children === undefined) return;
    children.sort((a, b) => a.localeCompare(b));
    for (const path of children) {
      rows.push({ path });
      visit(path);
    }
  };
  visit('');
  return rows;
}

export function docCountsByFolder(docNames: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const docName of docNames) {
    let slash = docName.lastIndexOf('/');
    while (slash > 0) {
      const folder = docName.slice(0, slash);
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
      slash = docName.lastIndexOf('/', slash - 1);
    }
  }
  return counts;
}

export function countMatchingDocs(
  appliesTo: string | string[] | undefined,
  docNames: Iterable<string>,
): { matched: number; total: number } {
  const compiled = compileAppliesTo(appliesTo);
  let matched = 0;
  let total = 0;
  for (const docName of docNames) {
    total += 1;
    if (compiled.matches(docName)) matched += 1;
  }
  return { matched, total };
}
