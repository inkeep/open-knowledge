import { stripMdExt } from '../constants/cc1.ts';
import { SUPPORTED_DOC_EXTENSIONS } from '../constants/doc-extensions.ts';

export interface ResolvedInternalHref {
  docName: string;
  anchor: string | null;
}

/**
 * Decode one percent-encoded path segment of an internal href. Applied per
 * raw `/`-delimited segment (never to the whole path) so an escaped `%2F`
 * stays segment data instead of becoming a separator — RFC 3986 §3.3: an
 * escaped octet is data, not hierarchy.
 */
export function decodeHrefPathSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // RFC 3986 §2.1: an invalid escape (`%ZZ`, lone `%`) is not an escape —
    // treat the bytes literally rather than throwing.
    return segment;
  }
  // Refuse any decode that would mint hierarchy (`/`, and `\` — a separator on
  // Windows), traversal (`.`/`..`), or a NUL: the encoded form must never gain
  // path semantics it didn't have.
  //
  // This refusal is what keeps `resolveInternalHref`'s walk safe: that walk
  // applies its `.`/`..` semantics to the DECODED segment, so an escaped
  // traversal stays data only because it never decodes here in the first place.
  // Softening this would silently make `./%2E%2E/secret.md` traverse.
  //
  // A leading drive qualifier (`D:`) is deliberately NOT refused. Refusing it
  // here would only cover the escaped spelling — a plainly-written `/D:foo.png`
  // never reaches this function, since a segment without `%` returns above — so
  // the guard would read as complete while covering half the cases. It would
  // also break this module's round-trip invariant for `D:plan`, a legal POSIX
  // filename, stranding it permanently unresolvable through an encoded link:
  // the same "valid name reads as dead link" failure this decoding exists to
  // remove. Containment against both spellings is enforced downstream, where it
  // can be complete — realpath plus a content-dir check on the server, and
  // `openAssetSafely` in desktop.
  if (
    decoded === '.' ||
    decoded === '..' ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0')
  ) {
    return segment;
  }
  return decoded;
}

/**
 * Inverse of `decodeHrefPathSegment`: encode one path segment for emission into
 * a markdown link destination. Applied per `/`-delimited segment so `/` stays
 * hierarchy, and beyond `encodeURIComponent` it also neutralizes `!'()*` so an
 * unbalanced paren can never terminate a bare CommonMark destination.
 *
 * Every href OK emits must round-trip: `decodeHrefPathSegment(encodeHrefPathSegment(s)) === s`.
 * Emitting a raw segment instead leaks spaces and `#`/`?` into the destination,
 * where a parser reads them as the end of the link.
 */
export function encodeHrefPathSegment(segment: string): string {
  // Traversal markers are structure, not data — encoding them would break the
  // relative path they belong to.
  if (segment === '.' || segment === '..') return segment;
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.codePointAt(0)?.toString(16).toUpperCase()}`,
  );
}

/** Per-segment `encodeHrefPathSegment` across a `/`-delimited path. */
export function encodeHrefPath(path: string): string {
  return path.split('/').map(encodeHrefPathSegment).join('/');
}

/** Per-segment `decodeHrefPathSegment` across a `/`-delimited path. */
export function decodeHrefPath(path: string): string {
  return path.split('/').map(decodeHrefPathSegment).join('/');
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
  //
  // The extension is read AFTER decoding, matching the decode the resolution
  // loop below applies: `./meeting%2Epdf` carries no literal dot, so a raw
  // read sees no extension and admits the asset as a doc — the guard has to
  // see the same bytes the resolved docName would be built from.
  const lastSegment = decodeHrefPathSegment(cleanPath.split('/').pop() ?? '');
  //
  // The admitted set comes from `SUPPORTED_DOC_EXTENSIONS` rather than being
  // spelled out here, because admission and stripping have to stay in step: an
  // extension admitted here but not stripped below lands in the docName, which
  // is extension-less by contract. The strip is `stripMdExt`, core's single
  // spelling of that grammar — it carries its own `.mdx?` regex, so a third
  // supported extension needs updating there too.
  const extMatch = lastSegment.match(/\.([a-z0-9]+)$/i);
  if (extMatch) {
    const ext = `.${(extMatch[1] ?? '').toLowerCase()}`;
    if (!(SUPPORTED_DOC_EXTENSIONS as readonly string[]).includes(ext)) return null;
  }

  const isRootRelative = cleanPath.startsWith('/');
  const effectivePath = isRootRelative ? cleanPath.slice(1) : cleanPath;
  const dirParts = isRootRelative
    ? []
    : sourceDocName.includes('/')
      ? sourceDocName.split('/').slice(0, -1)
      : [];

  // Each segment is decoded, and the final one additionally has its doc
  // extension stripped, BEFORE the traversal semantics below run. Order is
  // load-bearing in both directions:
  //
  //   - decode before traversal, so `./meeting%2Emd` — which carries no literal
  //     `.md` — still strips to an extension-less docName. OK docNames never
  //     carry an extension.
  //   - strip before traversal, so what the strip leaves behind is still read as
  //     a path segment: `./...md` must reduce to `..` and pop, not land in the
  //     docName as a literal `notes/..`. A docName bearing `.`/`..` gets
  //     indexed, graphed, and offered for creation as a wrong-doc resolution
  //     long before any downstream containment check sees it.
  const segments = effectivePath.split('/');
  const lastSegmentIndex = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    let seg = decodeHrefPathSegment(segments[i] ?? '');
    if (i === lastSegmentIndex) seg = stripMdExt(seg);
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
