/**
 * The mascot on a server-unreachable error screen, with a game hiding behind it.
 *
 * Until it is woken, this renders exactly the sleeping blob the error screen
 * showed before the game existed — no track, no score, no hint. An easter egg
 * that advertises itself is just a feature in a strange place.
 *
 * Space is deliberately NOT the only key that wakes it. This fallback focuses
 * its "Try again" button on mount, and Space is a focused button's activation
 * key, so binding Space unconditionally would break the recovery control for
 * exactly the users who cannot click it. ArrowUp always works (it is also the
 * jump key, so the reveal is the blob hopping), Space works whenever focus is
 * not on a control, and clicking the blob always works.
 */

import { useEffect, useRef, useState } from 'react';
import { OkBlob } from '@/components/OkBlob';
import { OkBlobRunner } from '@/components/OkBlobRunner';
import { focusIsOnAControl, gameMayHandleKey } from '@/lib/blob-run-keyboard';
import { MASCOT_VIEW_TRANSITION_NAME, withViewTransition } from '@/lib/view-transition';

/** Matches the size the error screens used before the game existed. */
const RESTING_BLOB_SIZE = 80;

interface OkBlobRunnerEasterEggProps {
  /**
   * Let ArrowUp / Space wake it. OFF on crash screens: there the priority is
   * the bug report, so the mascot is opt-in by click only and never competes
   * for a key the report or retry button might want.
   */
  keyboard?: boolean;
}

export function OkBlobRunnerEasterEgg({ keyboard = true }: OkBlobRunnerEasterEggProps = {}) {
  const [awake, setAwake] = useState(false);
  const awakeRef = useRef(false);

  // Reduced motion never gets offered the game, same as the runner itself.
  const [reduceMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (reduceMotion || !keyboard) return;

    function onKeyDown(event: KeyboardEvent) {
      if (awakeRef.current) return;
      const isSpace = event.key === ' ';
      if (!isSpace && event.key !== 'ArrowUp') return;
      // ArrowUp may fire with a button focused (no control treats it as
      // activation), but neither key may fire under an overlay: this same
      // fallback opens a bug-report dialog directly on top of the mascot.
      if (!gameMayHandleKey({ allowWhileFocused: event.key === 'ArrowUp' })) return;
      event.preventDefault();
      awakeRef.current = true;
      withViewTransition(() => setAwake(true));
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [reduceMotion, keyboard]);

  if (awake) return <OkBlobRunner autoStart />;

  if (reduceMotion) return <OkBlob size={RESTING_BLOB_SIZE} variant="sleeping" />;

  return (
    <div
      aria-hidden="true"
      data-slot="ok-blob-runner-easter-egg"
      className="cursor-pointer select-none transition-opacity duration-200"
      style={{ viewTransitionName: MASCOT_VIEW_TRANSITION_NAME }}
      onPointerDown={() => {
        if (focusIsOnAControl()) (document.activeElement as HTMLElement).blur();
        awakeRef.current = true;
        // Same morph as the keyboard path. Without this the click reveal
        // hard-cut while the key reveal tweened, for no reason a user could see.
        withViewTransition(() => setAwake(true));
      }}
    >
      <OkBlob size={RESTING_BLOB_SIZE} variant="sleeping" />
    </div>
  );
}
