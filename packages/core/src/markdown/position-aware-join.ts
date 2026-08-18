
import type { Join } from 'mdast-util-to-markdown';
import type { Position } from 'unist';
import { isBlankLineParagraph } from './zero-emission-blocks.ts';

type MaybePositioned = { position?: Position };
type MaybeTyped = {
  type?: string;
  data?: { sourceContiguousNext?: boolean };
};
type FlowNode = Parameters<Join>[0];

function isContiguousHeadingWithParagraph(left: FlowNode, right: FlowNode): boolean {
  const lt = left as MaybeTyped;
  const rt = right as MaybeTyped;
  return lt.type === 'heading' && lt.data?.sourceContiguousNext === true && rt.type === 'paragraph';
}

export const positionAwareBlankLineJoin: Join = (left, right) => {
  if (isBlankLineParagraph(left)) return 0;
  if (isContiguousHeadingWithParagraph(left, right)) return 0;
  const lp = (left as MaybePositioned).position;
  const rp = (right as MaybePositioned).position;
  if (!lp || !rp) return undefined;
  const gap = rp.start.line - lp.end.line - 1;
  return gap >= 1 ? gap : undefined;
};
