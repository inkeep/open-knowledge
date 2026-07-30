import { getHeadingSlug, type HeadingEntry } from './slug.ts';

/** ATX heading: 1-6 hashes, whitespace, then non-empty text (CommonMark §4.2). */
const ATX_HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Decide whether one markdown line is an ATX heading and, if so, produce its
 * entry. The `slugCounts` map is caller-owned so duplicate heading text
 * disambiguates across a whole document.
 *
 * This is the one line-shape predicate shared by the server's outline producer
 * (`extractHeadings`) and the client's source-mode enumerator
 * (`sourceHeadingLines`). Those two are joined by ordinal alone, so a line one
 * admits and the other skips shifts every heading after it — a silent off-by-N
 * that surfaces as outline rows pointing at the wrong place.
 *
 * A line whose text slugs to nothing is rejected and does not consume a slug
 * count, so it cannot shift a later duplicate's suffix.
 *
 * Frontmatter and fenced-code regions are the caller's concern; pair this with
 * `createCodeFenceTracker` and a frontmatter partition.
 */
export function scanHeadingLine(
  line: string,
  slugCounts: Map<string, number>,
): HeadingEntry | null {
  // Tolerate a Windows-style CR at the line end, as `createCodeFenceTracker`
  // does: consumers split on '\n' only, so a CRLF document leaves a trailing
  // '\r' that JS `.` cannot match, which would otherwise defeat the anchor and
  // leave every heading in the file unrecognized.
  const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
  const match = stripped.match(ATX_HEADING_RE);
  if (!match) return null;
  const text = match[2].trim();
  const slug = getHeadingSlug(text, slugCounts);
  if (!slug) return null;
  return { level: match[1].length, text, slug };
}
