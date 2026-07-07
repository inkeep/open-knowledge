/**
 * PDF anchor parser. Splits a wikiLinkEmbed `anchor` slot into
 * `{height, viewerFragment}` for the `Pdf.tsx` canonical:
 *
 *   - `height=N` → extracted (and dropped from the viewer fragment)
 *     because it's a viewer-chrome parameter, not a PDF Open Parameter.
 *   - All remaining `key=value` pairs re-join into `viewerFragment`.
 *     `Pdf.tsx` interprets `page=N` from this fragment to scroll the
 *     matching `<canvas>` slot into view on first render. Other keys
 *     (`zoom=N`, `search=...`, future PDF Open Parameters) are
 *     preserved on the fragment for forward-compat — the canvas
 *     renderer ignores them today, but keeping them on the parsed
 *     anchor means future features can wire support without touching
 *     the parser.
 *   - Empty / malformed anchors return `{height: null, viewerFragment: ''}`.
 *
 * Lives in `core/utils` (not `app/`) so the precision test suite can
 * exercise it without crossing the core→app dependency direction.
 */

export interface PdfAnchorParts {
  height: number | null;
  viewerFragment: string;
}

export function parsePdfAnchor(anchor: string | undefined | null): PdfAnchorParts {
  if (!anchor) return { height: null, viewerFragment: '' };
  const segments = anchor.split('&').filter((s) => s.length > 0);
  let height: number | null = null;
  const viewerSegments: string[] = [];
  for (const segment of segments) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx === -1) {
      // Bare token (no `=`) — pass through to the viewer fragment.
      viewerSegments.push(segment);
      continue;
    }
    const key = segment.slice(0, eqIdx);
    const value = segment.slice(eqIdx + 1);
    if (key === 'height') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed) && parsed > 0) height = parsed;
      continue;
    }
    viewerSegments.push(segment);
  }
  return { height, viewerFragment: viewerSegments.join('&') };
}
