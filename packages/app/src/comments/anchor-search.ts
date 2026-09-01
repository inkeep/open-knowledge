import {
  commentLeafText,
  commentQuoteText,
  contextEvidenceFloor,
  contextMatchScore,
  findAllPassages,
  type PassageMatch,
  rewriteCeiling,
} from '@inkeep/open-knowledge-core';
import type { Node as PMNode } from '@tiptap/pm/model';

interface TextIndex {
  text: string;
  positions: number[];
}

export interface AnchorContext {
  prefix?: string;
  suffix?: string;
}

export function buildTextIndex(
  doc: PMNode,
  { includeBlockComponents = false }: { includeBlockComponents?: boolean } = {},
): TextIndex {
  let text = '';
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        text += node.text[i];
        positions.push(pos + i);
      }
      return true;
    }
    if (node.isBlock && !includeBlockComponents) return true;
    const leaf = commentLeafText(node);
    if (leaf.length > 0) {
      const last = pos + node.nodeSize - 1;
      for (let i = 0; i < leaf.length; i++) {
        text += leaf[i];
        positions.push(i === leaf.length - 1 ? last : pos);
      }
    }
    return true;
  });
  return { text, positions };
}

function allOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === '') return out;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

function findBetweenBrackets(
  text: string,
  quote: string,
  context?: AnchorContext,
): PassageMatch | null {
  const prefix = context?.prefix ?? '';
  const suffix = context?.suffix ?? '';
  if (prefix === '' && suffix === '') return null;

  const starts =
    prefix === ''
      ? [0]
      : findAllPassages(text, prefix, { syntaxIn: 'needle' }).map((hit) => hit.end);
  const ends =
    suffix === ''
      ? [text.length]
      : findAllPassages(text, suffix, { syntaxIn: 'needle' }).map((hit) => hit.start);
  if (starts.length !== 1 || ends.length !== 1) return null;

  let start = starts[0];
  let end = ends[0];
  while (start < end && /\s/.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end -= 1;
  if (end <= start) return null;
  const ceiling = rewriteCeiling(quote.length);
  if (end - start > ceiling) return null;
  return { start, end };
}

function toRange(index: TextIndex, hit: PassageMatch): { from: number; to: number } | null {
  const from = index.positions[hit.start];
  const to = index.positions[hit.end - 1];
  if (from == null || to == null) return null;
  return { from, to: to + 1 };
}

export function findRangeInIndex(
  index: TextIndex,
  quote: string,
  context?: AnchorContext,
): { from: number; to: number } | null {
  if (quote.length === 0) return null;
  let hits: PassageMatch[] = allOccurrences(index.text, quote).map((at) => ({
    start: at,
    end: at + quote.length,
  }));
  if (hits.length === 0) hits = findAllPassages(index.text, quote, { syntaxIn: 'needle' });
  if (hits.length === 0) {
    const recovered = findBetweenBrackets(index.text, quote, context);
    return recovered === null ? null : toRange(index, recovered);
  }
  const prefix = context?.prefix ?? '';
  const suffix = context?.suffix ?? '';
  const present = (needle: string): boolean =>
    index.text.includes(needle) ||
    findAllPassages(index.text, needle, { syntaxIn: 'needle' }).length > 0;
  if (
    prefix !== '' &&
    suffix !== '' &&
    !present(prefix + quote + suffix) &&
    present(prefix + suffix)
  ) {
    return null;
  }
  const floor = contextEvidenceFloor({ prefix, suffix }, { syntaxInContext: true });
  const evidence = (hit: PassageMatch): boolean =>
    floor === 0 ||
    contextMatchScore(
      index.text,
      hit,
      { prefix, suffix },
      { syntaxIn: 'none', syntaxInContext: true },
    ) >= floor;
  if (hits.length === 1) {
    if (!evidence(hits[0])) {
      const recovered = findBetweenBrackets(index.text, quote, context);
      return recovered === null ? null : toRange(index, recovered);
    }
    return toRange(index, hits[0]);
  }

  let best: PassageMatch[] = [];
  let bestScore = -1;
  for (const hit of hits) {
    const score = contextMatchScore(
      index.text,
      hit,
      { prefix, suffix },
      { syntaxIn: 'none', syntaxInContext: true },
    );
    if (score > bestScore) {
      bestScore = score;
      best = [hit];
    } else if (score === bestScore) {
      best.push(hit);
    }
  }
  if (!evidence(best[0])) {
    const recovered = findBetweenBrackets(index.text, quote, context);
    return recovered === null ? null : toRange(index, recovered);
  }
  return toRange(index, best[0]);
}

const SELECTION_CONTEXT_LEN = 64;

export function captureSelectionContext(
  doc: PMNode,
  from: number,
  to: number,
): { prefix: string; suffix: string } {
  return {
    prefix: commentQuoteText(doc, Math.max(0, from - SELECTION_CONTEXT_LEN), from),
    suffix: commentQuoteText(doc, to, Math.min(doc.content.size, to + SELECTION_CONTEXT_LEN)),
  };
}

export function findQuoteRange(
  doc: PMNode,
  quote: string,
  context?: AnchorContext,
): { from: number; to: number } | null {
  return createAnchorResolver(doc)(quote, context);
}

export function createAnchorResolver(
  doc: PMNode,
): (quote: string, context?: AnchorContext) => { from: number; to: number } | null {
  const prose = buildTextIndex(doc);
  let components: TextIndex | null = null;
  return (quote, context) => {
    const inProse = findRangeInIndex(prose, quote, context);
    if (inProse !== null) return inProse;
    components ??= buildTextIndex(doc, { includeBlockComponents: true });
    return findRangeInIndex(components, quote, context);
  };
}
