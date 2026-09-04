import { getHeadingSlug, type HeadingEntry } from './slug.ts';

const ATX_HEADING_RE = /^(#{1,6})\s+(.+)$/;

export function scanHeadingLine(
  line: string,
  slugCounts: Map<string, number>,
): HeadingEntry | null {
  const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
  const match = stripped.match(ATX_HEADING_RE);
  if (!match) return null;
  const text = match[2].trim();
  const slug = getHeadingSlug(text, slugCounts);
  if (!slug) return null;
  return { level: match[1].length, text, slug };
}
