/**
 * File — DIY renderer for the `File` canonical.
 *
 * Generic file attachment surface for every dropped attachment, including
 * PDFs (the wikilink form `![[doc.pdf]]` routes here too — explicit
 * `<Pdf>` JSX is the opt-in path for the pdfjs canvas viewer). Renders
 * as a Notion-style inline row: small file-up icon + filename + optional
 * dim size, wrapped in a styled `<a>` link. No card chrome, no border —
 * the row reads as a structural element of the doc, not a callout-shaped
 * block.
 *
 * ── Why an inline row, not a card ────────────────────────────────────────
 *
 * The card shape (background + border + padding) we prototyped reads as
 * a callout — visual weight competes with surrounding prose and pulls
 * the eye out of the document flow. Notion's solution (and what authors
 * recognize as "a file") is the lighter inline row: small icon + bold
 * name + dim size, hover-underline on the name. Stacks of attached files
 * read as a list rather than a series of cards. The substrate is still
 * a plain anchor — every browser default (right-click → Save As,
 * drag-to-desktop, screenreader "link" announcement) keeps working.
 *
 * ── Display-name fallback ────────────────────────────────────────────────
 *
 * `props.name` is optional — when absent, derive a sensible label from
 * `src`'s URL pathname. Plain relative paths (`./report.pdf`) and
 * absolute URLs (`https://host/path/to/report.pdf?v=3`) both collapse to
 * `report.pdf`; the query string and any directory prefix drop out.
 * Falls back to `'Untitled file'` if `src` is empty or malformed — the
 * descriptor's required-`src` contract makes this a near-impossible case
 * outside slash-insert placeholder mode, but the fallback keeps the
 * placeholder pill from rendering an empty span.
 *
 * ── Sanitization ─────────────────────────────────────────────────────────
 *
 * `src` flows through `sanitizeComponentProps` at the JsxComponentView
 * boundary (it is in `URL_PROP_NAMES`). `target="_blank"` +
 * `rel="noopener noreferrer"` prevent reverse-tabnabbing for absolute
 * URLs. The `download` attribute is intentionally absent — see the
 * function-level JSDoc below for the click-vs-download split (preview
 * in new tab on click; explicit save via the bubble-menu Download
 * button when the row is NodeSelected).
 */

import { toDesktopAssetHref } from '@inkeep/open-knowledge-core';
import { FileUp } from 'lucide-react';

interface FileProps {
  src?: string;
  name?: string;
  size?: string;
  title?: string;
}

/**
 * Derive a human-readable filename from a URL or path. Strips the query
 * string + leading directories, percent-decodes the final segment.
 *
 *   `https://host/path/to/report.pdf?v=3`  → `report.pdf`
 *   `./folder/report-2025.zip`             → `report-2025.zip`
 *   `report.docx`                          → `report.docx`
 *   `https://host/path/to/`                → `''`   (trailing slash)
 *   `data:text/plain;base64,SGVsbG8=`      → `''`   (no path component)
 *   `'' | undefined`                       → `''`
 *
 * Pure — exported below for unit tests.
 */
export function basenameFromUrl(src: string | undefined): string {
  if (!src) return '';
  // Try absolute-URL parse first (covers `https://`, `data:`, `blob:`).
  // The placeholder base is only used to satisfy the `URL` constructor
  // for relative paths — the parsed `pathname` is what we read.
  let pathname: string;
  let protocol: string | null = null;
  try {
    const url = new URL(src, 'https://placeholder.local');
    protocol = url.protocol;
    pathname = url.pathname;
  } catch {
    // `new URL()` throws on truly malformed input (rare given the
    // placeholder base). Fall back to dumb-string splitting on `/` and
    // strip any query suffix.
    const before = src.split('?')[0] ?? src;
    pathname = before;
  }
  // `data:` / `blob:` URLs have no usable filename component; the
  // pathname is the encoded payload, not a path. Caller's "Untitled
  // file" fallback applies.
  if (protocol === 'data:' || protocol === 'blob:') return '';
  // Don't `.filter(Boolean)` — a trailing slash should produce an empty
  // last segment (signaling "no filename") rather than collapsing to
  // the parent directory name.
  const segments = pathname.split('/');
  const last = segments[segments.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * DIY File. Descriptor-dispatched via `componentMap['File']`.
 *
 * Click → opens the file in a new tab for preview (browsers render
 * PDFs / images / text inline; opaque types fall through to the
 * browser's download prompt). The handler calls `window.open` directly
 * rather than relying on the `<a target="_blank">` default because
 * ProseMirror's editor-view DOM handlers run alongside React's
 * synthetic events, and any installed extension's `handleClickOn` /
 * `handleClick` config can suppress that default. Driving
 * `window.open` from the React click handler guarantees the new-tab
 * open survives upstream listeners. `stopPropagation` keeps the same
 * click from also landing a NodeSelection on the wrapper.
 *
 * The `download` attribute is intentionally absent — including it
 * would force a download prompt instead of letting the browser
 * preview-render the file in the new tab. Explicit download is
 * surfaced via a separate bubble-menu action for File NodeSelections
 * (see `BubbleMenuBar` File-mode integration), so users who want to
 * save have a direct affordance distinct from the preview-click.
 *
 * Right-click → Save As / Copy Link Address still works normally on
 * the `<a href>` substrate.
 */
export function File(props: FileProps) {
  const displayName = props.name?.trim() || basenameFromUrl(props.src) || 'Untitled file';
  const sizeText = props.size?.trim() ? props.size : null;
  // Under Electron the renderer page origin has no asset middleware — rewrite
  // a server-absolute src onto `apiOrigin` (no-op in web/CLI builds).
  const href = props.src ? toDesktopAssetHref(props.src) : undefined;

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (href) {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <a
      href={href}
      title={props.title}
      className="ok-file-attachment"
      target="_blank"
      rel="noopener noreferrer"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={handleClick}
    >
      <FileUp className="ok-file-icon" aria-hidden="true" />
      <span className="ok-file-name">{displayName}</span>
      {sizeText ? <span className="ok-file-size">{sizeText}</span> : null}
    </a>
  );
}
