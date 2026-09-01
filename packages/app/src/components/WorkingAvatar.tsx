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

const MARK_SIZE = 20;

const DURATION_SECONDS = 8.4;

interface WorkingAvatarProps {
  status: string;
  className?: string;
  testId?: string;
}

export function WorkingAvatar({ status, className, testId }: WorkingAvatarProps) {
  const { t } = useLingui();
  const skinRef = useRef<SVGPathElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const skin = skinRef.current;
    if (skin === null) return;
    if (reducedMotion) {
      skin.setAttribute('d', FALLBACK_SKIN_PATH);
      skin.setAttribute('stroke-width', String(FALLBACK_STROKE_WIDTH));
      eyesRef.current?.removeAttribute('transform');
      return;
    }
    const library = getShapeLibrary();
    if (library === null) return;

    skin.setAttribute('stroke-width', library.strokeWidth.toFixed(2));
    const source = toMorphSource(library.paths);
    let lastEyeOffset = Number.NaN;
    let lastPath = '';

    return subscribeToMorphClock((elapsed) => {
      const { from, to, t } = morphFrameAt(elapsed, POSE_SEQUENCE.length, DURATION_SECONDS, true);
      const a = source.numbers[POSE_SEQUENCE[from]];
      const b = source.numbers[POSE_SEQUENCE[to]];
      const values = a.map((n, i) => n + (b[i] - n) * t);
      const path = buildMorphedPath(source.fragments, values);
      if (path !== lastPath) {
        lastPath = path;
        skin.setAttribute('d', path);
      }

      const eyes = eyesRef.current;
      if (eyes === null) return;
      const fromOffset = EYE_OFFSET_Y[POSE_SEQUENCE[from]] ?? 0;
      const toOffset = EYE_OFFSET_Y[POSE_SEQUENCE[to]] ?? 0;
      const dy = fromOffset + (toOffset - fromOffset) * t;
      if (dy === lastEyeOffset) return;
      lastEyeOffset = dy;
      eyes.setAttribute('transform', `translate(0 ${dy.toFixed(2)})`);
    });
  }, [reducedMotion]);

  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    setAnnounced(t`The agent is working`);
  }, [t]);

  return (
    <div className={cn('ok-working-enter flex items-center gap-2', className)} data-testid={testId}>
      {}
      <span aria-live="polite" className="sr-only" role="status">
        {announced}
      </span>
      {}
      <span className="grid shrink-0 place-items-center text-muted-foreground/80">
        <svg
          width={MARK_SIZE}
          height={MARK_SIZE}
          viewBox="0 0 30 30"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
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
      {}
      <span key={status} className="ok-working-status text-sm">
        <span className="shimmer">{status}</span>
      </span>
    </div>
  );
}
