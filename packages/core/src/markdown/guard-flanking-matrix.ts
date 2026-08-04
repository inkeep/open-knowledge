import { classifyCharacter } from 'micromark-util-classify-character';
import {
  protectFromMdx,
  R23_GUARD_SUBSTITUTIONS,
  R23_SENTINEL_ESCAPE_SUBSTITUTIONS,
} from './autolink-void-html-guard.ts';
import { BACKSLASH_GUARD_SUBSTITUTIONS, encodeBackslashEscapes } from './backslash-escape-guard.ts';
import { ENTITY_REF_GUARD_SUBSTITUTIONS, encodeEntityRefs } from './entity-ref-guard.ts';


export const ATTENTION_DELIMITERS = ['*', '_', '**', '~~', '=='] as const;

export type FlankClass = 'whitespace' | 'punctuation' | 'other';

export interface GuardSubstitutionRow {
  alphabet: string;
  from: string;
  toCodePoint: string;
  fromClass: FlankClass;
  toClass: FlankClass;
  classChanged: boolean;
}

export interface GuardFlankingCell {
  alphabet: string;
  from: string;
  toCodePoint: string;
  delimiter: string;
  witness: string;
  side: 'before-open' | 'after-close';
}

export interface GuardFlankingMatrix {
  delimiters: readonly string[];
  substitutions: GuardSubstitutionRow[];
  cells: Array<GuardFlankingCell & { roundTrip: string }>;
}

const ALPHABETS: ReadonlyArray<{
  alphabet: string;
  substitutions: ReadonlyArray<{ from: string; to: string }>;
}> = [
  { alphabet: 'entity-ref', substitutions: ENTITY_REF_GUARD_SUBSTITUTIONS },
  { alphabet: 'r23', substitutions: R23_GUARD_SUBSTITUTIONS },
  { alphabet: 'r23-sentinel-escape', substitutions: R23_SENTINEL_ESCAPE_SUBSTITUTIONS },
  { alphabet: 'backslash-escape', substitutions: BACKSLASH_GUARD_SUBSTITUTIONS },
];

const WITNESS_TEMPLATES: Record<
  string,
  { side: GuardFlankingCell['side']; make: (delim: string) => string }
> = {
  'entity-ref:&': { side: 'after-close', make: (d) => `${d}.y.${d}&#x41;b` },
  'entity-ref:;': { side: 'before-open', make: (d) => `a&#x41;${d}.y.${d}` },
  'r23:<': { side: 'after-close', make: (d) => `${d}.y.${d}<br>b` },
  'r23:>': { side: 'before-open', make: (d) => `a<br>${d}.y.${d}` },
  'r23::': { side: 'before-open', make: (d) => `<a:${d}.y.${d}>` },
  'r23:@': { side: 'before-open', make: (d) => `<mailto:a@${d}.y.${d}>` },
  'r23:{': { side: 'after-close', make: (d) => `${d}.y.${d}{b` },
  'backslash-escape:\\': { side: 'after-close', make: (d) => `${d}.y.${d}\\<b` },
};

function classify(char: string): FlankClass {
  const code = char.codePointAt(0);
  if (code === undefined) throw new Error('empty substitution char');
  const group = classifyCharacter(code);
  if (group === 1) return 'whitespace';
  if (group === 2) return 'punctuation';
  return 'other';
}

function formatCodePoint(char: string): string {
  const code = char.codePointAt(0);
  if (code === undefined) throw new Error('empty substitution char');
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

function displayChar(char: string): string {
  const code = char.codePointAt(0);
  if (code === undefined) throw new Error('empty substitution char');
  return code >= 0x20 && code <= 0x7e ? char : formatCodePoint(char);
}

function runProtectChain(source: string): string {
  return encodeEntityRefs(protectFromMdx(encodeBackslashEscapes(source)));
}

export function computeGuardSubstitutionRows(): GuardSubstitutionRow[] {
  const rows: GuardSubstitutionRow[] = [];
  for (const { alphabet, substitutions } of ALPHABETS) {
    for (const { from, to } of substitutions) {
      const fromClass = classify(from);
      const toClass = classify(to);
      rows.push({
        alphabet,
        from: displayChar(from),
        toCodePoint: formatCodePoint(to),
        fromClass,
        toClass,
        classChanged: fromClass !== toClass,
      });
    }
  }
  return rows;
}

export function computeGuardFlankingCells(): GuardFlankingCell[] {
  const cells: GuardFlankingCell[] = [];
  for (const { alphabet, substitutions } of ALPHABETS) {
    for (const { from, to } of substitutions) {
      if (classify(from) === classify(to)) continue;
      const template = WITNESS_TEMPLATES[`${alphabet}:${from}`];
      if (!template) {
        throw new Error(`no witness template for class-changing substitution ${alphabet}:${from}`);
      }
      for (const delimiter of ATTENTION_DELIMITERS) {
        const witness = template.make(delimiter);
        const protectedSource = runProtectChain(witness);
        const adjacencyProbe =
          template.side === 'before-open' ? `${to}${delimiter}` : `${delimiter}${to}`;
        if (!protectedSource.includes(adjacencyProbe)) {
          throw new Error(
            `witness for ${alphabet}:${from} x ${delimiter} lost sentinel-delimiter adjacency at the protect layer`,
          );
        }
        cells.push({
          alphabet,
          from,
          toCodePoint: formatCodePoint(to),
          delimiter,
          witness,
          side: template.side,
        });
      }
    }
  }
  return cells;
}

export function buildGuardFlankingMatrix(roundTrip: (md: string) => string): GuardFlankingMatrix {
  return {
    delimiters: [...ATTENTION_DELIMITERS],
    substitutions: computeGuardSubstitutionRows(),
    cells: computeGuardFlankingCells().map((cell) => ({
      ...cell,
      roundTrip: roundTrip(cell.witness),
    })),
  };
}

export function diffGuardFlankingMatrix(
  live: GuardFlankingMatrix,
  committed: GuardFlankingMatrix,
): string[] {
  const mismatches: string[] = [];
  if (JSON.stringify(live.delimiters) !== JSON.stringify(committed.delimiters)) {
    mismatches.push('delimiter set drifted');
  }
  const rowKey = (r: GuardSubstitutionRow) => `${r.alphabet}:${r.from}`;
  const liveRows = new Map(live.substitutions.map((r) => [rowKey(r), r]));
  const committedRows = new Map(committed.substitutions.map((r) => [rowKey(r), r]));
  for (const [key, row] of liveRows) {
    const prior = committedRows.get(key);
    if (!prior) mismatches.push(`substitution ${key} is live but not committed`);
    else if (JSON.stringify(row) !== JSON.stringify(prior)) {
      mismatches.push(`substitution ${key} drifted`);
    }
  }
  for (const key of committedRows.keys()) {
    if (!liveRows.has(key)) mismatches.push(`substitution ${key} is committed but no longer live`);
  }
  const cellKey = (c: GuardFlankingCell) =>
    `${c.alphabet}:${c.from} x ${JSON.stringify(c.delimiter)}`;
  const liveCells = new Map(live.cells.map((c) => [cellKey(c), c]));
  const committedCells = new Map(committed.cells.map((c) => [cellKey(c), c]));
  for (const [key, cell] of liveCells) {
    const prior = committedCells.get(key);
    if (!prior) mismatches.push(`cell ${key} is live but not committed`);
    else if (JSON.stringify(cell) !== JSON.stringify(prior)) mismatches.push(`cell ${key} drifted`);
  }
  for (const key of committedCells.keys()) {
    if (!liveCells.has(key)) mismatches.push(`cell ${key} is committed but no longer live`);
  }
  return mismatches;
}
