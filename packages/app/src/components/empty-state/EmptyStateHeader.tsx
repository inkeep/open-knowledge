import { useRef } from 'react';
import { OkBlob } from '@/components/OkBlob';
import { nextRageStreak, RAGE_STREAK_TO_REVEAL } from '@/components/ok-blob-runner-logic';
import { MASCOT_VIEW_TRANSITION_NAME } from '@/lib/view-transition';

interface EmptyStateHeaderProps {
  /** Headline rendered as an h2. Keep it short and action-oriented; the blob
   *  carries the friendly greeting, so the headline doesn't need to. */
  readonly title: string;
  /** Optional one-line subtitle below the headline. Pass an explicit prop
   *  rather than children so the layout (blob | text-column) stays uniform
   *  across surfaces. */
  readonly subtitle?: string;
  /** Forwarded to OkBlob so the celebrate burst replays after a successful
   *  seed (or any other parent-triggered moment). Increment to fire. */
  readonly celebrateSignal: number;
  /**
   * Fired when the user rage-clicks the mascot twice in a row. One burst is
   * just the firework; the second is the gesture. Optional, so surfaces that
   * do not host the easter egg simply omit it.
   */
  readonly onRageStreak?: () => void;
}

/**
 * Shared header for the editor canvas's empty-state surfaces. Renders the
 * blob mascot beside a two-line title/subtitle column. Extracted so the
 * surfaces stay visually consistent and a future copy/spacing change lands in
 * one place.
 *
 * The blob sits in its own vertical slot (block-level) rather than inline-
 * flex with the text — see the EmptyEditorState rAF-driven 3D transform
 * comment for why mixing the two caused baseline jitter.
 */
export function EmptyStateHeader({
  title,
  subtitle,
  celebrateSignal,
  onRageStreak,
}: EmptyStateHeaderProps) {
  const streakRef = useRef(0);
  const lastRageAtRef = useRef<number | null>(null);

  function handleRage() {
    // The firework already fired inside OkBlob; this only decides whether the
    // burst was the SECOND in a row.
    const now =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const previous = lastRageAtRef.current;
    const dt = previous === null ? Number.POSITIVE_INFINITY : now - previous;
    lastRageAtRef.current = now;
    const streak = nextRageStreak(streakRef.current, dt);
    streakRef.current = streak;
    if (streak < RAGE_STREAK_TO_REVEAL) return;
    streakRef.current = 0;
    onRageStreak?.();
  }

  return (
    // Narrow pane (`@container/emptystate` in EmptyEditorState): stack the blob
    // above the title, left-aligned with it, so a cramped split-view doesn't
    // squeeze the headline into a sliver beside the blob. Side-by-side at `@md`.
    <div className="flex flex-col items-start gap-3 @md/emptystate:flex-row @md/emptystate:items-center @md/emptystate:gap-4">
      <OkBlob
        size={64}
        celebrateSignal={celebrateSignal}
        onRage={onRageStreak ? handleRage : undefined}
        // Named only where a reveal can happen: the name must be unique in the
        // document, and an un-revealable empty state in another pane would
        // collide and make the browser skip the transition.
        style={onRageStreak ? { viewTransitionName: MASCOT_VIEW_TRANSITION_NAME } : undefined}
      />
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-light tracking-tighter text-balance">{title}</h2>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
    </div>
  );
}
