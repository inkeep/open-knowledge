function stableHash(str: string): number {
  let h = 2;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

export function clusterColor(cluster: string, palette: readonly string[]): string {
  return palette[stableHash(cluster) % palette.length];
}
