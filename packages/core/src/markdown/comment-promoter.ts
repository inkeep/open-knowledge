
import type { Nodes, Paragraph, PhrasingContent, Root, RootContent, Text } from 'mdast';
import { SKIP, visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import type { CommentBlockMdast, CommentMdast } from './mdast-augmentation.ts';
import {
  deriveFragmentPosition,
  escapedValueOffsets,
  isEscapeDerivedRun,
} from './promoter-position.ts';

const PERCENT_COMMENT_RE = /(?<!%)%%([^\n]*?[^\n%])%%(?!%)/g;

const HTML_COMMENT_INLINE_RE = /<!--([\s\S]*?)-->/g;

export function commentPromoterPlugin() {
  return (tree: Root, file: VFile) => {
    const source = typeof file.value === 'string' ? file.value : '';
    handleBlockCommentsAtRoot(tree, source);

    visit(tree, 'text', (node: Text, index, parent) => {
      if (parent === undefined || index === undefined || index === null) return;

      const value = node.value;
      if (value.indexOf('%%') === -1 && value.indexOf('<!--') === -1) return;

      const matches = collectInlineCommentMatches(value, escapedValueOffsets(source, node));
      if (matches.length === 0) return;

      const replacements: PhrasingContent[] = [];
      let cursor = 0;
      for (const match of matches) {
        if (match.start > cursor) {
          const lead: Text = { type: 'text', value: value.slice(cursor, match.start) };
          const pos = deriveFragmentPosition(source, node, cursor, match.start);
          if (pos) lead.position = pos;
          replacements.push(lead);
        }
        const innerText: Text = { type: 'text', value: match.body };
        const commentNode: CommentMdast = {
          type: 'comment',
          children: [innerText],
          data: { sourceForm: match.sourceForm },
        };
        const commentPos = deriveFragmentPosition(source, node, match.start, match.end);
        if (commentPos) commentNode.position = commentPos;
        replacements.push(commentNode as unknown as PhrasingContent);
        cursor = match.end;
      }
      if (cursor < value.length) {
        const tail: Text = { type: 'text', value: value.slice(cursor) };
        const pos = deriveFragmentPosition(source, node, cursor, value.length);
        if (pos) tail.position = pos;
        replacements.push(tail);
      }

      const arr = (parent as { children: PhrasingContent[] }).children;
      arr.splice(index, 1, ...replacements);
      return [SKIP, index + replacements.length];
    });

    promoteSpanningInlineComments(tree, source);
  };
}

interface InlineCommentMatch {
  start: number;
  end: number;
  body: string;
  sourceForm: 'percent' | 'html';
}

function collectInlineCommentMatches(
  value: string,
  escaped: ReadonlySet<number> | null,
): InlineCommentMatch[] {
  const out: InlineCommentMatch[] = [];

  PERCENT_COMMENT_RE.lastIndex = 0;
  let pm: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((pm = PERCENT_COMMENT_RE.exec(value)) !== null) {
    if (
      isEscapeDerivedRun(escaped, pm.index, 2) ||
      isEscapeDerivedRun(escaped, pm.index + pm[0].length - 2, 2)
    ) {
      PERCENT_COMMENT_RE.lastIndex = pm.index + 1;
      continue;
    }
    if (pm[1].trim().length === 0) continue;
    out.push({
      start: pm.index,
      end: pm.index + pm[0].length,
      body: pm[1],
      sourceForm: 'percent',
    });
  }

  HTML_COMMENT_INLINE_RE.lastIndex = 0;
  let hm: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((hm = HTML_COMMENT_INLINE_RE.exec(value)) !== null) {
    if (
      isEscapeDerivedRun(escaped, hm.index, 4) ||
      isEscapeDerivedRun(escaped, hm.index + hm[0].length - 3, 3)
    ) {
      HTML_COMMENT_INLINE_RE.lastIndex = hm.index + 1;
      continue;
    }
    const body = hm[1].trim();
    if (body === '') continue;
    out.push({
      start: hm.index,
      end: hm.index + hm[0].length,
      body,
      sourceForm: 'html',
    });
  }

  out.sort((a, b) => a.start - b.start);
  const deduped: InlineCommentMatch[] = [];
  let lastEnd = -1;
  for (const m of out) {
    if (m.start < lastEnd) continue;
    deduped.push(m);
    lastEnd = m.end;
  }
  return deduped;
}

function handleBlockCommentsAtRoot(tree: Root, source: string): void {
  const children = tree.children;
  let i = 0;
  while (i < children.length) {
    const child = children[i];

    if (child.type === 'paragraph') {
      const single = isSingleTextParagraph(child);
      if (single !== null) {
        const onlyText = child.children[0] as Text;
        let onlyEscapedCache: ReadonlySet<number> | null | undefined;
        const onlyEscapes = (): ReadonlySet<number> | null => {
          if (onlyEscapedCache === undefined) {
            onlyEscapedCache = escapedValueOffsets(source, onlyText);
          }
          return onlyEscapedCache;
        };

        const fenced = matchSingleParagraphFence(single);
        if (
          fenced !== null &&
          !isEscapeDerivedRun(onlyEscapes(), 0, 2) &&
          !isEscapeDerivedRun(onlyEscapes(), single.length - 2, 2)
        ) {
          const block: CommentBlockMdast = {
            type: 'commentBlock',
            children: [
              {
                type: 'paragraph',
                children: [{ type: 'text', value: fenced }],
              } as Paragraph,
            ],
            data: { sourceForm: 'percent', sourceLayout: 'block' },
          };
          children.splice(i, 1, block as unknown as RootContent);
          i += 1;
          continue;
        }

        const htmlBlockBody = matchHtmlCommentBlock(single);
        if (
          htmlBlockBody !== null &&
          !isEscapeDerivedRun(onlyEscapes(), single.length - single.trimStart().length, 4) &&
          !isEscapeDerivedRun(onlyEscapes(), single.trimEnd().length - 3, 3)
        ) {
          const block: CommentBlockMdast = {
            type: 'commentBlock',
            children: [
              {
                type: 'paragraph',
                children: [{ type: 'text', value: htmlBlockBody }],
              } as Paragraph,
            ],
            data: { sourceForm: 'html', sourceLayout: 'inline' },
          };
          children.splice(i, 1, block as unknown as RootContent);
          i += 1;
          continue;
        }
      }

      const strippedHtml = stripHtmlCommentDelimiters(child);
      if (strippedHtml !== null && !boundaryDelimitersEscaped(source, child, 4, 3)) {
        const block: CommentBlockMdast = {
          type: 'commentBlock',
          children: [strippedHtml],
          data: { sourceForm: 'html', sourceLayout: 'inline' },
        };
        children.splice(i, 1, block as unknown as RootContent);
        i += 1;
        continue;
      }

      const strippedPercent = stripPercentDelimiters(child);
      if (strippedPercent !== null && !boundaryDelimitersEscaped(source, child, 2, 2)) {
        const block: CommentBlockMdast = {
          type: 'commentBlock',
          children: [strippedPercent],
          data: { sourceForm: 'percent', sourceLayout: 'inline' },
        };
        children.splice(i, 1, block as unknown as RootContent);
        i += 1;
        continue;
      }
    }

    if (child.type === 'paragraph' && isFenceOnlyParagraph(child, source)) {
      let j = i + 1;
      while (j < children.length) {
        const sibling = children[j];
        if (sibling.type === 'paragraph' && isFenceOnlyParagraph(sibling, source)) break;
        j += 1;
      }
      if (j < children.length && j > i + 1) {
        const inner = children.slice(i + 1, j);
        const block: CommentBlockMdast = {
          type: 'commentBlock',
          children: inner as Nodes[],
          data: { sourceForm: 'percent', sourceLayout: 'block' },
        };
        children.splice(i, j - i + 1, block as unknown as RootContent);
        i += 1;
        continue;
      }
    }

    i += 1;
  }
}

function runEscaped(source: string, node: Text, valueOffset: number, length: number): boolean {
  return isEscapeDerivedRun(escapedValueOffsets(source, node), valueOffset, length);
}

function boundaryDelimitersEscaped(
  source: string,
  p: Paragraph,
  openLength: number,
  closeLength: number,
): boolean {
  const first = p.children[0];
  const last = p.children[p.children.length - 1];
  if (first.type !== 'text' || last.type !== 'text') return false;
  const openAt = first.value.length - first.value.trimStart().length;
  const closeAt = last.value.trimEnd().length - closeLength;
  const firstEscaped = escapedValueOffsets(source, first);
  if (isEscapeDerivedRun(firstEscaped, openAt, openLength)) return true;
  const lastEscaped = last === first ? firstEscaped : escapedValueOffsets(source, last);
  return isEscapeDerivedRun(lastEscaped, closeAt, closeLength);
}

function isSingleTextParagraph(p: Paragraph): string | null {
  if (p.children.length !== 1) return null;
  const only = p.children[0];
  if (only.type !== 'text') return null;
  return only.value;
}

function matchSingleParagraphFence(value: string): string | null {
  const m = value.match(/^%%\n((?:.|\n(?!\n))+?)\n%%$/);
  return m === null ? null : m[1];
}

function matchHtmlCommentBlock(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('<!--') || !trimmed.endsWith('-->')) return null;
  const body = trimmed.slice(4, -3);
  if (body.includes('-->') || body.includes('<!--')) return null;
  const trimmedBody = body.trim();
  if (trimmedBody === '') return null;
  return trimmedBody;
}

function stripHtmlCommentDelimiters(p: Paragraph): Paragraph | null {
  if (p.children.length < 2) return null;
  const first = p.children[0];
  const last = p.children[p.children.length - 1];
  if (first.type !== 'text' || last.type !== 'text') return null;

  const firstTrimmed = first.value.trimStart();
  if (!firstTrimmed.startsWith('<!--')) return null;
  const lastTrimmed = last.value.trimEnd();
  if (!lastTrimmed.endsWith('-->')) return null;

  for (let i = 0; i < p.children.length; i++) {
    const ch = p.children[i];
    if (ch.type !== 'text') continue;
    const v = ch.value;
    if (i === 0) {
      if (countOccurrences(v, '<!--') > 1 || countOccurrences(v, '-->') > 0) return null;
    } else if (i === p.children.length - 1) {
      if (countOccurrences(v, '<!--') > 0 || countOccurrences(v, '-->') > 1) return null;
    } else {
      if (v.includes('<!--') || v.includes('-->')) return null;
    }
  }

  let strippedFirst = firstTrimmed.slice(4);
  if (strippedFirst.startsWith(' ')) strippedFirst = strippedFirst.slice(1);
  let strippedLast = lastTrimmed.slice(0, -3);
  if (strippedLast.endsWith(' ')) strippedLast = strippedLast.slice(0, -1);

  const newChildren: Paragraph['children'] = [];
  if (strippedFirst.length > 0) {
    newChildren.push({ ...first, value: strippedFirst } as Text);
  }
  for (let i = 1; i < p.children.length - 1; i++) {
    newChildren.push(p.children[i]);
  }
  if (strippedLast.length > 0) {
    newChildren.push({ ...last, value: strippedLast } as Text);
  }
  if (newChildren.length === 0) return null;

  return { type: 'paragraph', children: newChildren };
}

function stripPercentDelimiters(p: Paragraph): Paragraph | null {
  if (p.children.length < 2) return null;
  const first = p.children[0];
  const last = p.children[p.children.length - 1];
  if (first.type !== 'text' || last.type !== 'text') return null;

  const firstTrimmed = first.value.trimStart();
  if (!firstTrimmed.startsWith('%%') || firstTrimmed.startsWith('%%%')) return null;
  const lastTrimmed = last.value.trimEnd();
  if (!lastTrimmed.endsWith('%%') || lastTrimmed.endsWith('%%%')) return null;

  let strippedFirst = firstTrimmed.slice(2);
  if (strippedFirst.startsWith(' ')) strippedFirst = strippedFirst.slice(1);
  let strippedLast = lastTrimmed.slice(0, -2);
  if (strippedLast.endsWith(' ')) strippedLast = strippedLast.slice(0, -1);

  if (strippedFirst.indexOf('%%') !== -1) return null;
  if (strippedLast.indexOf('%%') !== -1) return null;
  for (let i = 1; i < p.children.length - 1; i++) {
    const ch = p.children[i];
    if (ch.type === 'text' && ch.value.indexOf('%%') !== -1) return null;
  }

  const middleHasContent = p.children.slice(1, -1).some((ch) => {
    if (ch.type === 'text') return ch.value.trim().length > 0;
    return true; // any non-text child counts as content
  });
  const hasContent =
    middleHasContent || strippedFirst.trim().length > 0 || strippedLast.trim().length > 0;
  if (!hasContent) return null;

  const newChildren: Paragraph['children'] = [];
  if (strippedFirst.length > 0) {
    newChildren.push({ ...first, value: strippedFirst } as Text);
  }
  for (let i = 1; i < p.children.length - 1; i++) {
    newChildren.push(p.children[i]);
  }
  if (strippedLast.length > 0) {
    newChildren.push({ ...last, value: strippedLast } as Text);
  }
  if (newChildren.length === 0) return null;

  return { type: 'paragraph', children: newChildren };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

function isFenceOnlyParagraph(p: Paragraph, source: string): boolean {
  const text = isSingleTextParagraph(p);
  if (text === null) return false;
  if (text.trim() !== '%%') return false;
  return !runEscaped(source, p.children[0] as Text, text.indexOf('%%'), 2);
}

function promoteSpanningInlineComments(tree: Root, source: string): void {
  if (source.indexOf('%%') === -1 && source.indexOf('<!--') === -1) return;

  visit(tree, (node) => {
    if (!SPANNING_PARENT_TYPES.has(node.type)) return;
    const children = (node as { children?: PhrasingContent[] }).children;
    if (children === undefined || children.length < 2) return;
    for (const spec of SPANNING_FORMS) {
      if (promoteSpanningForm(children, source, spec)) return;
    }
  });
}

const SPANNING_PARENT_TYPES: ReadonlySet<string> = new Set(['paragraph', 'heading', 'tableCell']);

interface SpanningFormSpec {
  sourceForm: 'percent' | 'html';
  open: string;
  close: string;
}

const SPANNING_FORMS: readonly SpanningFormSpec[] = [
  { sourceForm: 'html', open: '<!--', close: '-->' },
  { sourceForm: 'percent', open: '%%', close: '%%' },
];

interface DelimiterHit {
  index: number;
  offset: number;
}

function collectDelimiterHits(children: readonly PhrasingContent[], token: string): DelimiterHit[] {
  const hits: DelimiterHit[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type !== 'text') continue;
    let from = 0;
    while (true) {
      const at = child.value.indexOf(token, from);
      if (at === -1) break;
      hits.push({ index: i, offset: at });
      from = at + token.length;
    }
  }
  return hits;
}

function promoteSpanningForm(
  children: PhrasingContent[],
  source: string,
  spec: SpanningFormSpec,
): boolean {
  let open: DelimiterHit;
  let close: DelimiterHit;

  if (spec.sourceForm === 'percent') {
    const hits = collectDelimiterHits(children, '%%');
    if (hits.length !== 2) return false;
    [open, close] = hits;
  } else {
    const opens = collectDelimiterHits(children, '<!--');
    const closes = collectDelimiterHits(children, '-->');
    if (opens.length !== 1 || closes.length !== 1) return false;
    open = opens[0];
    close = closes[0];
  }

  if (open.index >= close.index) return false;

  const openChild = children[open.index] as Text;
  const closeChild = children[close.index] as Text;

  if (spec.sourceForm === 'percent') {
    if (openChild.value[open.offset - 1] === '%') return false;
    if (openChild.value[open.offset + 2] === '%') return false;
    if (closeChild.value[close.offset - 1] === '%') return false;
    if (closeChild.value[close.offset + 2] === '%') return false;
  }

  if (spanCrossesLineBreak(children, spec, open, close)) return false;

  if (runEscaped(source, openChild, open.offset, spec.open.length)) return false;
  if (runEscaped(source, closeChild, close.offset, spec.close.length)) return false;

  for (let i = open.index + 1; i < close.index; i++) {
    if (containsClaimedComment(children[i])) return false;
  }

  if (open.offset === 0 && containsClaimedComment(children[open.index - 1])) return false;
  if (
    close.offset + spec.close.length === closeChild.value.length &&
    containsClaimedComment(children[close.index + 1])
  ) {
    return false;
  }

  const body = buildSpanningBody(children, spec, open, close, source);
  if (body === null) return false;

  const replacements: PhrasingContent[] = [];
  const lead = openChild.value.slice(0, open.offset);
  if (lead.length > 0) replacements.push(sliceTextNode(source, openChild, 0, open.offset));

  const commentNode: CommentMdast = {
    type: 'comment',
    children: body,
    data: { sourceForm: spec.sourceForm },
  };
  const openPos = deriveFragmentPosition(source, openChild, open.offset, openChild.value.length);
  const closePos = deriveFragmentPosition(source, closeChild, 0, close.offset + spec.close.length);
  if (openPos && closePos) {
    commentNode.position = { start: openPos.start, end: closePos.end };
  }
  replacements.push(commentNode as unknown as PhrasingContent);

  const tailFrom = close.offset + spec.close.length;
  const tail = closeChild.value.slice(tailFrom);
  if (tail.length > 0) {
    replacements.push(sliceTextNode(source, closeChild, tailFrom, closeChild.value.length));
  }

  children.splice(open.index, close.index - open.index + 1, ...replacements);
  return true;
}

function buildSpanningBody(
  children: readonly PhrasingContent[],
  spec: SpanningFormSpec,
  open: DelimiterHit,
  close: DelimiterHit,
  source: string,
): PhrasingContent[] | null {
  const openChild = children[open.index] as Text;
  const closeChild = children[close.index] as Text;

  let headFrom = open.offset + spec.open.length;
  const headTo = openChild.value.length;
  const footFrom = 0;
  let footTo = close.offset;

  if (spec.sourceForm === 'html') {
    while (headFrom < headTo && /\s/.test(openChild.value[headFrom])) headFrom += 1;
    while (footTo > footFrom && /\s/.test(closeChild.value[footTo - 1])) footTo -= 1;
  }

  const body: PhrasingContent[] = [];
  if (headFrom < headTo) {
    body.push(sliceTextNode(source, openChild, headFrom, headTo));
  }
  for (let i = open.index + 1; i < close.index; i++) body.push(children[i]);
  if (footFrom < footTo) {
    body.push(sliceTextNode(source, closeChild, footFrom, footTo));
  }

  if (body.length === 0) return null;

  const hasContent = body.some((child) =>
    child.type === 'text' ? child.value.trim().length > 0 : true,
  );
  if (!hasContent) return null;

  if (!body.some((child) => child.type === 'text')) return null;

  return body;
}

function spanCrossesLineBreak(
  children: readonly PhrasingContent[],
  spec: SpanningFormSpec,
  open: DelimiterHit,
  close: DelimiterHit,
): boolean {
  const openChild = children[open.index] as Text;
  const closeChild = children[close.index] as Text;
  if (openChild.value.indexOf('\n', open.offset + spec.open.length) !== -1) return true;
  if (closeChild.value.lastIndexOf('\n', close.offset) !== -1) return true;
  for (let i = open.index + 1; i < close.index; i++) {
    if (containsLineBreak(children[i])) return true;
  }
  return false;
}

function containsLineBreak(node: unknown): boolean {
  const typed = node as { type?: string; value?: string; children?: unknown };
  if (typed?.type === 'break') return true;
  if (typed?.type === 'text') return (typed.value ?? '').indexOf('\n') !== -1;
  return Array.isArray(typed?.children) && typed.children.some(containsLineBreak);
}

function containsClaimedComment(node: unknown): boolean {
  if (node === undefined || node === null) return false;
  if ((node as { type?: string }).type === 'comment') return true;
  const kids = (node as { children?: unknown }).children;
  return Array.isArray(kids) && kids.some(containsClaimedComment);
}

interface EntityRefSpan {
  offset: number;
  length: number;
  raw: string;
}

function sliceTextNode(source: string, node: Text, from: number, to: number): Text {
  const sliced: Text = { type: 'text', value: node.value.slice(from, to) };

  const pos = deriveFragmentPosition(source, node, from, to);
  if (pos) sliced.position = pos;

  const spans = (node.data as { entityRefSpans?: EntityRefSpan[] } | undefined)?.entityRefSpans;
  if (spans?.length) {
    const inside = spans
      .filter((span) => span.offset >= from && span.offset + span.length <= to)
      .map((span) => ({ ...span, offset: span.offset - from }));
    if (inside.length > 0) sliced.data = { entityRefSpans: inside } as Text['data'];
  }

  return sliced;
}
