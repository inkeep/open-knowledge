import type { Text } from '@codemirror/state';
import {
  createCodeFenceTracker,
  FM_FENCE_LINE_RE,
  scanHeadingLine,
} from '@inkeep/open-knowledge-core';

export interface SourceHeadingLine {
  /** Matches the slug of the server-produced outline row at the same ordinal. */
  slug: string;
  /** Line start, before the hashes, which is where outline navigation puts the caret. */
  from: number;
}

let cachedDoc: Text | null = null;
let cachedEntries: SourceHeadingLine[] = [];

/**
 * Enumerate a source document's heading lines in document order.
 *
 * Both source-mode consumers join onto the server's outline by ordinal: a
 * clicked outline row navigates to the nth entry, and active-heading tracking
 * measures the nth entry's line geometry. Admitting a line the server skips (or
 * the reverse) shifts every entry after it, so line admission is delegated
 * wholesale to `scanHeadingLine` and the shared code-fence tracker rather than
 * re-decided here.
 *
 * The result is cached against the `Text` instance. Tracking re-resolves every
 * heading per animation frame, and `Text` is immutable, so instance identity is
 * a sound document-version key. The return is `readonly` because it is the very
 * cached array — a caller mutation would corrupt every later same-`Text` read.
 */
export function sourceHeadingLines(doc: Text): readonly SourceHeadingLine[] {
  if (doc === cachedDoc) return cachedEntries;
  const entries = scanDoc(doc);
  cachedDoc = doc;
  cachedEntries = entries;
  return entries;
}

function scanDoc(doc: Text): SourceHeadingLine[] {
  const entries: SourceHeadingLine[] = [];
  const slugCounts = new Map<string, number>();
  const isInCodeFence = createCodeFenceTracker();

  for (let i = frontmatterBodyStart(doc); i <= doc.lines; i++) {
    const line = doc.line(i);
    if (isInCodeFence(line.text)) continue;
    const heading = scanHeadingLine(line.text, slugCounts);
    if (heading) entries.push({ slug: heading.slug, from: line.from });
  }

  return entries;
}

/**
 * Number of the first body line: past the frontmatter region when the document
 * opens with a closed `---` fence, else line 1. An unclosed opener is body, the
 * same reading the server's frontmatter partition takes, so `# …` lines under it
 * count as headings for both producers.
 */
function frontmatterBodyStart(doc: Text): number {
  if (!isFenceLine(doc.line(1).text)) return 1;
  for (let i = 2; i <= doc.lines; i++) {
    if (isFenceLine(doc.line(i).text)) return i + 1;
  }
  return 1;
}

/**
 * Tolerate a trailing CR, as `scanHeadingLine` and `createCodeFenceTracker` both
 * do. CodeMirror strips CR when it builds a document, so no production caller
 * reaches here with one — but leaving the third predicate in this file the only
 * CR-intolerant one makes correctness depend on that, and a caller handing over a
 * hand-built `Text` would silently mis-partition frontmatter and shift every
 * ordinal after it.
 */
function isFenceLine(line: string): boolean {
  return FM_FENCE_LINE_RE.test(line.endsWith('\r') ? line.slice(0, -1) : line);
}
