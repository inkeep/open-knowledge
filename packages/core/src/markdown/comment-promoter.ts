import type { Nodes, Paragraph, PhrasingContent, Root, RootContent, Text } from 'mdast';
import { SKIP, visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import type { CommentBlockMdast, CommentMdast } from './mdast-augmentation.ts';
import { deriveFragmentPosition } from './promoter-position.ts';

const PERCENT_COMMENT_RE = /(?<!%)%%([^\n]*?[^\n%])%%(?!%)/g;

const HTML_COMMENT_INLINE_RE = /<!--([\s\S]*?)-->/g;

export function commentPromoterPlugin() {
  return (tree: Root, file: VFile) => {
    const source = typeof file.value === 'string' ? file.value : '';
    handleBlockCommentsAtRoot(tree);

    visit(tree, 'text', (node: Text, index, parent) => {
      if (parent === undefined || index === undefined || index === null) return;

      const value = node.value;
      if (value.indexOf('%%') === -1 && value.indexOf('<!--') === -1) return;

      const matches = collectInlineCommentMatches(value);
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
  };
}

interface InlineCommentMatch {
  start: number;
  end: number;
  body: string;
  sourceForm: 'percent' | 'html';
}

function collectInlineCommentMatches(value: string): InlineCommentMatch[] {
  const out: InlineCommentMatch[] = [];

  PERCENT_COMMENT_RE.lastIndex = 0;
  let pm: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((pm = PERCENT_COMMENT_RE.exec(value)) !== null) {
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

function handleBlockCommentsAtRoot(tree: Root): void {
  const children = tree.children;
  let i = 0;
  while (i < children.length) {
    const child = children[i];

    if (child.type === 'paragraph') {
      const single = isSingleTextParagraph(child);
      if (single !== null) {
        const fenced = matchSingleParagraphFence(single);
        if (fenced !== null) {
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
        if (htmlBlockBody !== null) {
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
      if (strippedHtml !== null) {
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
      if (strippedPercent !== null) {
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

    if (child.type === 'paragraph' && isFenceOnlyParagraph(child)) {
      let j = i + 1;
      while (j < children.length) {
        const sibling = children[j];
        if (sibling.type === 'paragraph' && isFenceOnlyParagraph(sibling)) break;
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

function isFenceOnlyParagraph(p: Paragraph): boolean {
  const text = isSingleTextParagraph(p);
  if (text === null) return false;
  return text.trim() === '%%';
}
