import type { JSONContent } from '@tiptap/core';
import {
  incrementBlockFallback,
  incrementWholeDocBudgetFallback,
  incrementWholeDocFallback,
} from '../metrics/parse-health.ts';
import { findFencedRegions, isInsideFence } from './fence-regions.ts';
import { hoistRefDefs } from './ref-def-hoist.ts';

export const MAX_SPLIT_DEPTH = 20;

type ParseFn = (markdown: string) => JSONContent;

interface ParseWithFallbackOptions {
  parse: ParseFn;
}

const MAX_PARSE_WALLCLOCK_MS = 500;
const MAX_TOTAL_PARSE_CALLS = 1000;

interface ParseBudget {
  startMs: number;
  calls: number;
}

export function parseWithFallback(source: string, opts: ParseWithFallbackOptions): JSONContent {
  const budget: ParseBudget = {
    startMs:
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
    calls: 0,
  };
  return parseRecursive(source, opts.parse, 0, budget);
}

function budgetExhausted(budget: ParseBudget): boolean {
  if (budget.calls >= MAX_TOTAL_PARSE_CALLS) return true;
  const now =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  return now - budget.startMs >= MAX_PARSE_WALLCLOCK_MS;
}

const MAX_ERROR_MESSAGE_LEN = 500;

function errorPayload(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message.slice(0, MAX_ERROR_MESSAGE_LEN),
      stack: err.stack?.split('\n').slice(0, 4).join('\n'),
    };
  }
  return {
    name: 'UnknownError',
    message: String(err ?? 'unknown').slice(0, MAX_ERROR_MESSAGE_LEN),
  };
}

export function parseRecursive(
  source: string,
  parse: ParseFn,
  depth: number,
  budget?: ParseBudget,
): JSONContent {
  if (depth > MAX_SPLIT_DEPTH) {
    incrementWholeDocFallback();
    console.warn(
      JSON.stringify({ event: 'mdx-whole-doc-fallback', reason: 'MAX_SPLIT_DEPTH exceeded' }),
    );
    return wholeDocRawText(source);
  }

  if (budget) {
    if (budgetExhausted(budget)) {
      incrementWholeDocBudgetFallback();
      console.warn(
        JSON.stringify({
          event: 'mdx-whole-doc-fallback',
          reason: 'parse budget exhausted',
          calls: budget.calls,
        }),
      );
      return wholeDocRawText(source);
    }
    budget.calls += 1;
  }

  try {
    return parse(source);
  } catch (e: unknown) {
    const offset = extractErrorOffset(e);
    const payload = errorPayload(e);
    if (offset === undefined) {
      if (depth === 0) {
        const perBlock = tryPerBlockFallback(source, parse, e, budget);
        if (perBlock) return perBlock;
      }
      incrementWholeDocFallback();
      console.warn(
        JSON.stringify({
          event: 'mdx-whole-doc-fallback',
          reason: payload.message,
          error: payload,
        }),
      );
      return wholeDocRawText(source);
    }

    incrementBlockFallback();
    console.warn(
      JSON.stringify({
        event: 'mdx-block-fallback',
        offset,
        reason: payload.message,
        error: payload,
      }),
    );

    try {
      const region = findFallbackRegion(source, offset);
      const beforeSrc = source.slice(0, region.start);
      const brokenSrc = source.slice(region.start, region.end);
      const afterSrc = source.slice(region.end);

      const beforeDoc = beforeSrc.trim()
        ? parseRecursive(beforeSrc, parse, depth + 1, budget)
        : { type: 'doc' as const, content: [] };
      const afterDoc = afterSrc.trim()
        ? parseRecursive(hoistRefDefs(beforeSrc) + afterSrc, parse, depth + 1, budget)
        : { type: 'doc' as const, content: [] };

      const fallbackNode: JSONContent = {
        type: 'rawMdxFallback',
        attrs: {
          reason: payload.message,
          originalSpan: { start: region.start, end: region.end },
        },
        content: brokenSrc ? [{ type: 'text', text: brokenSrc }] : [],
      };

      const merged: JSONContent[] = [
        ...((beforeDoc.content as JSONContent[]) ?? []),
        fallbackNode,
        ...((afterDoc.content as JSONContent[]) ?? []),
      ];

      return {
        type: 'doc',
        content: merged.length > 0 ? merged : [{ type: 'paragraph', content: [] }],
      };
    } catch (recoveryErr) {
      incrementWholeDocFallback();
      const recoveryPayload = errorPayload(recoveryErr);
      console.warn(
        JSON.stringify({
          event: 'mdx-whole-doc-fallback',
          reason: `Recovery failed: ${recoveryPayload.message}`,
          recoveryPath: 'block-split-then-rejoin',
          error: recoveryPayload,
          originalError: payload,
        }),
      );
      return wholeDocRawText(source);
    }
  }
}

interface VFilePlace {
  offset?: number;
  start?: { offset?: number };
}

function extractErrorOffset(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { place?: VFilePlace; position?: VFilePlace };

  if (e.place && typeof e.place.offset === 'number') return e.place.offset;
  if (e.place?.start && typeof e.place.start.offset === 'number') return e.place.start.offset;
  if (e.position && typeof e.position.offset === 'number') return e.position.offset;
  if (e.position?.start && typeof e.position.start.offset === 'number')
    return e.position.start.offset;

  return undefined;
}

interface Region {
  start: number;
  end: number;
}

function nearestBlankLineBefore(src: string, offset: number): number | null {
  const BLANK_RE = /\n\s*\n/g;
  let best: number | null = null;
  for (const match of src.matchAll(BLANK_RE)) {
    if (match.index >= offset) break;
    best = match.index + match[0].length;
  }
  return best;
}

function nearestBlankLineAfter(src: string, offset: number): number | null {
  const BLANK_RE = /\n\s*\n/g;
  for (const match of src.matchAll(BLANK_RE)) {
    if (match.index >= offset) return match.index;
  }
  return null;
}

export interface TagEvent {
  kind: 'open' | 'close' | 'self-close';
  name: string;
  start: number;
  end: number;
}

interface FallbackRegion {
  start: number;
  end: number;
  source: 'pair' | 'unmatched';
}

const MAX_TAG_SCAN_SPAN = 32 * 1024;

export function scanTagEvents(src: string, fences: Array<[number, number]>): TagEvent[] {
  const events: TagEvent[] = [];
  const TAG_START_RE = /<(\/?)([A-Z][A-Za-z0-9.]*)/g;

  for (const match of src.matchAll(TAG_START_RE)) {
    const tagStartPos = match.index;
    if (isInsideFence(tagStartPos, fences)) continue;

    const isClose = match[1] === '/';
    const name = match[2];
    const scanStart = tagStartPos + match[0].length;
    const scanEnd = Math.min(src.length, scanStart + MAX_TAG_SCAN_SPAN);
    let inDoubleQuote = false;
    let braceDepth = 0;
    let terminatorPos = -1;
    let isSelfClosing = false;

    for (let i = scanStart; i < scanEnd; i++) {
      const ch = src[i];
      if (inDoubleQuote) {
        if (ch === '"') inDoubleQuote = false;
        if (ch === '\\' && i + 1 < scanEnd) i++;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = true;
        continue;
      }
      if (ch === '{') {
        braceDepth++;
        continue;
      }
      if (ch === '}' && braceDepth > 0) {
        braceDepth--;
        continue;
      }
      if (braceDepth > 0) continue;
      if (ch === '>') {
        terminatorPos = i;
        if (i > 0 && src[i - 1] === '/') isSelfClosing = true;
        break;
      }
    }

    if (terminatorPos === -1) continue;

    const tagEnd = terminatorPos + 1;

    if (isClose) {
      events.push({ kind: 'close', name, start: tagStartPos, end: tagEnd });
    } else if (isSelfClosing) {
      events.push({ kind: 'self-close', name, start: tagStartPos, end: tagEnd });
    } else {
      events.push({ kind: 'open', name, start: tagStartPos, end: tagEnd });
    }
  }

  return events;
}

export function enumerateFallbackRegions(src: string): FallbackRegion[] {
  const fences = findFencedRegions(src);
  const events = scanTagEvents(src, fences);
  const stack: TagEvent[] = [];
  const regions: FallbackRegion[] = [];

  for (const ev of events) {
    if (ev.kind === 'self-close') continue;

    if (ev.kind === 'open') {
      stack.push(ev);
      continue;
    }

    let matchIdx = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === ev.name) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx === -1) continue; // orphan close with no matching open — drop

    for (let i = stack.length - 1; i > matchIdx; i--) {
      const open = stack[i];
      const blankCap = nearestBlankLineAfter(src, open.start) ?? src.length;
      regions.push({
        start: open.start,
        end: Math.min(ev.start, blankCap),
        source: 'unmatched',
      });
    }

    regions.push({
      start: stack[matchIdx].start,
      end: ev.end,
      source: 'pair',
    });

    stack.length = matchIdx;
  }

  for (const open of stack) {
    const blankCap = nearestBlankLineAfter(src, open.start) ?? src.length;
    regions.push({
      start: open.start,
      end: Math.min(src.length, blankCap),
      source: 'unmatched',
    });
  }

  return regions;
}

function findFallbackRegion(src: string, errorOffset: number): Region {
  const regions = enumerateFallbackRegions(src);

  let best: FallbackRegion | null = null;
  for (const r of regions) {
    if (r.start <= errorOffset && errorOffset <= r.end) {
      if (!best || r.end - r.start < best.end - best.start) best = r;
    }
  }
  if (best) return { start: best.start, end: best.end };

  const blockStart = nearestBlankLineBefore(src, errorOffset) ?? 0;
  const blockEnd = nearestBlankLineAfter(src, errorOffset) ?? src.length;
  return { start: blockStart, end: blockEnd };
}

interface SourceBlock {
  src: string;
  start: number;
  end: number;
}

function splitSourceIntoBlocks(source: string): SourceBlock[] {
  const fences = findFencedRegions(source);
  const BLANK_RE = /\n[ \t]*\n/g;
  const boundaries: number[] = [0];
  for (const match of source.matchAll(BLANK_RE)) {
    const blankStart = match.index;
    if (isInsideFence(blankStart, fences)) continue;
    boundaries.push(blankStart + match[0].length);
  }
  boundaries.push(source.length);
  const blocks: SourceBlock[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end <= start) continue;
    const src = source.slice(start, end);
    if (!src.trim()) continue;
    blocks.push({ src, start, end });
  }
  return blocks;
}

function tryPerBlockFallback(
  source: string,
  parse: ParseFn,
  originalErr: unknown,
  budget?: ParseBudget,
): JSONContent | null {
  const blocks = splitSourceIntoBlocks(source);
  if (blocks.length < 2) return null;

  const merged: JSONContent[] = [];
  let anySucceeded = false;
  let anyFailed = false;
  let hoistedRefDefs = '';

  for (const block of blocks) {
    if (budget && budgetExhausted(budget)) break;
    if (budget) budget.calls += 1;
    const blockSource = hoistedRefDefs + block.src;
    try {
      const blockResult = parse(blockSource);
      const children = (blockResult.content as JSONContent[] | undefined) ?? [];
      hoistedRefDefs += hoistRefDefs(block.src);
      const nonEmpty = children.filter(
        (c) => c.type !== 'paragraph' || (Array.isArray(c.content) && c.content.length > 0),
      );
      if (nonEmpty.length === 0 && children.length > 0) {
        anySucceeded = true;
        continue;
      }
      merged.push(...nonEmpty);
      anySucceeded = true;
    } catch (blockErr) {
      incrementBlockFallback();
      const blockMsg = (blockErr as Error)?.message?.slice(0, 200) ?? 'unknown block error';
      const originalMsg = (originalErr as Error)?.message?.slice(0, 160) ?? 'unknown';
      console.warn(
        JSON.stringify({
          event: 'mdx-block-fallback',
          offset: block.start,
          reason: `Per-block recovery after position-less error: ${originalMsg}`,
          blockError: blockMsg,
          blockErrorName: (blockErr as Error)?.name,
        }),
      );
      merged.push({
        type: 'rawMdxFallback',
        attrs: {
          reason: blockMsg,
          originalSpan: { start: block.start, end: block.end },
        },
        content: [{ type: 'text', text: block.src }],
      });
      anyFailed = true;
    }
  }

  if (!anySucceeded) return null; // every block failed — no improvement over whole-doc
  if (!anyFailed) {
    return {
      type: 'doc',
      content: merged.length > 0 ? merged : [{ type: 'paragraph', content: [] }],
    };
  }
  return {
    type: 'doc',
    content: merged.length > 0 ? merged : [{ type: 'paragraph', content: [] }],
  };
}

function wholeDocRawText(source: string): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: source }] }],
  };
}
