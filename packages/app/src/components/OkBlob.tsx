import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { MASCOT_OUTLINE_PATH } from './mascot-outline';
import {
  type ActiveClickLevel,
  type ClickLevel,
  type FireworkParticle,
  generateFireworkParticles,
  IDLE_RESET_MS,
  nextClickLevel,
} from './ok-blob-logic';

interface OkBlobProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  trackMouse?: boolean;
  variant?: 'default' | 'sleeping';
  celebrateSignal?: number;
  onRage?: () => void;
}

const MAX_EYE_OFFSET = 1.8;

const EYE_DIST_SCALE = 90;

const MAX_HEAD_ROTATION = 16;

const HEAD_DIST_SCALE = 380;

const EYE_PARALLAX_FACTOR = 0.025;

const HEAD_LERP = 0.1;
const EYE_LERP = 0.18;

const PERSPECTIVE_PX = 400;

const LEFT_EYE_CX = 9.2736;
const RIGHT_EYE_CX = 18.1799;
const EYE_CY = 14.5244;

const HAPPY_EYE_GEOMETRY: Record<ActiveClickLevel, { halfWidth: number; apexLift: number }> = {
  1: { halfWidth: 1.5, apexLift: 2.2 },
  2: { halfWidth: 1.4, apexLift: 2.6 },
  3: { halfWidth: 1.25, apexLift: 3.0 },
};

function happyEyeArc(cx: number, level: ActiveClickLevel): string {
  const { halfWidth, apexLift } = HAPPY_EYE_GEOMETRY[level];
  return `M${cx - halfWidth} ${EYE_CY + 0.3} Q${cx} ${EYE_CY - apexLift}, ${cx + halfWidth} ${EYE_CY + 0.3}`;
}

function sleepingEyeArc(cx: number): string {
  const halfWidth = 1.5;
  const dip = 1.4;
  const endpointLift = 0.3;
  return `M${cx - halfWidth} ${EYE_CY - endpointLift} Q${cx} ${EYE_CY + dip}, ${cx + halfWidth} ${EYE_CY - endpointLift}`;
}

const FIREWORK_CENTER_X = 15;
const FIREWORK_CENTER_Y = 15;

function particleStyle(p: FireworkParticle): CSSProperties {
  return {
    fill: p.color,
    ['--fx-tx' as string]: `${p.dx}px`,
    ['--fx-ty' as string]: `${p.dy}px`,
    ['--fx-delay' as string]: `${p.delay}ms`,
    ['--fx-duration' as string]: `${p.duration}ms`,
  };
}

export function OkBlob({
  size = 48,
  className,
  style,
  trackMouse = true,
  variant = 'default',
  celebrateSignal = 0,
  onRage,
}: OkBlobProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const eyesGroupRef = useRef<SVGGElement>(null);
  const eyeOffsetRef = useRef({ x: 0, y: 0 });
  const [clickLevel, setClickLevel] = useState<ClickLevel>(0);
  const [clickSeq, setClickSeq] = useState(0);
  const [burstSeq, setBurstSeq] = useState(0);
  const [particles, setParticles] = useState<FireworkParticle[]>([]);
  const burstStartedAtRef = useRef(0);
  const lastClickTimeRef = useRef<number>(0);
  const decayTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isSleeping = variant === 'sleeping';

  function handleClick() {
    if (isSleeping) return;
    const now =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const dt =
      lastClickTimeRef.current === 0 ? Number.POSITIVE_INFINITY : now - lastClickTimeRef.current;
    lastClickTimeRef.current = now;
    const level = nextClickLevel(clickLevel, dt);
    const burstInFlight = clickLevel === 3 && now - burstStartedAtRef.current < IDLE_RESET_MS;
    const sustainingRage = level === 3 && burstInFlight;
    if (level === 3) onRage?.();
    setClickLevel(level);
    setClickSeq((prev) => prev + 1);
    if (!sustainingRage) {
      setParticles(generateFireworkParticles(level));
      if (level === 3) {
        burstStartedAtRef.current = now;
        setBurstSeq((prev) => prev + 1);
      }
    }
    clearTimeout(decayTimerRef.current);
    decayTimerRef.current = setTimeout(() => {
      setClickLevel(0);
      setParticles([]);
    }, IDLE_RESET_MS);
  }

  useEffect(() => () => clearTimeout(decayTimerRef.current), []);

  useEffect(() => {
    if (celebrateSignal === 0 || isSleeping) return;
    setClickLevel(3);
    setClickSeq((prev) => prev + 1);
    setParticles(generateFireworkParticles(3));
    burstStartedAtRef.current =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    setBurstSeq((prev) => prev + 1);
    clearTimeout(decayTimerRef.current);
    decayTimerRef.current = setTimeout(() => {
      setClickLevel(0);
      setParticles([]);
    }, IDLE_RESET_MS);
  }, [celebrateSignal, isSleeping]);

  useEffect(() => {
    if (!trackMouse || isSleeping) return;

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) return;

    let mouseX = 0;
    let mouseY = 0;
    let hasMouseMoved = false;
    let currentRotX = 0;
    let currentRotY = 0;
    let currentEyeX = 0;
    let currentEyeY = 0;
    let raf = 0;

    const LERP_SETTLED_THRESHOLD = 0.01;

    function scheduleFrame() {
      if (raf === 0) raf = requestAnimationFrame(frame);
    }

    function onMouseMove(e: MouseEvent) {
      mouseX = e.clientX;
      mouseY = e.clientY;
      hasMouseMoved = true;
      scheduleFrame();
    }

    function frame() {
      raf = 0;
      const svg = svgRef.current;
      const wrapper = wrapperRef.current;
      if (!svg || !wrapper) {
        scheduleFrame();
        return;
      }
      const moved = hasMouseMoved;
      hasMouseMoved = false;

      const rect = svg.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height * 0.48;

      const dx = mouseX - centerX;
      const dy = mouseY - centerY;
      const dist = Math.hypot(dx, dy);

      const normX = Math.max(-1, Math.min(1, dx / HEAD_DIST_SCALE));
      const normY = Math.max(-1, Math.min(1, dy / HEAD_DIST_SCALE));
      const targetRotX = -normY * MAX_HEAD_ROTATION;
      const targetRotY = normX * MAX_HEAD_ROTATION;
      let targetEyeX = 0;
      let targetEyeY = 0;
      if (dist >= 1) {
        const scale = Math.min(dist / EYE_DIST_SCALE, 1) * MAX_EYE_OFFSET;
        targetEyeX = (dx / dist) * scale;
        targetEyeY = (dy / dist) * scale;
      }

      const settled =
        Math.abs(targetRotX - currentRotX) < LERP_SETTLED_THRESHOLD &&
        Math.abs(targetRotY - currentRotY) < LERP_SETTLED_THRESHOLD &&
        Math.abs(targetEyeX - currentEyeX) < LERP_SETTLED_THRESHOLD &&
        Math.abs(targetEyeY - currentEyeY) < LERP_SETTLED_THRESHOLD;
      if (!moved && settled) return;
      scheduleFrame();

      currentRotX += (targetRotX - currentRotX) * HEAD_LERP;
      currentRotY += (targetRotY - currentRotY) * HEAD_LERP;
      wrapper.style.transform = `perspective(${PERSPECTIVE_PX}px) rotateX(${currentRotX.toFixed(3)}deg) rotateY(${currentRotY.toFixed(3)}deg)`;

      currentEyeX += (targetEyeX - currentEyeX) * EYE_LERP;
      currentEyeY += (targetEyeY - currentEyeY) * EYE_LERP;
      const parallaxX = currentRotY * EYE_PARALLAX_FACTOR;
      const parallaxY = -currentRotX * EYE_PARALLAX_FACTOR;
      const ox = currentEyeX + parallaxX;
      const oy = currentEyeY + parallaxY;
      eyeOffsetRef.current.x = ox;
      eyeOffsetRef.current.y = oy;
      eyesGroupRef.current?.setAttribute(
        'transform',
        `translate(${ox.toFixed(3)} ${oy.toFixed(3)})`,
      );
    }

    document.addEventListener('mousemove', onMouseMove, { passive: true });
    scheduleFrame();
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      if (wrapperRef.current) wrapperRef.current.style.transform = '';
      eyeOffsetRef.current = { x: 0, y: 0 };
      eyesGroupRef.current?.removeAttribute('transform');
    };
  }, [trackMouse, isSleeping]);

  useLayoutEffect(() => {
    const g = eyesGroupRef.current;
    if (!g) return;
    const { x, y } = eyeOffsetRef.current;
    g.setAttribute('transform', `translate(${x.toFixed(3)} ${y.toFixed(3)})`);
  });

  const isClicked = clickLevel > 0;
  const activeLevel: ActiveClickLevel = isClicked ? (clickLevel as ActiveClickLevel) : 1;
  const bounceClass = isClicked ? `ok-blob-clicked-${clickLevel}` : null;

  return (
    <span ref={wrapperRef} className={cn('ok-blob-3d-wrapper', className)} style={style}>
      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox="0 0 30 30"
        fill="none"
        overflow="visible"
        xmlns="http://www.w3.org/2000/svg"
        className={isSleeping ? 'cursor-default' : 'cursor-pointer'}
        aria-hidden="true"
        onClick={handleClick}
        onMouseDown={(e) => e.preventDefault()}
      >
        {}
        <g
          key={`body-${clickSeq}`}
          className={cn('ok-blob-group', isSleeping && 'ok-blob-sleeping', bounceClass)}
        >
          <path d={MASCOT_OUTLINE_PATH} className="ok-blob-body" />

          {}
          <g ref={eyesGroupRef}>
            {}
            <ellipse
              cx={LEFT_EYE_CX}
              cy={EYE_CY}
              rx={1.2722}
              ry={1.9083}
              className={cn('ok-blob-eye', (isClicked || isSleeping) && 'ok-blob-eye-hidden')}
            />
            <ellipse
              cx={RIGHT_EYE_CX}
              cy={EYE_CY}
              rx={1.2722}
              ry={1.9083}
              className={cn(
                'ok-blob-eye ok-blob-eye-right',
                (isClicked || isSleeping) && 'ok-blob-eye-hidden',
              )}
            />

            {}
            <path
              d={happyEyeArc(LEFT_EYE_CX, activeLevel)}
              strokeWidth="1.2"
              strokeLinecap="round"
              fill="none"
              className={cn(
                'ok-blob-happy-eye',
                (!isClicked || isSleeping) && 'ok-blob-eye-hidden',
              )}
            />
            <path
              d={happyEyeArc(RIGHT_EYE_CX, activeLevel)}
              strokeWidth="1.2"
              strokeLinecap="round"
              fill="none"
              className={cn(
                'ok-blob-happy-eye',
                (!isClicked || isSleeping) && 'ok-blob-eye-hidden',
              )}
            />

            {}
            {isSleeping ? (
              <>
                <path
                  d={sleepingEyeArc(LEFT_EYE_CX)}
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  fill="none"
                  className="ok-blob-sleeping-eye"
                />
                <path
                  d={sleepingEyeArc(RIGHT_EYE_CX)}
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  fill="none"
                  className="ok-blob-sleeping-eye"
                />
              </>
            ) : null}
          </g>
        </g>

        {}
        {isSleeping ? (
          <g>
            <text x={21} y={7} className="ok-blob-z ok-blob-z-1">
              z
            </text>
            <text x={26} y={2} className="ok-blob-z ok-blob-z-2">
              z
            </text>
          </g>
        ) : null}

        {}
        {particles.length > 0 && (
          <g key={`firework-${burstSeq}`} data-slot="ok-blob-burst">
            {particles.map((p) => (
              <circle
                key={p.id}
                cx={FIREWORK_CENTER_X + p.originDx}
                cy={FIREWORK_CENTER_Y + p.originDy}
                r={p.size}
                className="ok-blob-firework"
                style={particleStyle(p)}
              />
            ))}
          </g>
        )}
      </svg>
    </span>
  );
}
