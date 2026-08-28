
const FENCE_RE = /^(`{3,}|~{3,})/gm;

export function findFencedRegions(src: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let openFence: { marker: string; offset: number } | null = null;

  for (const match of src.matchAll(FENCE_RE)) {
    const marker = match[1];
    const offset = match.index;
    if (!openFence) {
      openFence = { marker, offset };
    } else if (marker[0] === openFence.marker[0] && marker.length >= openFence.marker.length) {
      regions.push([openFence.offset, offset + match[0].length]);
      openFence = null;
    }
  }
  if (openFence) {
    regions.push([openFence.offset, src.length]);
  }

  return regions;
}

export function isInsideFence(offset: number, fences: Array<[number, number]>): boolean {
  return fences.some(([start, end]) => offset >= start && offset < end);
}

const BACKTICK_RUN_RE = /`+/g;

export function findInlineCodeRegions(src: string): Array<[number, number]> {
  const runs: Array<{ offset: number; length: number }> = [];
  BACKTICK_RUN_RE.lastIndex = 0;
  for (const match of src.matchAll(BACKTICK_RUN_RE)) {
    runs.push({ offset: match.index, length: match[0].length });
  }

  const regions: Array<[number, number]> = [];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i];
    for (let j = i + 1; j < runs.length; j++) {
      const close = runs[j];
      if (close.length !== open.length) continue;
      regions.push([open.offset, close.offset + close.length]);
      i = j;
      break;
    }
  }
  return regions;
}
