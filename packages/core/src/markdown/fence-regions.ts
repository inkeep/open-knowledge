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
