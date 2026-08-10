/**
 * OkBlobRunner — the offline-dino easter egg, starring the OK blob.
 *
 * Takes over the mascot slot on error screens where the user is waiting on
 * something outside their control (the collab server being unreachable) rather
 * than being asked to act. At rest it is pixel-identical to the sleeping blob
 * it replaces, so the error screen still reads as an error screen; the game
 * only exists once the user pokes it.
 *
 * Pointer and keyboard both drive it. The error fallbacks focus their "Try
 * again" button on mount and Space activates it, so the key handler stands
 * down whenever focus sits on an interactive element: Space belongs to the
 * focused control until the player deliberately engages the game by clicking
 * the track, which blurs that control. Tab moves back out and hands Space
 * back. That keeps the recovery affordance intact without giving up keyboard
 * play, which the earlier pointer-only rule did.
 *
 * Rendering deliberately bypasses React during a run: the physics live in a
 * ref, and each frame writes transforms straight to pooled DOM nodes. React
 * state changes only on phase transitions (three times per run).
 */

import { Trans } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { OkBlob } from '@/components/OkBlob';
import { focusIsOnAControl, gameMayHandleKey } from '@/lib/blob-run-keyboard';
import { MASCOT_VIEW_TRANSITION_NAME } from '@/lib/view-transition';
import {
  createRunnerState,
  deformationOf,
  jumpRunner,
  MAX_JUMP_HEIGHT,
  PLAYER_FOOT_INSET,
  PLAYER_SIZE,
  PLAYER_X,
  type RunnerPhase,
  readBestScore,
  scoreOf,
  setDucking,
  startRunner,
  stepRunner,
  writeBestScore,
} from './ok-blob-runner-logic';

/** Play area height: a full jump, plus the blob, plus a little headroom. */
const TRACK_HEIGHT = Math.ceil(MAX_JUMP_HEIGHT + PLAYER_SIZE + 8);

/**
 * Obstacles recycle through a fixed pool of DOM nodes so a run costs zero
 * React renders. An obstacle past the pool still COLLIDES while never being
 * painted, so this bound is load-bearing rather than cosmetic.
 *
 * Measured peak concurrent obstacles, spawning with the tightest jitter draw:
 * 4 at a 1200px track, 5 at 1600px, 7 at 2400px, 10 at 3400px. Spacing is
 * proportional to speed, so the ceiling scales with track width at roughly one
 * obstacle per 340px. 24 covers past 8000px, wider than any real display.
 * The `pool bound` suite in `ok-blob-runner-logic.test.ts` pins it.
 */
export const OBSTACLE_POOL_SIZE = 24;

/** Stable identities for the pool nodes; the pool never reorders or resizes. */
const OBSTACLE_SLOTS = Array.from({ length: OBSTACLE_POOL_SIZE }, (_, i) => `obstacle-slot-${i}`);

/**
 * Beat between the play area appearing and the blob starting to run, so a
 * reveal reads as one motion. Tracks the container's fade duration.
 */
const REVEAL_WAKE_DELAY_MS = 300;

const SCORE_DIGITS = 4;

/**
 * Pointer input is split by height rather than by gesture: press in the upper
 * band to jump, hold in the lower band to duck. A press-and-hold discriminator
 * would have to delay every jump by the hold threshold to tell the two apart,
 * and a jump that arrives 180ms late is not a jump.
 */
const DUCK_BAND_FRACTION = 0.45;

interface OkBlobRunnerProps {
  /** Begin a run on mount. Used by the reveal, where the player already acted. */
  autoStart?: boolean;
}

export function OkBlobRunner({ autoStart = false }: OkBlobRunnerProps = {}) {
  const stateRef = useRef(createRunnerState());
  const trackRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLSpanElement>(null);
  const obstacleRefs = useRef<(HTMLDivElement | null)[]>([]);

  const [phase, setPhase] = useState<RunnerPhase>('idle');
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => readBestScore());
  // Mirror of `best` for the rAF loop, which must compare against the current
  // value without re-subscribing every frame. Only ever written where `best` is.
  const bestRef = useRef(best);
  /** Bumped when a run beats the stored best, to fire the mascot's burst. */
  const [celebrateSignal, setCelebrateSignal] = useState(0);
  const [beatBest, setBeatBest] = useState(false);

  // Lazy-init from the live query so a reduced-motion user never gets offered
  // the game in the first place.
  const [reduceMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  // Reveal path: the player already acted (they woke the easter egg), so drop
  // straight into a run. An effect rather than a render-time start — React
  // Compiler rejects touching a ref during render, and the build, not the
  // typechecker, is what catches that.
  useEffect(() => {
    // Reduced motion renders the static mascot and never the track, so starting
    // a run here would spin the rAF loop forever on a game nobody can see.
    if (!autoStart || reduceMotion) return;
    // Deliberately not immediate. On the reveal paths the mascot is already
    // on screen asleep, so starting on the same frame the track appears reads
    // as a cut. Letting the world fade in first and waking him after makes it
    // one continuous moment. Matches the container's fade duration.
    const wake = setTimeout(() => {
      startRunner(stateRef.current);
      setPhase('running');
    }, REVEAL_WAKE_DELAY_MS);
    return () => clearTimeout(wake);
  }, [autoStart, reduceMotion]);

  useEffect(() => {
    if (phase !== 'running') return;

    let raf = 0;
    let last = performance.now();

    function paint() {
      const state = stateRef.current;
      if (playerRef.current) {
        const { scaleX, scaleY } = deformationOf(state);
        playerRef.current.style.transform = `translateY(${PLAYER_FOOT_INSET - state.y}px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
      }
      for (let i = 0; i < OBSTACLE_POOL_SIZE; i++) {
        const node = obstacleRefs.current[i];
        if (!node) continue;
        const obstacle = state.obstacles[i];
        if (!obstacle) {
          node.style.opacity = '0';
          continue;
        }
        node.style.opacity = '1';
        node.style.width = `${obstacle.width}px`;
        node.style.height = `${obstacle.height}px`;
        node.style.bottom = `${obstacle.y}px`;
        // Overhead hazards read as rounded floaters, ground ones as blocks, so
        // the player can tell jump-over from duck-under at a glance.
        node.style.borderRadius = obstacle.kind === 'overhead' ? '9999px' : '3px';
        node.style.transform = `translateX(${obstacle.x}px)`;
      }
      if (scoreRef.current) {
        scoreRef.current.textContent = String(scoreOf(state)).padStart(SCORE_DIGITS, '0');
      }
    }

    function frame(now: number) {
      const state = stateRef.current;
      stepRunner(state, (now - last) / 1000, trackRef.current?.clientWidth ?? 0);
      last = now;
      paint();
      if (state.phase === 'over') {
        const final = scoreOf(state);
        // Decided outside the updater on purpose. A state updater must be pure,
        // and StrictMode double-invokes it in development, which would persist
        // the score twice and fire the burst twice.
        const isRecord = final > bestRef.current;
        setScore(final);
        if (isRecord) {
          bestRef.current = final;
          writeBestScore(final);
          setBest(final);
          setBeatBest(true);
          setCelebrateSignal((signal) => signal + 1);
        }
        setPhase('over');
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  useEffect(() => {
    // Reduced motion renders the static mascot and no game, so these listeners
    // would swallow Space and the arrows for a user with nothing to control.
    if (reduceMotion) return;

    function start() {
      startRunner(stateRef.current);
      setBeatBest(false);
      setPhase('running');
    }

    function onKeyDown(event: KeyboardEvent) {
      const state = stateRef.current;
      if (event.key === 'ArrowDown') {
        // Arrows are not an activation key, so a focused button may keep focus,
        // but an open overlay still owns the keyboard.
        if (!gameMayHandleKey({ allowWhileFocused: true })) return;
        event.preventDefault();
        setDucking(state, true);
        return;
      }
      if (event.key !== ' ' && event.key !== 'ArrowUp') return;
      if (!gameMayHandleKey({ allowWhileFocused: event.key === 'ArrowUp' })) return;
      // Space would otherwise scroll the surface behind the game.
      event.preventDefault();
      if (state.phase === 'running') jumpRunner(state);
      else start();
    }

    function onKeyUp(event: KeyboardEvent) {
      // Always release, even under an overlay: a duck held when a dialog opened
      // would otherwise stick forever.
      if (event.key === 'ArrowDown') setDucking(stateRef.current, false);
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [reduceMotion]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // Clicking the track is the deliberate hand-off: drop focus from whatever
    // control held it so Space reaches the game from here on.
    if (focusIsOnAControl()) (document.activeElement as HTMLElement).blur();
    const state = stateRef.current;
    if (state.phase !== 'running') {
      startRunner(state);
      setBeatBest(false);
      setPhase('running');
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const fromTop = event.clientY - rect.top;
    if (fromTop > rect.height * (1 - DUCK_BAND_FRACTION)) {
      setDucking(state, true);
      // Capture so the duck still releases if the pointer slides off-track.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    jumpRunner(state);
  }

  function releaseDuck() {
    setDucking(stateRef.current, false);
  }

  if (reduceMotion) return <OkBlob size={PLAYER_SIZE} variant="sleeping" />;

  const asleep = phase !== 'running' && !beatBest;

  return (
    // Decorative by construction: pointer-only, and every load-bearing
    // affordance on the error screen lives outside this subtree.
    <div
      aria-hidden="true"
      data-slot="ok-blob-runner"
      className="w-full select-none animate-in fade-in-0 slide-in-from-bottom-2 duration-300 motion-reduce:animate-none"
    >
      <div
        ref={trackRef}
        data-slot="ok-blob-runner-track"
        className="relative w-full cursor-pointer overflow-hidden border-b border-dashed border-border"
        style={{ height: TRACK_HEIGHT }}
        onPointerDown={handlePointerDown}
        onPointerUp={releaseDuck}
        onPointerCancel={releaseDuck}
        onPointerLeave={releaseDuck}
      >
        <div className="absolute top-0 end-0 flex gap-3 font-mono text-xs tabular-nums text-muted-foreground/60">
          {best > 0 ? (
            <span className={beatBest ? 'text-muted-foreground' : undefined}>
              <Trans>HI</Trans> {String(best).padStart(SCORE_DIGITS, '0')}
            </span>
          ) : null}
          <span ref={scoreRef}>{String(score).padStart(SCORE_DIGITS, '0')}</span>
        </div>

        <div
          ref={playerRef}
          className="absolute bottom-0 flex origin-bottom will-change-transform"
          style={{
            left: PLAYER_X,
            transform: `translateY(${PLAYER_FOOT_INSET}px)`,
            // Same name as the empty-state mascot so the browser tweens one
            // into the other. Reveal path only: two elements sharing a name at
            // once makes the browser skip the transition entirely.
            ...(autoStart ? { viewTransitionName: MASCOT_VIEW_TRANSITION_NAME } : {}),
          }}
        >
          <OkBlob
            size={PLAYER_SIZE}
            trackMouse={false}
            variant={asleep ? 'sleeping' : 'default'}
            celebrateSignal={celebrateSignal}
          />
        </div>

        {OBSTACLE_SLOTS.map((slot, i) => (
          <div
            key={slot}
            data-slot="ok-blob-runner-obstacle"
            ref={(node) => {
              obstacleRefs.current[i] = node;
            }}
            // The play area is a physical coordinate space, not chrome. x grows
            // rightward from the left edge and the player is pinned at a physical
            // `left`, so a logical origin would flip under RTL while the physics
            // kept measuring from the left: obstacles would travel away from the
            // blob instead of toward it.
            // biome-ignore lint/plugin/no-physical-direction-utility: physical origin is load-bearing here
            className="absolute bottom-0 left-0 rounded-sm bg-muted-foreground/70 will-change-transform"
            style={{ opacity: 0 }}
          />
        ))}
      </div>

      <p className="mt-2 text-center font-mono text-[11px] uppercase tracking-wide text-muted-foreground/60">
        {phase === 'over' ? (
          beatBest ? (
            <Trans>New best · press space to play again</Trans>
          ) : (
            <Trans>Game over · press space to play again</Trans>
          )
        ) : phase === 'running' ? (
          <Trans>Space to jump · down arrow to duck</Trans>
        ) : (
          <Trans>Press space or tap the blob to start</Trans>
        )}
      </p>
    </div>
  );
}
