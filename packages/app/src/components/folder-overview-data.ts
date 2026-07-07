import type { PageMeta } from './PageListContext';

export type FolderOverviewEntry =
  | { kind: 'folder'; path: string; name: string; title: string }
  | { kind: 'file'; path: string; name: string; title: string; size: number; modified: string };

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

export function buildFolderOverviewData(
  folderPath: string,
  options: {
    pages: ReadonlySet<string>;
    pageTitles: ReadonlyMap<string, string>;
    pageMeta: ReadonlyMap<string, PageMeta>;
    folderPaths: ReadonlySet<string>;
  },
): FolderOverviewData {
  // Content-root (`folderPath === ''`) has no path prefix — every top-level
  // docName / folderPath is a direct child. A naive `${folderPath}/` would
  // produce `'/'`, which `startsWith` never matches against the unrooted
  // docNames the page list stores (`intro`, `docs/a`), yielding an empty
  // root overview. Root-folder shares and the in-app root view both
  // depend on this.
  const prefix = folderPath === '' ? '' : `${folderPath}/`;

  const folders: FolderOverviewEntry[] = [...options.folderPaths]
    .filter((path) => path.startsWith(prefix))
    .map((path) => ({ path, rel: path.slice(prefix.length) }))
    .filter((e) => e.rel.length > 0 && !e.rel.includes('/'))
    .map(({ path, rel }) => ({
      kind: 'folder' as const,
      path,
      name: rel,
      title: getFolderTitle(path, options.pageTitles),
    }));

  const files: FolderOverviewEntry[] = [...options.pages]
    .filter((docName) => docName.startsWith(prefix))
    .map((docName) => ({ docName, rel: docName.slice(prefix.length) }))
    .filter((e) => e.rel.length > 0 && !e.rel.includes('/'))
    .map(({ docName, rel }) => {
      const meta = options.pageMeta.get(docName);
      return {
        kind: 'file' as const,
        path: docName,
        name: rel,
        title: resolveTitle(docName, rel, options.pageTitles),
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
