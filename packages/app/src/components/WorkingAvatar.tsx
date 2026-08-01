import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';
import { subscribeToMorphClock } from './working-avatar-driver';
import {
  buildMorphedPath,
  EYE,
  EYE_OFFSET_Y,
  FALLBACK_SKIN_PATH,
  FALLBACK_STROKE_WIDTH,
  getShapeLibrary,
  morphFrameAt,
  POSE_SEQUENCE,
  toMorphSource,
} from './working-avatar-shapes';

/** Rendered px. The mark sizes its own slot — there is no reserved column. */
const MARK_SIZE = 20;

/** Seconds for one full pass through {@link POSE_SEQUENCE}. */
const DURATION_SECONDS = 8.4;

interface WorkingAvatarProps {
  /** Already-translated status text. One line, present tense, no percentages.
      Typed as a string, not a node, because it doubles as the remount key that
      replays the swap animation when the line changes. */
  status: string;
  className?: string;
  testId?: string;
}

/**
 * The agent-thread working state: the mascot changing shape beside a status
 * line.
 *
 * The mascot holds each pose, changes into the next, holds again — the beat is
 * what makes it read as deliberate effort rather than a spinner, and effort has
 * to read as effort or a two-minute wait reads as stuck. The squash and squint
 * layers on top come from CSS; only the shape change is JS-driven, because no
 * CSS property interpolates between two path outlines.
 *
 * The `d` attribute is written imperatively rather than through React state —
 * re-rendering a 250-number path string at 60fps would be pure waste.
 */
export function WorkingAvatar({ status, className, testId }: WorkingAvatarProps) {
  const { t } = useLingui();
  const skinRef = useRef<SVGPathElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const skin = skinRef.current;
    if (skin === null) return;
    if (reducedMotion) {
      // Flipping the OS setting mid-turn has to land on the same resting pose a
      // reduced-motion user sees from mount. React will not re-apply the JSX
      // defaults — from its side the props never changed — so the last
      // imperative write would otherwise freeze the mascot half-morphed.
      skin.setAttribute('d', FALLBACK_SKIN_PATH);
      skin.setAttribute('stroke-width', String(FALLBACK_STROKE_WIDTH));
      eyesRef.current?.removeAttribute('transform');
      return;
    }
    // Null on platforms without SVG path measurement (jsdom) — the statically
    // rendered resting pose is already correct there.
    const library = getShapeLibrary();
    if (library === null) return;

    skin.setAttribute('stroke-width', library.strokeWidth.toFixed(2));
    const source = toMorphSource(library.paths);
    let lastEyeOffset = Number.NaN;
    let lastPath = '';

    return subscribeToMorphClock((elapsed) => {
      const { from, to, t } = morphFrameAt(
        elapsed,
        POSE_SEQUENCE.length,
        DURATION_SECONDS,
        // Hold each pose once the morph into it finishes.
        true,
      );
      const a = source.numbers[POSE_SEQUENCE[from]];
      const b = source.numbers[POSE_SEQUENCE[to]];
      const values = a.map((n, i) => n + (b[i] - n) * t);
      const path = buildMorphedPath(source.fragments, values);
      // A held pose produces the same path every frame for the rest of its
      // segment — 40% of the runtime. Writing `d` repaints the element, so skip
      // the writes that would change nothing.
      if (path !== lastPath) {
        lastPath = path;
        skin.setAttribute('d', path);
      }

      const eyes = eyesRef.current;
      if (eyes === null) return;
      // Lerped alongside the morph so the face rides with a body that sits high
      // (the comma), instead of two dots floating off it.
      const fromOffset = EYE_OFFSET_Y[POSE_SEQUENCE[from]] ?? 0;
      const toOffset = EYE_OFFSET_Y[POSE_SEQUENCE[to]] ?? 0;
      const dy = fromOffset + (toOffset - fromOffset) * t;
      if (dy === lastEyeOffset) return;
      lastEyeOffset = dy;
      eyes.setAttribute('transform', `translate(0 ${dy.toFixed(2)})`);
    });
  }, [reducedMotion]);

  // Empty on the first paint, then filled — a live region that mounts with its
  // text already in place is not announced by most screen readers.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    setAnnounced(t`The agent is working`);
  }, [t]);

  return (
    <div className={cn('ok-working-enter flex items-center gap-2', className)} data-testid={testId}>
      {/* The visible line rotates through synonyms every few seconds; piping
          that into a live region would narrate cosmetic variation at a pace no
          one can listen to. So the announcement is one stable sentence, made
          once, and the rotating text stays readable on demand but unannounced. */}
      <span aria-live="polite" className="sr-only" role="status">
        {announced}
      </span>
      {/* Sized to the mark itself, not to a reserved avatar column — this
          transcript has no avatar gutter (agent replies are full-width prose),
          so a fixed column would open a hole beside the smaller poses.

          Fainter than the status text beside it. An opacity modifier rather
          than a lighter colour token, because `--muted-foreground` is
          dark-on-light in one theme and light-on-dark in the other — a fixed
          lighter value would drop contrast in one and raise it in the other. */}
      <span className="grid shrink-0 place-items-center text-muted-foreground/80">
        <svg
          width={MARK_SIZE}
          height={MARK_SIZE}
          viewBox="0 0 30 30"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          // Never scale this with CSS `transform` — the size constant is what
          // keeps the stroke weight honest.
          className="ok-working-pop ok-working-squint block shrink-0 overflow-visible"
        >
          <g className="ok-working-group">
            <path
              ref={skinRef}
              d={FALLBACK_SKIN_PATH}
              fill="none"
              stroke="currentColor"
              strokeWidth={FALLBACK_STROKE_WIDTH}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <g ref={eyesRef}>
              <ellipse
                className="ok-working-eye"
                cx={EYE.leftCx}
                cy={EYE.cy}
                rx={EYE.rx}
                ry={EYE.ry}
                fill="currentColor"
              />
              <ellipse
                className="ok-working-eye"
                cx={EYE.rightCx}
                cy={EYE.cy}
                rx={EYE.rx}
                ry={EYE.ry}
                fill="currentColor"
              />
            </g>
          </g>
        </svg>
      </span>
      {/* Keyed on the text so a changed line remounts and replays the swap
          animation. The fade lives on the outer span and the shimmer on the
          inner one because both are `animation` shorthands — on one element
          the cascade would drop whichever lost. */}
      <span key={status} className="ok-working-status text-sm">
        <span className="shimmer">{status}</span>
      </span>
    </div>
  );
}
