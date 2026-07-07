export interface ResolvedInternalHref {
  docName: string;
  anchor: string | null;
}

/**
 * Canonical resolution for markdown hrefs that target docs inside the content
 * tree. Server and app surfaces share this so "is this internal?" stays
 * consistent across backlinks, WYSIWYG rendering, and source-mode navigation.
 */
export function resolveInternalHref(
  href: string,
  sourceDocName: string,
): ResolvedInternalHref | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  // External: URI scheme, protocol-relative, or anchor-only. Leading-slash
  // paths are content-root-relative inside OK markdown.
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) return null;
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) return null;

  const hashIdx = trimmed.indexOf('#');
  const pathPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const anchor = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : null;

  const cleanPath = (pathPart.split('?')[0] ?? '').trim();
  if (!cleanPath) return null;

  // Reject paths whose LAST segment has a non-markdown extension — those
  // are asset references (PDFs, video, audio, archives, etc.), not doc
  // links. Without this guard, `docs/meeting.pdf` resolves as a doc named
  // `docs/meeting.pdf` and the click dispatcher tries to navigate OK's
  // router to that nonexistent doc.
  const lastSegment = cleanPath.split('/').pop() ?? '';
  const extMatch = lastSegment.match(/\.([a-z0-9]+)$/i);
  if (extMatch) {
    const ext = (extMatch[1] ?? '').toLowerCase();
    if (ext !== 'md' && ext !== 'mdx') return null;
  }

  // Strip the canonical doc extensions case-insensitively (see
  // packages/server/src/doc-extensions.ts for the server-side source of
  // truth — core can't import from server, so the list is inlined here and
  // kept narrow: .md + .mdx).
  const lower = cleanPath.toLowerCase();
  const withoutExt = lower.endsWith('.mdx')
    ? cleanPath.slice(0, -4)
    : lower.endsWith('.md')
      ? cleanPath.slice(0, -3)
      : cleanPath;
  const isRootRelative = withoutExt.startsWith('/');
  const effectivePath = isRootRelative ? withoutExt.slice(1) : withoutExt;
  const dirParts = isRootRelative
    ? []
    : sourceDocName.includes('/')
      ? sourceDocName.split('/').slice(0, -1)
      : [];

  for (const seg of effectivePath.split('/')) {
    if (seg === '..') {
      if (dirParts.length === 0) return null;
      dirParts.pop();
    } else if (seg !== '.' && seg !== '') {
      dirParts.push(seg);
    }
  }

  if (dirParts.length === 0) return null;
  return { docName: dirParts.join('/'), anchor: anchor || null };
}
