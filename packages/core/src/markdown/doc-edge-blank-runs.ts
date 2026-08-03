import type { Root as MdastRoot, Paragraph } from 'mdast';
import type { SourceDocBoundary } from './mdast-augmentation.ts';

export const MIN_CARRIED_EDGE_EMPTIES = 2;

export interface DocEdgeEmpties {
  leading: number;
  trailing: number;
}

function applyFloor(empties: number): number {
  return empties >= MIN_CARRIED_EDGE_EMPTIES ? empties : 0;
}

export function carriedEdgeEmpties(source: string): DocEdgeEmpties {
  const afterBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const afterHead = afterBom.replace(/^\n+/, '');
  if (afterHead.replace(/\n+$/, '').length === 0) return { leading: 0, trailing: 0 };
  return {
    leading: applyFloor(afterBom.length - afterHead.length),
    trailing: applyFloor(afterHead.length - afterHead.replace(/\n+$/, '').length - 1),
  };
}

function blankLineParagraph(line: number, offset: number): Paragraph {
  const point = { line, column: 1, offset };
  return { type: 'paragraph', children: [], position: { start: point, end: { ...point } } };
}

export function materializeDocEdgeBlankRuns(
  root: MdastRoot,
  boundary: SourceDocBoundary,
): SourceDocBoundary | undefined {
  const children = root.children;
  const head =
    children.length === 0 || boundary.leading === undefined
      ? 0
      : applyFloor(boundary.leading.length);
  const tail =
    children.length === 0 || boundary.trailing === undefined
      ? 0
      : applyFloor(boundary.trailing.length - 1);
  if (head === 0 && tail === 0) return boundary;

  const lastEnd = children[children.length - 1]?.position?.end;
  const headParagraphs: Paragraph[] = [];
  const tailParagraphs: Paragraph[] = [];

  if (head > 0) {
    for (let i = 0; i < head; i++) headParagraphs.push(blankLineParagraph(1 + i, i));
  }
  if (tail > 0 && typeof lastEnd?.offset === 'number' && typeof lastEnd.line === 'number') {
    for (let i = 0; i < tail; i++) {
      tailParagraphs.push(blankLineParagraph(lastEnd.line + 1 + i, lastEnd.offset + 1 + i));
    }
  }
  if (headParagraphs.length === 0 && tailParagraphs.length === 0) return boundary;

  root.children = [...headParagraphs, ...children, ...tailParagraphs];
  if (headParagraphs.length > 0) delete boundary.leading;
  if (tailParagraphs.length > 0) delete boundary.trailing;

  if (
    boundary.bom !== undefined ||
    boundary.leading !== undefined ||
    boundary.trailing !== undefined
  ) {
    return boundary;
  }
  if (root.data !== undefined) delete root.data.sourceDocBoundary;
  return undefined;
}
