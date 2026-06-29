
export function computeRemainingMs(
  lastUtc: string | null,
  intervalSeconds: number,
  now = Date.now(),
): number {
  if (!lastUtc) return 0;
  const lastMs = new Date(lastUtc).getTime();
  if (Number.isNaN(lastMs)) return 0;
  const nextMs = lastMs + intervalSeconds * 1000;
  return Math.max(0, nextMs - now);
}
