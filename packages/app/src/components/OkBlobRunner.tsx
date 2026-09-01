import { Trans } from '@lingui/react/macro';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { OkBlob } from '@/components/OkBlob';
import { Kbd } from '@/components/ui/kbd';
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

const TRACK_HEIGHT = Math.ceil(MAX_JUMP_HEIGHT + PLAYER_SIZE + 8);

export const OBSTACLE_POOL_SIZE = 24;

const OBSTACLE_SLOTS = Array.from({ length: OBSTACLE_POOL_SIZE }, (_, i) => `obstacle-slot-${i}`);

const REVEAL_WAKE_DELAY_MS = 300;

const SCORE_DIGITS = 4;

const DUCK_BAND_FRACTION = 0.45;

interface OkBlobRunnerProps {
  autoStart?: boolean;
}

function HintKey({ children }: { children: ReactNode }) {
  return <Kbd className="h-4 min-w-4 px-1.5 align-middle text-[10px]">{children}</Kbd>;
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
  const bestRef = useRef(best);
  const [celebrateSignal, setCelebrateSignal] = useState(0);
  const [beatBest, setBeatBest] = useState(false);

  const [reduceMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (!autoStart || reduceMotion) return;
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
    if (reduceMotion) return;

    function start() {
      startRunner(stateRef.current);
      setBeatBest(false);
      setPhase('running');
    }

    function onKeyDown(event: KeyboardEvent) {
      const state = stateRef.current;
      if (event.key === 'ArrowDown') {
        if (!gameMayHandleKey({ allowWhileFocused: true })) return;
        event.preventDefault();
        setDucking(state, true);
        return;
      }
      if (event.key !== ' ' && event.key !== 'ArrowUp') return;
      if (!gameMayHandleKey({ allowWhileFocused: event.key === 'ArrowUp' })) return;
      event.preventDefault();
      if (state.phase === 'running') jumpRunner(state);
      else start();
    }

    function onKeyUp(event: KeyboardEvent) {
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
        <div
          ref={playerRef}
          className="absolute bottom-0 flex origin-bottom will-change-transform"
          style={{
            left: PLAYER_X,
            transform: `translateY(${PLAYER_FOOT_INSET}px)`,
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
            // biome-ignore lint/plugin/no-physical-direction-utility: physical origin is load-bearing here
            className="absolute bottom-0 left-0 rounded-sm bg-muted-foreground/70 will-change-transform"
            style={{ opacity: 0 }}
          />
        ))}
      </div>

      {}
      <div className="relative mt-1.5 h-5">
        <div
          data-slot="ok-blob-runner-score"
          className="absolute top-0 flex gap-3 font-mono text-xs tabular-nums text-muted-foreground/60"
          style={{ left: PLAYER_X }}
        >
          {best > 0 ? (
            <span className={beatBest ? 'text-muted-foreground' : undefined}>
              <Trans>HI</Trans> {String(best).padStart(SCORE_DIGITS, '0')}
            </span>
          ) : null}
          <span ref={scoreRef}>{String(score).padStart(SCORE_DIGITS, '0')}</span>
        </div>
      </div>

      <p
        data-slot="ok-blob-runner-hint"
        className="mt-2 text-center font-mono text-[11px] uppercase tracking-wide text-muted-foreground/60"
      >
        {phase === 'over' ? (
          beatBest ? (
            <Trans>
              New best · press <HintKey>Space</HintKey> to play again
            </Trans>
          ) : (
            <Trans>
              Game over · press <HintKey>Space</HintKey> to play again
            </Trans>
          )
        ) : phase === 'running' ? (
          <Trans>
            <HintKey>Space</HintKey> to jump · <HintKey>↓</HintKey> to duck
          </Trans>
        ) : (
          <Trans>
            Press <HintKey>Space</HintKey> or tap the blob to start
          </Trans>
        )}
      </p>
    </div>
  );
}
