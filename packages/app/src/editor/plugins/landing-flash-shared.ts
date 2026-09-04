import type { ResolveConfidence } from '../mode-switch-position-resolver';

export const OK_LANDING_FLASH_CLASS = 'ok-landing-flash';

export function clampFlashRange(
  length: number,
  from: number,
  to: number,
  grade: ResolveConfidence,
): { from: number; to: number } | null {
  if (grade === 'clamped' || grade === 'ordinal') return null;
  const start = Math.max(0, Math.min(from, length));
  const end = Math.max(start, Math.min(to, length));
  if (end <= start) return null;
  return { from: start, to: end };
}
