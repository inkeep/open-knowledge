const HEADING_PRECEDENTS_RE = /^##\s+.*\(precedents?\s+([^()]*)\)\s*$/gm;
const RANGE_RE = /^\s*(\d+)\s*[-–—]\s*(\d+)\s*$/;
const LEADING_NUMBER_RE = /^\s*(\d+)\b/;

const PRECEDENT_CITATION_RE = /\bprecedent\s+#(\d+)/gi;

export function parsePrecedentNumbers(markdown) {
  const numbers = new Set();
  for (const match of markdown.matchAll(HEADING_PRECEDENTS_RE)) {
    for (const part of match[1].split(',')) {
      const range = RANGE_RE.exec(part);
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        for (let n = from; n <= to; n += 1) numbers.add(n);
        continue;
      }
      const single = LEADING_NUMBER_RE.exec(part);
      if (single) numbers.add(Number(single[1]));
    }
  }
  return numbers;
}

export class UnvalidatedPrecedentRegistry extends Set {
  has() {
    return true;
  }
}

export function citedPrecedentNumbers(commentText) {
  const cited = [];
  for (const match of commentText.matchAll(PRECEDENT_CITATION_RE)) cited.push(Number(match[1]));
  return cited;
}
