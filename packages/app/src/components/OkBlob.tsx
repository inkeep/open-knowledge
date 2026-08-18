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
  /** Rendered width/height in px (default 48) */
  size?: number;
  className?: string;
  /**
   * Inline style for the wrapper. Exists so a caller can set
   * `viewTransitionName` without wrapping the mascot in another element, which
   * would change the layout contract the empty-state visual tests pin.
   */
  style?: CSSProperties;
  /** Track mouse position with eyes (default true, disabled under prefers-reduced-motion) */
  trackMouse?: boolean;
  /**
   * Visual state. `'sleeping'` swaps open eyes for closed-arc eyelids, disables
   * mouse tracking + click interactions, and floats lazy "z"s above the body —
   * used by the document error screen so the mascot signals "taking a nap"
   * instead of greeting the user.
   */
  variant?: 'default' | 'sleeping';
  /** Increment to fire a level-3 burst imperatively; 0→0 mount is a no-op. */
  celebrateSignal?: number;
  /**
   * Fired when the USER rage-clicks (three rapid clicks inside the rage
   * window), then again on every rapid click that holds the rage — the reveal
   * gate upstream counts those to decide when it has been earned.
   * Deliberately not fired by `celebrateSignal`, which is programmatic
   * and would otherwise let a seed celebration trigger a user gesture.
   */
  onRage?: () => void;
}

/** Maximum eye offset from resting position, in SVG viewBox units (viewBox 0 0 30 30). */
const MAX_EYE_OFFSET = 1.8;

/** Cursor distance (px) at which eye motion saturates. Smaller = eyes hit max sooner. */
const EYE_DIST_SCALE = 90;

/** Maximum head tilt (degrees) applied as rotateX/rotateY on the wrapper. */
const MAX_HEAD_ROTATION = 16;

/** Cursor distance (px) at which head rotation saturates. */
const HEAD_DIST_SCALE = 380;

/** Eye parallax in viewBox units per degree of head rotation — eyes drift
    opposite to head tilt to sell the "looking at you" effect. */
const EYE_PARALLAX_FACTOR = 0.025;

/** Per-frame interpolation factors. Eyes lerp faster than the head so they
    appear to lead and the head follows — same trick that makes the cursor-
    tracking demo feel alive. */
const HEAD_LERP = 0.1;
const EYE_LERP = 0.18;

/** CSS perspective applied to the wrapper for 3D depth on rotateX/rotateY. */
const PERSPECTIVE_PX = 400;

/** Resting eye positions in SVG viewBox coordinates. */
const LEFT_EYE_CX = 9.2736;
const RIGHT_EYE_CX = 18.1799;
const EYE_CY = 14.5244;

/** Happy-eye arc geometry per level — higher levels squint tighter. */
const HAPPY_EYE_GEOMETRY: Record<ActiveClickLevel, { halfWidth: number; apexLift: number }> = {
  1: { halfWidth: 1.5, apexLift: 2.2 },
  2: { halfWidth: 1.4, apexLift: 2.6 },
  3: { halfWidth: 1.25, apexLift: 3.0 },
};

function happyEyeArc(cx: number, level: ActiveClickLevel): string {
  const { halfWidth, apexLift } = HAPPY_EYE_GEOMETRY[level];
  return `M${cx - halfWidth} ${EYE_CY + 0.3} Q${cx} ${EYE_CY - apexLift}, ${cx + halfWidth} ${EYE_CY + 0.3}`;
}

/** Closed-eyelid arc — a deeper U so the eyes read as "shut" rather than
    "smiling." Endpoints lift slightly above the baseline so the sides of the
    U curl up. */
function sleepingEyeArc(cx: number): string {
  const halfWidth = 1.5;
  const dip = 1.4;
  const endpointLift = 0.3;
  return `M${cx - halfWidth} ${EYE_CY - endpointLift} Q${cx} ${EYE_CY + dip}, ${cx + halfWidth} ${EYE_CY - endpointLift}`;
}

/** Blob's geometric center in SVG viewBox units — each particle spawns on a ring
    around this point so the burst emerges from the body's silhouette rather than
    from a single point on the forehead. */
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

/**
 * Animated blob mascot — the OK character with blinking eyes that follow the cursor.
 *
 * Uses the actual marketing SVG. Eyes blink via CSS keyframes (`ok-blob-blink`
 * in globals.css). A continuous rAF loop lerps both the eye offset (toward
 * the cursor) and a 3D head tilt on the wrapper (rotateX/rotateY), with the
 * eyes counter-shifting slightly opposite the tilt for a parallax "looking
 * at you" effect. Respects `prefers-reduced-motion`.
 *
 * Click reaction escalates with rapid clicks. Every click bounces the group
 * (body + eyes squish together). Only rage — 3+ rapid clicks within the rage
 * window — detonates the chaotic multi-color firework (16 particles, varied
 * sizes and durations, spread across five palette colors). Levels 1 and 2
 * stay quiet on purpose so the rage reward feels earned. Level decays back
 * to idle after ~1s with no clicks.
 */
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
  // Single offset transform shared by all eye variants (open ellipses, happy
  // arcs, sleeping arcs) so swapping between them doesn't jump — every eye
  // type sits at the same cursor-followed position.
  const eyesGroupRef = useRef<SVGGElement>(null);
  const eyeOffsetRef = useRef({ x: 0, y: 0 });
  const [clickLevel, setClickLevel] = useState<ClickLevel>(0);
  const [clickSeq, setClickSeq] = useState(0);
  // Separate from `clickSeq` because the two keys mean different things: the
  // body replays its bounce on every click, while the firework must survive
  // the clicks that land while it is still in flight.
  const [burstSeq, setBurstSeq] = useState(0);
  const [particles, setParticles] = useState<FireworkParticle[]>([]);
  /** When the burst on screen started, so a click can tell in-flight from spent. */
  const burstStartedAtRef = useRef(0);
  const lastClickTimeRef = useRef<number>(0);
  const decayTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isSleeping = variant === 'sleeping';

  function handleClick() {
    // Sleeping blob doesn't react — keep the mascot quietly asleep on the
    // error screen rather than bouncing on click.
    if (isSleeping) return;
    const now =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const dt =
      lastClickTimeRef.current === 0 ? Number.POSITIVE_INFINITY : now - lastClickTimeRef.current;
    lastClickTimeRef.current = now;
    const level = nextClickLevel(clickLevel, dt);
    // A click that lands while the burst is still in the air leaves it alone.
    // Re-detonating on every click restarted it from zero, so a fast clicker
    // only ever saw its first few frames — the reward for clicking was erased
    // by clicking. The click still bounces the body and still counts toward the
    // reveal. Once the burst has run out, sustained rage earns a fresh one
    // rather than nothing: `IDLE_RESET_MS` is the tested-outlasts-the-particles
    // bound, so a click past it has watched the whole thing.
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

  // Imperative celebration trigger. Initial 0 → 0 mount transition is a no-op.
  // Sleeping blob stays asleep regardless — the parent shouldn't ask a napping
  // mascot to throw a party.
  useEffect(() => {
    if (celebrateSignal === 0 || isSleeping) return;
    setClickLevel(3);
    setClickSeq((prev) => prev + 1);
    setParticles(generateFireworkParticles(3));
    // Stamped like a click-driven burst, so a RAGE-level click during a
    // celebration leaves it in the air. Narrow on purpose: a single tap still
    // clears the celebration, because that click resolves to level 1, which
    // carries no particles.
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

    // The rAF loop suspends when the cursor is idle AND every lerp state
    // has converged to its current target (not to zero — the target is
    // non-zero whenever the cursor sits off the blob's center). The
    // previous shape scheduled a new frame unconditionally and never
    // reset `hasMouseMoved`, so after a single mouse event the loop ran
    // a full layout-flush (`getBoundingClientRect`) at 60 fps for the
    // lifetime of the component.
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
      // Refs not yet attached — leave `hasMouseMoved` intact so the signal
      // survives until refs land, and try again next frame.
      if (!svg || !wrapper) {
        scheduleFrame();
        return;
      }
      const moved = hasMouseMoved;
      hasMouseMoved = false;

      const rect = svg.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      // Eyes sit at roughly y=14.5 in a 30-unit viewBox, so ~48% down
      const centerY = rect.top + rect.height * 0.48;

      const dx = mouseX - centerX;
      const dy = mouseY - centerY;
      const dist = Math.hypot(dx, dy);

      // Head rotation — rotateY follows horizontal cursor, rotateX follows
      // vertical (negated so the face tilts up when the cursor is above).
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

      // Converged-to-target detection: when the cursor isn't moving AND
      // the current lerp state is within threshold of every target, the
      // next frame would only update by sub-pixel amounts. Suspend.
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

  // Re-apply the last-known eye offset after every render — the body+eyes
  // group remounts on each click (clickSeq key) so the bounce keyframes
  // replay, and without this the freshly-mounted eyes group would paint at
  // resting for one frame before the next rAF tick. Runs synchronously
  // before paint so there's no visible flash.
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
        {/* Body + eyes share a group so the click bounce deforms them together.
          Key re-mounts the group on every click so the CSS animation replays. */}
        <g
          key={`body-${clickSeq}`}
          className={cn('ok-blob-group', isSleeping && 'ok-blob-sleeping', bounceClass)}
        >
          <path d={MASCOT_OUTLINE_PATH} className="ok-blob-body" />

          {/* Eye group — receives the cursor-tracking translate transform so
            every eye variant (open ellipses, happy arcs, sleeping arcs) sits
            at the same offset. Without this, swapping between variants on
            click would teleport the eyes between offset and resting. */}
          <g ref={eyesGroupRef}>
            {/* Normal eyes — vertical ellipses, hidden when clicked OR sleeping */}
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

            {/* Happy eyes — rounded ^^ arcs, squintier at higher levels */}
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

            {/* Sleeping eyes — downward arcs that read as closed eyelids */}
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

        {/* Floating "z"s — sleep-state only. Two staggered letters drift up and
          fade; the SVG overflow is visible so they can escape the viewBox. */}
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

        {/* Firework burst — rage-click (level 3) only. Particles live outside
          the bounce group so they fly free of the body squish. */}
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
