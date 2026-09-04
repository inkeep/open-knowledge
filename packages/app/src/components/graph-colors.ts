const DARK_PALETTE = [
  '#60a5fa',
  '#a78bfa',
  '#34d399',
  '#f472b6',
  '#fb923c',
  '#22d3ee',
  '#c084fc',
  '#4ade80',
  '#f87171',
  '#eab308',
  '#ec4899',
  '#06b67f',
  '#8b5cf6',
  '#f43f5e',
  '#0ea5e9',
  '#a855f7',
] as const;

const LIGHT_PALETTE = [
  '#1e40af',
  '#6b21a8',
  '#166534',
  '#9f1239',
  '#9a3412',
  '#164e63',
  '#581c87',
  '#166534',
  '#991b1b',
  '#854d0e',
  '#831843',
  '#0f766e',
  '#312e81',
  '#9f1239',
  '#0c4a6e',
  '#6b21a8',
] as const;

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

export function clusterColor(cluster: string, isDark: boolean): string {
  const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
  return palette[stableHash(cluster) % palette.length];
}
