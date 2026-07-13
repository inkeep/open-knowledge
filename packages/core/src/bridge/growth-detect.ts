
const DEFAULT_MIN_SUBSTANTIVE_LINE_LENGTH = 16;

export const DUPLICATION_GATE_MIN_LINE_LENGTH = 8;

export function isSubstantiveBodyLine(
  line: string,
  minLength: number = DEFAULT_MIN_SUBSTANTIVE_LINE_LENGTH,
): boolean {
  const trimmed = line.trim();
  if (trimmed.length < minLength) return false;
  return !(trimmed.startsWith('<') || trimmed.startsWith('```') || trimmed.startsWith('|'));
}

export function substantiveLineCounts(
  doc: string,
  minLength: number = DEFAULT_MIN_SUBSTANTIVE_LINE_LENGTH,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of doc.split('\n')) {
    if (!isSubstantiveBodyLine(raw, minLength)) continue;
    const line = raw.trim();
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

export function maxBodyLineOccurrence(
  doc: string,
  minLength: number = DEFAULT_MIN_SUBSTANTIVE_LINE_LENGTH,
): number {
  let max = 0;
  for (const c of substantiveLineCounts(doc, minLength).values()) if (c > max) max = c;
  return max;
}

export function overMultipliedBodyLines(
  candidate: string,
  reference: string,
  minLength: number = DEFAULT_MIN_SUBSTANTIVE_LINE_LENGTH,
): string[] {
  const refCounts = substantiveLineCounts(reference, minLength);
  const out: string[] = [];
  for (const [line, count] of substantiveLineCounts(candidate, minLength)) {
    if (count >= 2 && count > (refCounts.get(line) ?? 0)) out.push(line);
  }
  return out;
}
