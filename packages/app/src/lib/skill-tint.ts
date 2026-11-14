export const SKILL_TINTS = [
  'from-chart-5/10 to-identity-4/10',
  'from-chart-2/10 to-chart-1/10',
  'from-chart-4/10 to-chart-1/10',
  'from-chart-3/10 to-chart-5/10',
  'from-chart-1/10 to-chart-4/10',
  'from-chart-2/10 to-chart-3/10',
] as const;

export function skillTint(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return SKILL_TINTS[Math.abs(h) % SKILL_TINTS.length] ?? SKILL_TINTS[0];
}
