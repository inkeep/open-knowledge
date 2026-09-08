export const RELATIVE_TIME_UNKNOWN = 'unknown';

export function formatRelativeAge(isoString: string, nowMs: number = Date.now()): string {
  const thenMs = Date.parse(isoString);
  if (!Number.isFinite(thenMs)) return RELATIVE_TIME_UNKNOWN;
  const diffSec = Math.floor(Math.max(0, nowMs - thenMs) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}
