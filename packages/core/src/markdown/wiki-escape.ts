export interface WikiSegments {
  target: string;
  anchor: string | null;
  alias: string | null;
}

export type CleanWikiSegments = WikiSegments;

export function normalizeWikiSeparatorEscapes(
  segments: WikiSegments,
  options: { separatorCrossed: boolean },
): CleanWikiSegments {
  const { target, anchor, alias } = segments;
  if (!options.separatorCrossed) return segments;
  if (anchor !== null) {
    const strippedAnchor = stripTrailingBackslash(anchor);
    return {
      target,
      anchor: strippedAnchor.length > 0 ? strippedAnchor : null,
      alias: alias === null ? null : unescapePipes(alias),
    };
  }
  return {
    target: stripTrailingBackslash(target),
    anchor: null,
    alias: alias === null ? null : unescapePipes(alias),
  };
}

export type WikiSegmentKind = 'separatorAdjacent' | 'alias';

export function rawSegmentMatchesValue(
  raw: string,
  current: string,
  kind: WikiSegmentKind,
): boolean {
  const trimmed = raw.trim();
  if (trimmed === current) return true;
  return kind === 'alias'
    ? unescapePipes(trimmed) === current
    : stripTrailingBackslash(trimmed) === current;
}

export function rawSegmentOr(
  raw: string | null | undefined,
  current: string,
  kind: WikiSegmentKind,
): string {
  return typeof raw === 'string' && rawSegmentMatchesValue(raw, current, kind) ? raw : current;
}

export function separatorEscapeLeavesEmpty(raw: string): boolean {
  return stripTrailingBackslash(raw.trim()) === '';
}

function stripTrailingBackslash(segment: string): string {
  return segment.endsWith('\\') ? segment.slice(0, -1) : segment;
}

function unescapePipes(alias: string): string {
  return alias.replace(/\\\|/g, '|');
}

export function escapeTableCellPipes(value: string): string {
  let out = '';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes++;
    } else {
      if (ch === '|' && backslashes % 2 === 0) out += '\\';
      backslashes = 0;
    }
    out += ch;
  }
  return out;
}

export function escapeDecodedTableCellPipes(value: string): string {
  return value.replace(/\|/g, '\\|');
}
