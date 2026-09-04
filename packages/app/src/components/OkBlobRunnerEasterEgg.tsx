import { useEffect, useRef, useState } from 'react';
import { OkBlob } from '@/components/OkBlob';
import { OkBlobRunner } from '@/components/OkBlobRunner';
import { focusIsOnAControl, gameMayHandleKey } from '@/lib/blob-run-keyboard';
import { MASCOT_VIEW_TRANSITION_NAME, withViewTransition } from '@/lib/view-transition';

const RESTING_BLOB_SIZE = 80;

interface OkBlobRunnerEasterEggProps {
  keyboard?: boolean;
}

export function OkBlobRunnerEasterEgg({ keyboard = true }: OkBlobRunnerEasterEggProps = {}) {
  const [awake, setAwake] = useState(false);
  const awakeRef = useRef(false);

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
        withViewTransition(() => setAwake(true));
      }}
    >
      <OkBlob size={RESTING_BLOB_SIZE} variant="sleeping" />
    </div>
  );
}
