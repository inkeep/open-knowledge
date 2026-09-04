export interface Workspace {
  readonly contentDir: string;
  readonly pathSeparator: '/' | '\\';
}

export function joinWorkspacePath(contentDir: string, relative: string, sep: '/' | '\\'): string {
  const normalizedRelative = sep === '\\' ? relative.replaceAll('/', '\\') : relative;
  const trimmedDir = contentDir.endsWith(sep) ? contentDir.slice(0, -1) : contentDir;
  return `${trimmedDir}${sep}${normalizedRelative}`;
}

const MARKDOWN_EXTENSION = /\.(md|mdx)$/i;

export function docNameToRelativePath(docName: string): string {
  return MARKDOWN_EXTENSION.test(docName) ? docName : `${docName}.md`;
}
