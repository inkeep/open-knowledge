import type { Join } from 'mdast-util-to-markdown';
import type { Position } from 'unist';

type MaybePositioned = { position?: Position };
type MaybeTyped = {
  type?: string;
  data?: { sourceContiguousNext?: boolean; sourcePrecedingBlankLines?: number };
};
type FlowNode = Parameters<Join>[0];

function isContiguousSetextWithParagraph(left: FlowNode, right: FlowNode): boolean {
  const lt = left as MaybeTyped;
  const rt = right as MaybeTyped;
  return lt.type === 'heading' && lt.data?.sourceContiguousNext === true && rt.type === 'paragraph';
}

export const positionAwareBlankLineJoin: Join = (left, right) => {
  if (isContiguousSetextWithParagraph(left, right)) return 0;
  const dataGap = (right as MaybeTyped).data?.sourcePrecedingBlankLines;
  if (typeof dataGap === 'number' && dataGap >= 2) return dataGap;
  const lp = (left as MaybePositioned).position;
  const rp = (right as MaybePositioned).position;
  if (!lp || !rp) return undefined;
  const gap = rp.start.line - lp.end.line - 1;
  return gap >= 1 ? gap : undefined;
};
