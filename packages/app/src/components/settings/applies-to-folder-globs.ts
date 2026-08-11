/**
 * Folder-picker model for the frontmatter plugin's `appliesTo` globs. The
 * picker is a checkbox folder tree that authors the one glob shape a checkbox
 * can honestly mean — `folder/**`, everything under the folder — while leaving
 * every other authored pattern untouched, so the raw pill input stays a
 * power-user escape hatch rather than a competing source of truth.
 *
 * Checked-state derivation reuses core's `summarizeAppliesTo` classifier: a
 * pattern reads as "folder F is checked" exactly when the plain-language
 * summary would call it "everything under F/". The two surfaces can't drift —
 * whatever the summary line names as a recursive folder, the tree shows as
 * checked, and vice versa.
 */

import { compileAppliesTo, summarizeAppliesTo } from '@inkeep/open-knowledge-core';

/** The glob the picker authors for a folder: every doc under it, recursively. */
export function folderRecursiveGlob(folder: string): string {
  return `${folder}/**`;
}

/**
 * The folder a single non-negated pattern selects, or null when the pattern
 * isn't a plain recursive-folder glob (`F/**`, with or without a trailing
 * `/*`). Null for negations
 * and for anything the picker shouldn't claim to own (brace sets, `*`s in the
 * folder segment, exact docs...).
 */
export function folderOfGlob(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed === '' || trimmed.startsWith('!')) return null;
  const { includes, excludes } = summarizeAppliesTo(trimmed);
  if (excludes.length > 0 || includes.length !== 1) return null;
  const only = includes[0];
  return only !== undefined && only.kind === 'folder-recursive' ? only.folder : null;
}

/** Folders the authored glob list currently selects (recursive globs only). */
export function selectedFolders(globs: readonly string[]): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const glob of globs) {
    const folder = folderOfGlob(glob);
    if (folder !== null) selected.add(folder);
  }
  return selected;
}

/**
 * Toggle a folder's recursive glob in the authored list. Checking appends
 * `folder/**` (a no-op when an equivalent spelling is already authored);
 * unchecking removes every pattern that selects exactly that folder and
 * nothing else — hand-authored patterns, negations included, pass through.
 */
export function toggleFolderGlob(globs: readonly string[], folder: string, on: boolean): string[] {
  if (on) {
    if (selectedFolders(globs).has(folder)) return [...globs];
    return [...globs, folderRecursiveGlob(folder)];
  }
  return globs.filter((glob) => folderOfGlob(glob) !== folder);
}

/** True when some strict ancestor of `folder` is in the selected set. */
export function coveredByAncestor(folder: string, selected: ReadonlySet<string>): boolean {
  let slash = folder.lastIndexOf('/');
  while (slash > 0) {
    if (selected.has(folder.slice(0, slash))) return true;
    slash = folder.lastIndexOf('/', slash - 1);
  }
  return false;
}

export interface FolderTreeRow {
  /** Content-relative folder path (`guides/api`). */
  path: string;
}

/**
 * Flatten folder paths into depth-first display rows, siblings sorted by
 * locale. Ancestors absent from the input (a server list can name `a/b`
 * without `a`) are materialized so every row hangs off a visible parent.
 */
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

/**
 * Doc counts per folder, each doc counting toward every ancestor. Keys are
 * folder paths; folders holding no docs (directly or below) are absent.
 */
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

/**
 * How many of the project's docs the authored pattern set matches right now.
 * The live counterpart to the server's after-the-fact zero-match warning:
 * `blog` (instead of `blog/**`) reads "0 of N" the moment it's typed.
 */
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
