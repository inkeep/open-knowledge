import { docNameToTreePath } from './file-tree-adapter';
import type { PageMeta } from './PageListContext';

export type FolderOverviewEntry =
  | { kind: 'folder'; path: string; name: string; title: string; fileName?: string }
  | {
      kind: 'file';
      path: string;
      name: string;
      title: string;
      fileName?: string;
      size: number;
      modified: string;
    };

interface FolderOverviewData {
  title: string;
  children: FolderOverviewEntry[];
}

function getLegacyFolderNoteDocName(folderPath: string): string | null {
  const leaf = folderPath.split('/').pop();
  return leaf ? `${folderPath}/${leaf}` : null;
}

function getFolderTitle(folderPath: string, pageTitles: ReadonlyMap<string, string>): string {
  const canonicalTitle = pageTitles.get(`${folderPath}/index`);
  if (canonicalTitle) {
    return canonicalTitle;
  }

  const legacyFolderNoteDocName = getLegacyFolderNoteDocName(folderPath);
  if (legacyFolderNoteDocName) {
    const legacyTitle = pageTitles.get(legacyFolderNoteDocName);
    if (legacyTitle) {
      return legacyTitle;
    }
  }

  return folderPath.split('/').pop() ?? folderPath;
}

function resolveTitle(
  docNameOrPath: string,
  leafName: string,
  pageTitles: ReadonlyMap<string, string>,
): string {
  const raw = pageTitles.get(docNameOrPath);
  if (raw && raw !== docNameOrPath) return raw;
  return leafName;
}

function fileNameUnlessTitleShowsIt(
  title: string,
  fileName: string,
  stem = fileName,
): string | undefined {
  const label = title.toLocaleLowerCase();
  if (label === stem.toLocaleLowerCase() || label === fileName.toLocaleLowerCase()) {
    return undefined;
  }
  return fileName;
}

export function buildFolderOverviewData(
  folderPath: string,
  options: {
    pages: ReadonlySet<string>;
    pageTitles: ReadonlyMap<string, string>;
    pageMeta: ReadonlyMap<string, PageMeta>;
    folderPaths: ReadonlySet<string>;
  },
): FolderOverviewData {
  const prefix = folderPath === '' ? '' : `${folderPath}/`;

  const folders: FolderOverviewEntry[] = [...options.folderPaths]
    .filter((path) => path.startsWith(prefix))
    .map((path) => ({ path, rel: path.slice(prefix.length) }))
    .filter((e) => e.rel.length > 0 && !e.rel.includes('/'))
    .map(({ path, rel }) => {
      const title = getFolderTitle(path, options.pageTitles);
      return {
        kind: 'folder' as const,
        path,
        name: rel,
        title,
        fileName: fileNameUnlessTitleShowsIt(title, rel),
      };
    });

  const files: FolderOverviewEntry[] = [...options.pages]
    .filter((docName) => docName.startsWith(prefix))
    .map((docName) => ({ docName, rel: docName.slice(prefix.length) }))
    .filter((e) => e.rel.length > 0 && !e.rel.includes('/'))
    .map(({ docName, rel }) => {
      const meta = options.pageMeta.get(docName);
      const title = resolveTitle(docName, rel, options.pageTitles);
      const fileName = docNameToTreePath(rel, meta?.docExt);
      return {
        kind: 'file' as const,
        path: docName,
        name: rel,
        title,
        fileName: fileNameUnlessTitleShowsIt(title, fileName, rel),
        size: meta?.size ?? 0,
        modified: meta?.modified ?? '',
      };
    });

  const children = [...folders, ...files].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.title.localeCompare(b.title) || a.name.localeCompare(b.name);
  });

  return {
    title: getFolderTitle(folderPath, options.pageTitles),
    children,
  };
}
