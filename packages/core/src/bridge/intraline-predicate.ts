
export function rawLineCounts(doc: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of doc.split('\n')) {
    if (line.trim() === '') continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

export function fragmentHoldsPendingContent(md: string, ytext: string, witness: string): boolean {
  const mdCounts = rawLineCounts(md);
  const ytextCounts = rawLineCounts(ytext);
  const witnessCounts = rawLineCounts(witness);
  for (const [line, mdCount] of mdCounts) {
    if (mdCount > (ytextCounts.get(line) ?? 0) && mdCount > (witnessCounts.get(line) ?? 0)) {
      return true;
    }
  }
  return false;
}

export function pendingContentLines(md: string, ytext: string, witness: string): string[] {
  const mdCounts = rawLineCounts(md);
  const ytextCounts = rawLineCounts(ytext);
  const witnessCounts = rawLineCounts(witness);
  const pending: string[] = [];
  for (const [line, mdCount] of mdCounts) {
    if (mdCount > (ytextCounts.get(line) ?? 0) && mdCount > (witnessCounts.get(line) ?? 0)) {
      pending.push(line);
    }
  }
  return pending;
}
