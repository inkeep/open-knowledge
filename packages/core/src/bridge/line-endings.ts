import { stripFrontmatter } from '../extensions/frontmatter.ts';

export type LineEnding = '\n' | '\r\n';

export interface LfProjection {
  readonly text: string;
  readonly lineEnding: LineEnding;
  toRawOffset(offset: number): number;
}

const CARRIAGE_RETURN = 13;

function crlfPositionsInLfSpace(raw: string): { positions: number[]; bareLfCount: number } {
  const positions: number[] = [];
  let bareLfCount = 0;
  for (let i = raw.indexOf('\n'); i !== -1; i = raw.indexOf('\n', i + 1)) {
    if (i > 0 && raw.charCodeAt(i - 1) === CARRIAGE_RETURN) {
      positions.push(i - 1 - positions.length);
    } else {
      bareLfCount++;
    }
  }
  return { positions, bareLfCount };
}

function countBelow(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function dominantLineEnding(text: string, whenNone: LineEnding = '\n'): LineEnding {
  const { positions, bareLfCount } = crlfPositionsInLfSpace(text);
  if (positions.length === 0 && bareLfCount === 0) return whenNone;
  return positions.length > bareLfCount ? '\r\n' : '\n';
}

export function documentBodyLineEnding(doc: string): LineEnding {
  const { frontmatter, body } = stripFrontmatter(doc);
  return dominantLineEnding(body, dominantLineEnding(frontmatter));
}

export function spellLineEndings(text: string, lineEnding: LineEnding): string {
  return lineEnding === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replaceAll('\r\n', '\n');
}

export function projectToLf(raw: string): LfProjection {
  const { positions, bareLfCount } = crlfPositionsInLfSpace(raw);
  if (positions.length === 0) return { text: raw, lineEnding: '\n', toRawOffset: (o) => o };
  return {
    text: raw.replaceAll('\r\n', '\n'),
    lineEnding: positions.length > bareLfCount ? '\r\n' : '\n',
    toRawOffset: (offset) => offset + countBelow(positions, offset),
  };
}
