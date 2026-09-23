import { decodeHrefPath, isExternalHref } from '@inkeep/open-knowledge-core';
import { docNameFromAbsolutePath } from '@/components/acp/follow-file';
import { hashFromDocName } from '@/lib/doc-hash';
import type { Workspace } from '@/lib/workspace-paths';

export type DocPathResolver = (candidate: string) => string | null;

const DOC_PATH_REGEX = /(?<![A-Za-z0-9_./@-])[A-Za-z0-9_./@-]+\.(?:md|mdx)\b(?:#[A-Za-z0-9_-]+)?/g;

export interface BuildDocPathResolverInput {
  readonly workspace: Workspace | null;
  readonly pages: ReadonlySet<string>;
}

export function buildDocPathResolver(input: BuildDocPathResolverInput): DocPathResolver | null {
  const { workspace, pages } = input;
  if (workspace === null || pages.size === 0) return null;

  return (candidate: string): string | null => {
    const hashIdx = candidate.indexOf('#');
    const path = (hashIdx === -1 ? candidate : candidate.slice(0, hashIdx)).replace(/^@/, '');
    if (path === '') return null;

    const asAbsolute = docNameFromAbsolutePath(path, workspace);
    if (asAbsolute !== null && pages.has(asAbsolute)) return asAbsolute;

    const composed = joinWorkspaceRelative(workspace, path);
    if (composed !== null) {
      const composedDoc = docNameFromAbsolutePath(composed, workspace);
      if (composedDoc !== null && pages.has(composedDoc)) return composedDoc;
    }

    const stripped = stripMarkdownExt(path);
    if (stripped === null) return null;
    if (pages.has(stripped)) return stripped;
    const suffix = `/${stripped}`;
    let match: string | null = null;
    for (const doc of pages) {
      if (doc === stripped || doc.endsWith(suffix)) {
        if (match !== null) return null;
        match = doc;
      }
    }
    return match;
  };
}

function joinWorkspaceRelative(workspace: Workspace, relative: string): string | null {
  if (relative.startsWith('/') || relative.startsWith('\\')) return null;
  const sep = workspace.pathSeparator;
  const normalize = (p: string): string => (sep === '\\' ? p.replaceAll('\\', '/') : p);
  const contentDir = normalize(workspace.contentDir).replace(/\/$/, '');
  const normalizedRel = normalize(relative);
  const contentSegments = contentDir.split('/');
  const relFirstSegment = normalizedRel.split('/')[0];
  if (relFirstSegment === undefined || relFirstSegment === '') return null;
  for (let i = contentSegments.length - 1; i >= 0; i -= 1) {
    if (contentSegments[i] === relFirstSegment) {
      const prefix = contentSegments.slice(0, i).join('/');
      return prefix === '' ? `/${normalizedRel}` : `${prefix}/${normalizedRel}`;
    }
  }
  return null;
}

function stripMarkdownExt(path: string): string | null {
  const match = /\.(?:md|mdx)$/i.exec(path);
  if (match === null) return null;
  return path.slice(0, -match[0].length);
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdastNode[];
}

let currentResolver: DocPathResolver | null = null;

export function setDocPathResolver(resolver: DocPathResolver | null): void {
  currentResolver = resolver;
}

export function remarkDocPathLinks() {
  return () =>
    (tree: MdastNode): void => {
      const resolver = currentResolver;
      if (resolver === null) return;
      try {
        rewriteNode(tree, resolver);
      } catch (err) {
        console.warn('[remarkDocPathLinks] rewrite failed, partial rewrites may remain', err);
      }
    };
}

function rewriteNode(node: MdastNode | undefined, resolver: DocPathResolver): void {
  if (node === undefined || node === null) return;
  const children = node.children;
  if (children === undefined) return;
  const next: MdastNode[] = [];
  for (const child of children) {
    if (child === undefined || child === null) continue;
    if (child.type === 'link' || child.type === 'definition') {
      const target = typeof child.url === 'string' ? resolveLinkUrl(child.url, resolver) : null;
      next.push(
        target === null ? child : { ...child, url: hashFromDocName(target.docName, target.anchor) },
      );
      continue;
    }
    if (child.type === 'text' && typeof child.value === 'string') {
      next.push(...splitTextByPaths(child.value, resolver));
      continue;
    }
    if (child.type === 'inlineCode' && typeof child.value === 'string') {
      const target = resolveTarget(child.value.trim(), resolver);
      if (target === null) {
        next.push(child);
      } else {
        next.push({
          type: 'link',
          url: hashFromDocName(target.docName, target.anchor),
          title: null,
          children: [child],
        });
      }
      continue;
    }
    rewriteNode(child, resolver);
    next.push(child);
  }
  node.children = next;
}

const FILE_SCHEME = /^file:\/\//i;
const FILE_DRIVE_SLASH = /^\/(?=[a-z]:(?:$|[/\\?]))/i;
const WINDOWS_DRIVE = /^[a-z]:(?:$|[/\\?])/i;

interface LinkTarget {
  docName: string;
  anchor: string | null;
}

function splitFragment(candidate: string): { path: string; anchor: string | null } {
  const hashIdx = candidate.indexOf('#');
  if (hashIdx === -1) return { path: candidate, anchor: null };
  return { path: candidate.slice(0, hashIdx), anchor: candidate.slice(hashIdx + 1) || null };
}

function resolveTarget(candidate: string, resolver: DocPathResolver): LinkTarget | null {
  const { path, anchor } = splitFragment(candidate);
  if (path === '') return null;
  const docName = resolver(path);
  return docName === null ? null : { docName, anchor };
}

function resolveLinkUrl(url: string, resolver: DocPathResolver): LinkTarget | null {
  const { path: rawPath, anchor } = splitFragment(url);
  if (rawPath === '') return null;
  const path = FILE_SCHEME.test(rawPath)
    ? rawPath.replace(FILE_SCHEME, '').replace(FILE_DRIVE_SLASH, '')
    : rawPath;
  if (isForeignScheme(path)) return null;
  const decoded = decodeHrefPath(path);
  if (isForeignScheme(decoded)) return null;
  const docName = resolver(decoded);
  return docName === null ? null : { docName, anchor };
}

function isForeignScheme(path: string): boolean {
  return isExternalHref(path) && !WINDOWS_DRIVE.test(path);
}

function splitTextByPaths(value: string, resolver: DocPathResolver): MdastNode[] {
  const out: MdastNode[] = [];
  let cursor = 0;
  const regex = new RegExp(DOC_PATH_REGEX.source, DOC_PATH_REGEX.flags);
  let match: RegExpExecArray | null = regex.exec(value);
  while (match !== null) {
    const [candidate] = match;
    const start = match.index;
    const target = resolveTarget(candidate, resolver);
    if (target !== null) {
      if (start > cursor) {
        out.push({ type: 'text', value: value.slice(cursor, start) });
      }
      out.push({
        type: 'link',
        url: hashFromDocName(target.docName, target.anchor),
        title: null,
        children: [{ type: 'text', value: candidate }],
      });
      cursor = start + candidate.length;
    }
    match = regex.exec(value);
  }
  if (cursor === 0) return [{ type: 'text', value }];
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) });
  }
  return out;
}
