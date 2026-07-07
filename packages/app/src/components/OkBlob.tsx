import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
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
  trackMouse = true,
  variant = 'default',
  celebrateSignal = 0,
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
  const [particles, setParticles] = useState<FireworkParticle[]>([]);
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
    setClickLevel(level);
    setClickSeq((prev) => prev + 1);
    setParticles(generateFireworkParticles(level));
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
    <span ref={wrapperRef} className={cn('ok-blob-3d-wrapper', className)}>
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
          <path
            d="M25.2339 6.78134C25.5199 7.35734 25.8179 8.47234 26.0179 9.07834C26.0189 9.08234 26.0209 9.08634 26.0219 9.09134C26.0229 9.09534 26.0249 9.10034 26.0259 9.10434C26.0539 9.19734 26.0949 9.29533 26.1519 9.41633C26.2919 9.71133 26.5269 10.1173 27.1299 11.1683C27.3259 11.4643 27.5209 11.7693 27.7119 12.0903C29.9739 15.1623 29.3259 20.1913 27.0469 22.9153C26.7779 23.2953 26.4869 23.6043 26.1889 23.8863C26.1519 23.9253 26.1129 23.9643 26.0729 24.0033C25.3159 24.7543 24.2949 25.4673 23.6129 25.8323C22.7469 26.2983 22.1349 26.5483 21.6299 26.7463C20.3649 27.3063 19.0609 27.7733 17.6569 28.0423C15.9649 28.3513 14.1939 28.4433 12.4569 28.1373C11.4779 27.9663 10.5119 27.6663 9.60891 27.2493C8.77491 26.8663 7.99192 26.3853 7.26992 25.8403C6.83592 25.5393 6.43893 25.2343 6.08093 24.9383C5.57893 24.5223 5.15993 24.1263 4.83493 23.7793C4.04993 22.9443 3.31593 21.8893 2.80893 21.0953C2.72593 20.9663 2.64792 20.8433 2.57592 20.7293C2.56192 20.7093 2.54793 20.6893 2.53393 20.6703C2.08593 20.0263 1.71892 19.3293 1.43792 18.5993C1.42892 18.5453 1.42093 18.4903 1.41293 18.4353C1.32093 17.7443 1.08292 16.9423 1.01092 15.6333C0.984921 15.0653 0.998928 14.4013 1.12393 13.6353C1.20693 13.1413 1.31993 12.9023 1.40893 12.7113C1.43593 12.6543 1.46193 12.6023 1.48593 12.5483C1.56793 12.3653 1.59392 12.1563 1.63592 11.9083C1.68992 11.5883 1.76992 11.1943 2.04592 10.7553C2.94392 9.37934 3.36792 8.81934 3.66592 8.33934C3.75592 8.20334 3.84292 8.08134 3.94192 7.96634C4.21592 7.64634 4.67693 7.29534 5.10293 7.05734C5.16693 7.02234 5.23093 6.98834 5.29193 6.95534C5.62993 6.77834 6.22592 6.30135 6.66992 5.92035C6.83692 5.77635 7.08193 5.60735 7.37393 5.40935C7.67393 5.20535 8.02593 4.96934 8.39193 4.70234C9.32093 4.02634 9.84091 3.69134 10.2599 3.42334C10.3799 3.34734 10.4919 3.27734 10.6049 3.20834C10.9609 2.98834 11.4149 2.73034 11.8869 2.48634C12.4519 2.19334 13.0469 1.92133 13.5089 1.72233C14.7399 1.30233 16.0539 1.01333 17.4169 1.00033C18.1169 0.991333 18.7939 1.16534 19.2389 1.43034C19.6869 1.69534 19.8689 2.00335 19.8039 2.23935C19.7379 2.47835 19.4399 2.63634 19.0109 2.74734C18.5789 2.85634 18.0469 2.92035 17.4889 2.96135C16.3639 3.04235 15.2399 3.36435 14.1499 3.80835C12.8199 4.35135 11.5379 5.07133 10.2719 5.84733C9.38691 6.39133 8.51192 6.97334 7.63592 7.56834C7.54492 7.63034 7.45492 7.69135 7.36492 7.75235C6.97392 8.06635 6.58293 8.38134 6.22293 8.66334C5.97893 8.85734 5.76793 9.04834 5.59393 9.21434C5.26893 9.52334 5.02393 9.74334 4.81893 9.93934C4.67793 10.0753 4.55793 10.2013 4.45593 10.3443C4.40093 10.4213 4.32992 10.5273 4.24792 10.6593C3.90492 11.1933 3.44493 12.1693 3.15393 13.1173C3.01893 13.5363 2.87991 14.0343 2.79391 14.5253C2.66591 15.2253 2.65594 15.9053 2.71994 16.2373C2.82794 16.8193 2.95593 17.4833 3.14093 18.0553C3.31293 18.6003 3.52991 19.0583 3.70791 19.2823C3.81591 19.4183 3.90394 19.5473 3.99594 19.6913C4.09394 19.8413 4.19191 20.0073 4.31091 20.2033C4.47891 20.4803 4.68592 20.8163 5.00192 21.2493C5.36492 21.7463 5.61793 22.1043 5.83493 22.4023C6.14493 22.8243 6.38591 23.1343 6.83691 23.5033C7.33891 23.9113 7.86593 24.3113 8.26693 24.6393C8.44893 24.7883 8.66993 24.9443 8.90493 25.0963C9.21593 25.2963 9.55192 25.4893 9.85592 25.6703C10.1059 25.8203 10.3059 25.9633 10.4869 26.0863C10.5429 26.1243 10.5979 26.1603 10.6519 26.1943C10.8699 26.2803 11.0929 26.3593 11.3159 26.4283C11.3539 26.4323 11.3949 26.4353 11.4369 26.4393C11.6509 26.4573 11.9089 26.4733 12.2209 26.5133C12.7169 26.5753 13.1399 26.6603 13.6019 26.7243C13.9589 26.7733 14.3409 26.8083 14.7729 26.7893C15.0729 26.7753 15.4069 26.7353 15.7389 26.6813C16.2349 26.6023 16.7179 26.4943 17.0569 26.4473C17.1499 26.4343 17.2359 26.4343 17.3209 26.4373C17.3489 26.4393 17.3799 26.4413 17.4109 26.4433C17.4119 26.4433 17.4119 26.4433 17.4129 26.4433C17.4199 26.4433 17.4279 26.4443 17.4349 26.4443C18.2329 26.2413 19.0259 25.9433 19.7959 25.5983C19.8609 25.5633 19.9259 25.5273 19.9899 25.4913C20.3059 25.3173 20.6049 25.1383 20.7869 24.9943C20.9829 24.8393 21.5189 24.5373 22.0579 24.1853C22.4109 23.9553 22.7649 23.7053 23.0369 23.4833C23.1949 23.3553 23.3689 23.2693 23.5479 23.1773C23.7129 23.0923 23.8809 23.0013 24.0349 22.8653C24.1109 22.7983 24.1869 22.7173 24.2639 22.6303C24.3309 22.5563 24.4039 22.4723 24.4759 22.3923C24.5459 22.3153 24.7199 22.1723 24.9139 21.9793C25.0079 21.8863 25.1059 21.7783 25.1909 21.6713C25.2199 21.6323 25.2489 21.5943 25.2769 21.5553C25.5919 21.0403 25.8779 20.5003 26.1019 19.9653C26.1299 19.8403 26.1379 19.7293 26.1279 19.6373C26.1199 19.5703 26.1029 19.5113 26.0839 19.4503C26.0599 19.3643 26.0329 19.2773 26.0239 19.1723C26.0169 19.0893 26.0309 19.0043 26.0629 18.9543C26.0779 18.9323 26.0969 18.9143 26.1129 18.8993C26.1329 18.8823 26.1499 18.8673 26.1569 18.8443C26.1609 18.8273 26.1579 18.8073 26.1529 18.7833C26.1459 18.7443 26.1369 18.6943 26.1539 18.6293C26.2189 18.3853 26.2869 18.1103 26.3319 17.8383C26.3829 17.5393 26.4049 17.2433 26.3949 17.0123C26.3849 16.7493 26.3909 16.3823 26.3469 16.0003C26.3179 15.7343 26.2659 15.4663 26.1979 15.2383C26.1319 15.0143 26.0219 14.7913 25.9039 14.5783C25.7629 14.3223 25.6119 14.0783 25.5169 13.8453C25.4969 13.7983 25.4999 13.7263 25.4999 13.6323C25.5009 13.5673 25.4999 13.4913 25.4919 13.4083C25.3239 13.1243 25.1459 12.8423 24.9589 12.5483C24.9479 12.5413 24.9369 12.5333 24.9249 12.5263C24.6689 12.3503 24.3139 12.1173 24.0769 11.5503C24.0179 11.4063 24.0069 11.2983 23.9969 11.1993C23.9859 11.1013 23.9799 11.0183 23.9289 10.9093C23.8709 10.7853 23.7759 10.6583 23.6709 10.4993C23.5849 10.3703 23.4899 10.2133 23.4199 10.0423C23.3819 9.95134 23.3509 9.85734 23.3329 9.75934C23.3299 9.74334 23.3269 9.72534 23.3229 9.70634C23.2899 9.52734 23.2439 9.26534 23.2409 8.98634C23.0209 8.24434 22.8339 7.48833 22.6519 6.77633C22.3429 5.57133 22.0519 4.54234 21.3329 3.95434C20.9839 3.65334 20.5689 3.35433 20.2459 3.05433C19.9259 2.75633 19.7449 2.47534 19.8019 2.23834C19.8639 2.00634 20.1589 1.82934 20.6659 1.80534C21.1699 1.78334 21.8699 1.93235 22.5209 2.39235C23.6159 3.14235 24.2029 4.38334 24.5599 5.35734C24.5829 5.40834 24.6049 5.46034 24.6259 5.51234C24.7849 5.89434 24.9529 6.22834 25.1199 6.55534C25.1579 6.63034 25.1969 6.70834 25.2339 6.78134Z"
            className="ok-blob-body"
          />

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
          <g key={`firework-${clickSeq}`}>
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
