import { type NextRequest, NextResponse } from 'next/server';

export const MARKDOWN_MEDIA_TYPES = ['text/markdown', 'text/x-markdown'];

interface AcceptEntry {
  range: string;
  q: number;
  index: number;
}

function parseAccept(header: string): AcceptEntry[] {
  const entries: AcceptEntry[] = [];

  header.split(',').forEach((part, index) => {
    const [rangeText, ...parameters] = part.split(';');
    const range = rangeText.trim().toLowerCase();
    if (!range.includes('/')) return;

    let q = 1;
    for (const parameter of parameters) {
      const separator = parameter.indexOf('=');
      if (separator === -1) continue;
      if (parameter.slice(0, separator).trim().toLowerCase() !== 'q') continue;
      const value = Number.parseFloat(parameter.slice(separator + 1).trim());
      if (Number.isNaN(value)) return;
      q = Math.min(1, Math.max(0, value));
    }

    entries.push({ range, q, index });
  });

  return entries;
}

function specificity(range: string): number {
  if (range === '*/*') return 0;
  if (range.endsWith('/*')) return 1;
  return 2;
}

function outranks(candidate: AcceptEntry, incumbent: AcceptEntry): boolean {
  if (candidate.q !== incumbent.q) return candidate.q > incumbent.q;
  const bySpecificity = specificity(candidate.range) - specificity(incumbent.range);
  if (bySpecificity !== 0) return bySpecificity > 0;
  return candidate.index < incumbent.index;
}

function bestMatch(
  entries: AcceptEntry[],
  matches: (range: string) => boolean,
): AcceptEntry | undefined {
  let best: AcceptEntry | undefined;
  for (const entry of entries) {
    if (!matches(entry.range)) continue;
    if (!best) {
      best = entry;
      continue;
    }
    const bySpecificity = specificity(entry.range) - specificity(best.range);
    if (bySpecificity > 0 || (bySpecificity === 0 && entry.q > best.q)) best = entry;
  }
  return best;
}

const isMarkdownRange = (range: string) => MARKDOWN_MEDIA_TYPES.includes(range);
const coversHtml = (range: string) =>
  range === 'text/html' || range === 'text/*' || range === '*/*';

export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;

  const entries = parseAccept(accept);
  const markdown = bestMatch(entries, isMarkdownRange);
  if (!markdown || markdown.q === 0) return false;

  const html = bestMatch(entries, coversHtml);
  return !html || outranks(markdown, html);
}

export function markdownRewrite(request: NextRequest, handler: string | null): NextResponse | null {
  if (!handler || !prefersMarkdown(request.headers.get('accept'))) return null;

  const target = new URL(handler, request.nextUrl.origin);
  target.search = request.nextUrl.search;
  return NextResponse.rewrite(target);
}
