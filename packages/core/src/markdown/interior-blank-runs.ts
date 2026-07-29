import type { Root as MdastRoot, Paragraph } from 'mdast';

const MIN_PRESERVED_GAP_NEWLINES = 3;

const PRESERVED_GAP_SHAPE = /^\n+$/;

function blankLineParagraphCount(gap: string): number {
  if (gap.length < MIN_PRESERVED_GAP_NEWLINES) return 0;
  if (!PRESERVED_GAP_SHAPE.test(gap)) return 0;
  return gap.length - 2;
}

interface InteriorBlankRun {
  beforeChildIndex: number;
  lines: number[];
  offsets: number[];
}

function findInteriorBlankRuns(root: MdastRoot, source: string): InteriorBlankRun[] {
  const runs: InteriorBlankRun[] = [];
  const children = root.children;
  for (let i = 1; i < children.length; i++) {
    const prev = children[i - 1];
    const next = children[i];
    const prevEnd = prev?.position?.end?.offset;
    const prevEndLine = prev?.position?.end?.line;
    const nextStart = next?.position?.start?.offset;
    if (typeof prevEnd !== 'number' || typeof nextStart !== 'number') continue;
    if (typeof prevEndLine !== 'number' || nextStart < prevEnd) continue;
    const count = blankLineParagraphCount(source.slice(prevEnd, nextStart));
    if (count === 0) continue;
    const lines: number[] = [];
    const offsets: number[] = [];
    for (let j = 0; j < count; j++) {
      lines.push(prevEndLine + 2 + j);
      offsets.push(prevEnd + 2 + j);
    }
    runs.push({ beforeChildIndex: i, lines, offsets });
  }
  return runs;
}

export function insertInteriorBlankRunParagraphs(root: MdastRoot, source: string): void {
  const runs = findInteriorBlankRuns(root, source);
  if (runs.length === 0) return;
  const out: MdastRoot['children'] = [];
  let runIndex = 0;
  for (let i = 0; i < root.children.length; i++) {
    const run = runs[runIndex];
    if (run && run.beforeChildIndex === i) {
      for (let j = 0; j < run.lines.length; j++) {
        out.push(blankLineParagraph(run.lines[j] as number, run.offsets[j] as number));
      }
      runIndex += 1;
    }
    out.push(root.children[i] as MdastRoot['children'][number]);
  }
  root.children = out;
}

function blankLineParagraph(line: number, offset: number): Paragraph {
  const point = { line, column: 1, offset };
  return { type: 'paragraph', children: [], position: { start: point, end: { ...point } } };
}
