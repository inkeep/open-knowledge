/**
 * Shared pieces of the landing flash — the transient highlight a mode-switch
 * jump paints on the range it landed on, in whichever editor received the
 * landing. The CodeMirror (source) and ProseMirror (WYSIWYG) halves are
 * independent decoration systems, so they share only this leaf: the class both
 * decorate with, and the range-admission rule both apply before dispatching.
 *
 * The class is distinct from the agent-write flash classes so its treatment can
 * diverge from the agent wash later without touching attribution; both halves
 * decorate an inline range, so a single CSS rule styles both.
 */

import type { ResolveConfidence } from '../mode-switch-position-resolver';

export const OK_LANDING_FLASH_CLASS = 'ok-landing-flash';

/**
 * Admit a landing range for a flash, or refuse it. A `clamped` grade means the
 * resolver could not place the target and fell back to a best-effort scroll. An
 * `ordinal` grade means the landing is an unverified ordinal guess: either the
 * count tripwire failed (the two representations disagree about how many
 * top-level blocks exist, so every ordinal after a collapse indexes the wrong
 * block) or content and kind verification both missed at the target. Flashing
 * either grade would assert "here is your text" over text that may not be the
 * user's — refuse both; only content- or kind-verified landings get the
 * precision signal. The range is clamped to `[0, length]`; a range that
 * collapses to empty after clamping (or that arrives empty) is refused because
 * an inline decoration over a zero-width range has nothing to paint.
 */
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
