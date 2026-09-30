import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import { stripFrontmatter } from '../extensions/frontmatter.ts';
import type { MarkdownManager } from '../markdown/index.ts';
import { preprocessForParse } from '../markdown/pipeline.ts';
import { buildFullSourceMap, type PmSourceSpan } from '../markdown/pm-source-map.ts';
import type { BlockRange, Projection } from './block-splice.ts';

export interface ProjectionUpdate {
  projection: Projection;
  before: BlockRange;
  after: BlockRange;
}

const DEFINITION_LINE = /^ {0,3}\[[^\]\n]+\]:/m;
const ANCHOR_STEPS = [1, 2, 4, 8] as const;
const FALLBACK_BLOCK = 'rawMdxFallback';

const preprocessedBodies = new WeakMap<Projection, string>();

interface SharedEnds {
  prefix: number;
  suffix: number;
}

function sharedEnds(previous: string, next: string): SharedEnds {
  const bound = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < bound && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < bound - prefix &&
    previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix++;
  }
  return { prefix, suffix };
}

function lineStart(source: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, source.length));
  while (at > 0 && source[at - 1] !== '\n') at--;
  return at;
}

function lineEnd(source: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, source.length));
  while (at < source.length && source[at] !== '\n') at++;
  return at;
}

function canAnchor(span: PmSourceSpan, node: PmNode): boolean {
  if (span.sourceEnd <= span.sourceStart) return false;
  return !(node.type.name === 'paragraph' && node.content.size === 0);
}

function anchorFrom(
  blocks: readonly PmSourceSpan[],
  doc: PmNode,
  start: number,
  direction: -1 | 1,
  steps: number,
): number {
  let at = start;
  let taken = 0;
  for (;;) {
    at += direction;
    if (at < 0 || at >= blocks.length) return at;
    if (canAnchor(blocks[at] as PmSourceSpan, doc.child(at))) {
      taken++;
      if (taken === steps) return at;
    }
  }
}

function firstEndingAtOrAfter(blocks: readonly PmSourceSpan[], offset: number): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((blocks[mid] as PmSourceSpan).sourceEnd >= offset) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function lastStartingAtOrBefore(blocks: readonly PmSourceSpan[], offset: number): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((blocks[mid] as PmSourceSpan).sourceStart <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function hasFallbackBlock(doc: PmNode): boolean {
  for (let i = 0; i < doc.childCount; i++) {
    if (doc.child(i).type.name === FALLBACK_BLOCK) return true;
  }
  return false;
}

function preprocessedBody(projection: Projection, body: string): string {
  const cached = preprocessedBodies.get(projection);
  if (cached !== undefined) return cached;
  const preprocessed = preprocessForParse(body);
  preprocessedBodies.set(projection, preprocessed);
  return preprocessed;
}

type Boundary = Record<string, unknown>;

function edgeBoundary(
  base: unknown,
  window: unknown,
  touchesStart: boolean,
  touchesEnd: boolean,
): Boundary | null {
  const head = ((touchesStart ? window : base) ?? {}) as Boundary;
  const tail = ((touchesEnd ? window : base) ?? {}) as Boundary;
  const out: Boundary = {};
  if (head.bom === true) out.bom = true;
  if (typeof head.leading === 'string') out.leading = head.leading;
  if (typeof tail.trailing === 'string') out.trailing = tail.trailing;
  return Object.keys(out).length > 0 ? out : null;
}

function shiftSpan(span: PmSourceSpan, pm: number, source: number): PmSourceSpan {
  return {
    ...span,
    from: span.from + pm,
    to: span.to + pm,
    sourceStart: span.sourceStart + source,
    sourceEnd: span.sourceEnd + source,
  };
}

/* STOP: this must return exactly what buildProjection(source) returns, or null. A window is
   trusted only when (1) the parser's input outside it is byte-identical before and after, which
   the preprocessing must prove by splitting cleanly at the window's edges -- JSX tag pairing and
   code regions are decided document-wide there -- and (2) the unchanged block on each side
   parses back to the identical node over the identical bytes. Frontmatter, link and footnote
   definitions, and MDX fallback recovery are document-wide too, so they are null. A projection
   that is merely close corrupts the next write. */
export function reprojectChanged(
  base: Projection,
  source: string,
  md: MarkdownManager,
): ProjectionUpdate | null {
  if (base.map.precision !== 'full') return null;
  const blocks = base.map.blocks;
  const n = blocks.length;
  if (n === 0 || n !== base.doc.childCount) return null;
  if (source === base.source) {
    return { projection: base, before: { from: 0, to: 0 }, after: { from: 0, to: 0 } };
  }

  const { frontmatter, body } = stripFrontmatter(source);
  if (frontmatter !== base.source.slice(0, base.bodyOffset)) return null;
  const oldBody = base.source.slice(base.bodyOffset);
  if (base.map.sourceLength !== oldBody.length) return null;
  if (DEFINITION_LINE.test(oldBody) || DEFINITION_LINE.test(body)) return null;
  if (hasFallbackBlock(base.doc)) return null;

  const { prefix, suffix } = sharedEnds(oldBody, body);
  const changeFrom = prefix;
  const changeTo = oldBody.length - suffix;
  const delta = body.length - oldBody.length;
  const first = firstEndingAtOrAfter(blocks, changeFrom);
  const last = lastStartingAtOrBefore(blocks, changeTo);
  const schema = base.doc.type.schema;
  const oldPreprocessed = preprocessedBody(base, oldBody);
  const newPreprocessed = preprocessForParse(body);

  for (const steps of ANCHOR_STEPS) {
    const lo = anchorFrom(blocks, base.doc, first, -1, steps);
    const hi = anchorFrom(blocks, base.doc, last, 1, steps);
    const touchesStart = lo < 0;
    const touchesEnd = hi >= n;
    if (touchesStart && touchesEnd) return null;
    const loSpan = touchesStart ? null : (blocks[lo] as PmSourceSpan);
    const hiSpan = touchesEnd ? null : (blocks[hi] as PmSourceSpan);
    const windowStart = loSpan === null ? 0 : lineStart(oldBody, loSpan.sourceStart);
    const windowEnd = hiSpan === null ? oldBody.length : lineEnd(oldBody, hiSpan.sourceEnd);
    if (windowStart > changeFrom || windowEnd < changeTo) return null;
    const text = body.slice(windowStart, windowEnd + delta);
    if (text.trim() === '') continue;

    const head = preprocessForParse(oldBody.slice(0, windowStart));
    const tail = preprocessForParse(oldBody.slice(windowEnd));
    const oldWindow = preprocessForParse(oldBody.slice(windowStart, windowEnd));
    if (oldPreprocessed !== head + oldWindow + tail) continue;
    if (newPreprocessed !== head + preprocessForParse(text) + tail) continue;

    let parsed: ReturnType<MarkdownManager['parseWithSourceMap']>;
    try {
      parsed = md.parseWithSourceMap(text);
    } catch {
      return null;
    }
    const window = parsed.doc;
    const nodes: PmNode[] = [];
    for (let i = 0; i < window.childCount; i++) {
      const child = window.child(i);
      nodes.push(child.type.schema === schema ? child : schema.nodeFromJSON(child.toJSON()));
    }
    const windowBlocks = parsed.map.blocks;
    if (windowBlocks.length !== nodes.length || nodes.length === 0) continue;

    if (loSpan !== null) {
      const first = windowBlocks[0] as PmSourceSpan;
      if (
        !(nodes[0] as PmNode).eq(base.doc.child(lo)) ||
        first.sourceStart !== loSpan.sourceStart - windowStart ||
        first.sourceEnd !== loSpan.sourceEnd - windowStart
      ) {
        continue;
      }
    }
    if (hiSpan !== null) {
      const last = windowBlocks[windowBlocks.length - 1] as PmSourceSpan;
      if (
        !(nodes[nodes.length - 1] as PmNode).eq(base.doc.child(hi)) ||
        last.sourceStart !== hiSpan.sourceStart - windowStart + delta ||
        last.sourceEnd !== hiSpan.sourceEnd - windowStart + delta
      ) {
        continue;
      }
    }

    const beforeFrom = touchesStart ? 0 : lo;
    const beforeTo = touchesEnd ? n : hi + 1;
    const docSize = base.doc.content.size;
    const pmStart = beforeFrom < n ? (blocks[beforeFrom] as PmSourceSpan).from : docSize;
    const pmEnd = beforeTo < n ? (blocks[beforeTo] as PmSourceSpan).from : docSize;
    const pmDelta = window.content.size - (pmEnd - pmStart);

    const children: PmNode[] = [];
    for (let i = 0; i < beforeFrom; i++) children.push(base.doc.child(i));
    children.push(...nodes);
    for (let i = beforeTo; i < n; i++) children.push(base.doc.child(i));
    const doc = base.doc.type.create(
      {
        ...base.doc.attrs,
        sourceDocBoundary: edgeBoundary(
          base.doc.attrs.sourceDocBoundary,
          window.attrs.sourceDocBoundary,
          touchesStart,
          touchesEnd,
        ),
      },
      Fragment.fromArray(children),
    );

    const spans: PmSourceSpan[] = [];
    for (const span of base.map.spans) if (span.from < pmStart) spans.push(span);
    for (const span of parsed.map.spans) spans.push(shiftSpan(span, pmStart, windowStart));
    for (const span of base.map.spans) {
      if (span.from >= pmEnd) spans.push(shiftSpan(span, pmDelta, delta));
    }

    const projection: Projection = {
      source,
      bodyOffset: base.bodyOffset,
      doc,
      map: buildFullSourceMap(spans, body, doc.content.size),
    };
    preprocessedBodies.set(projection, newPreprocessed);
    return {
      projection,
      before: { from: beforeFrom, to: beforeTo },
      after: { from: beforeFrom, to: beforeFrom + nodes.length },
    };
  }
  return null;
}
