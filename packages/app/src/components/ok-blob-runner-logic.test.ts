import { describe, expect, test } from 'vitest';
import { OBSTACLE_POOL_SIZE } from './OkBlobRunner';
import {
  collides,
  createRunnerState,
  DUCK_SCALE_Y,
  deformationOf,
  difficultyOf,
  GROUND_DWELL_SECONDS,
  gapSecondsAt,
  HOP_HEIGHT,
  isDucked,
  JUMP_AIRTIME_SECONDS,
  JUMP_BUFFER_SECONDS,
  JUMP_VELOCITY,
  jumpRunner,
  MAX_FRAME_SECONDS,
  MAX_JUMP_HEIGHT,
  MAX_SPEED,
  nextRageStreak,
  overheadChanceAt,
  playerBox,
  RAGE_STREAK_TO_REVEAL,
  RAGE_STREAK_WINDOW_MS,
  type RunnerObstacle,
  type RunnerState,
  readBestScore,
  START_SPEED,
  scoreOf,
  setDucking,
  startRunner,
  stepRunner,
  writeBestScore,
} from './ok-blob-runner-logic';

const VIEW_WIDTH = 600;
const midRng = () => 0.5;

function running(): RunnerState {
  const state = createRunnerState();
  startRunner(state);
  return state;
}

function run(state: RunnerState, seconds: number, rng: () => number = midRng): RunnerState {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) {
    stepRunner(state, 1 / 60, VIEW_WIDTH, rng);
  }
  return state;
}

function runClear(state: RunnerState, seconds: number, rng: () => number = midRng): RunnerState {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) {
    stepRunner(state, 1 / 60, VIEW_WIDTH, rng);
    state.obstacles = [];
  }
  return state;
}

function atPlayer(kind: 'ground' | 'overhead'): RunnerObstacle {
  return kind === 'ground'
    ? { id: 0, kind, x: 40, y: 0, width: 16, height: 38 }
    : { id: 0, kind, x: 40, y: 34, width: 26, height: 16 };
}

describe('idle gait', () => {
  test('the blob hops on its own, without any input', () => {
    const state = running();
    let apex = 0;
    let contacts = 0;
    let airborne = false;
    for (let i = 0; i < 240; i++) {
      stepRunner(state, 1 / 120, VIEW_WIDTH, midRng);
      state.obstacles = [];
      apex = Math.max(apex, state.y);
      if (state.y > 0) airborne = true;
      else if (airborne) {
        contacts += 1;
        airborne = false;
      }
    }
    expect(apex).toBeGreaterThan(0);
    expect(contacts).toBeGreaterThanOrEqual(3);
  });

  test('the hop stays under its advertised height', () => {
    const state = running();
    let apex = 0;
    for (let i = 0; i < 240; i++) {
      stepRunner(state, 1 / 120, VIEW_WIDTH, midRng);
      state.obstacles = [];
      apex = Math.max(apex, state.y);
    }
    expect(apex).toBeLessThanOrEqual(HOP_HEIGHT + 1);
  });
});

describe('difficulty contract', () => {
  test('the idle hop can NEVER clear a ground obstacle', () => {
    const state = running();
    state.y = HOP_HEIGHT;
    expect(collides(state, atPlayer('ground'))).toBe(true);
  });

  test('a full jump DOES clear a ground obstacle', () => {
    const state = running();
    state.y = MAX_JUMP_HEIGHT;
    expect(collides(state, atPlayer('ground'))).toBe(false);
  });

  test('ducking clears an overhead obstacle, standing does not', () => {
    const state = running();
    expect(collides(state, atPlayer('overhead'))).toBe(true);

    setDucking(state, true);
    expect(isDucked(state)).toBe(true);
    expect(collides(state, atPlayer('overhead'))).toBe(false);
  });

  test('ducking does NOT rescue you from a ground obstacle', () => {
    const state = running();
    setDucking(state, true);
    expect(collides(state, atPlayer('ground'))).toBe(true);
  });

  test('mid-hop still collides with an overhead obstacle', () => {
    const state = running();
    state.y = HOP_HEIGHT;
    expect(collides(state, atPlayer('overhead'))).toBe(true);
  });
});

describe('jump', () => {
  test('a grounded press launches immediately', () => {
    const state = running();
    state.y = 0;
    state.vy = 0;
    expect(jumpRunner(state)).toBe(true);
    expect(state.vy).toBe(JUMP_VELOCITY);
  });

  test('a press made mid-hop launches IMMEDIATELY, not on the next landing', () => {
    const state = running();
    run(state, 0.12);
    state.obstacles = [];
    expect(state.y).toBeGreaterThan(0);
    expect(state.jumping).toBe(false);

    expect(jumpRunner(state)).toBe(true);
    expect(state.vy).toBe(JUMP_VELOCITY);
    expect(state.jumpBuffer).toBe(0);
  });

  test('a press DURING a commanded jump is buffered, not a double jump', () => {
    const state = running();
    expect(jumpRunner(state)).toBe(true);
    runClear(state, 0.15);
    expect(state.jumping).toBe(true);
    expect(state.y).toBeGreaterThan(0);
    const airborneVy = state.vy;

    expect(jumpRunner(state)).toBe(false);
    expect(state.vy).toBe(airborneVy);
    expect(state.jumpBuffer).toBeGreaterThan(0);
  });

  test('landing clears the jumping flag so the next press is instant again', () => {
    const state = running();
    jumpRunner(state);
    runClear(state, JUMP_AIRTIME_SECONDS + 0.05);
    expect(state.jumping).toBe(false);
  });

  test('a press at ANY point during a full jump still jumps on landing', () => {
    for (const pressAt of [0.05, 0.15, 0.25, 0.35, 0.45]) {
      const state = running();
      jumpRunner(state);
      runClear(state, pressAt);
      expect(state.y).toBeGreaterThan(0);

      jumpRunner(state);
      let peak = 0;
      for (let i = 0; i < 300; i++) {
        stepRunner(state, 1 / 120, VIEW_WIDTH, midRng);
        state.obstacles = [];
        if (state.y === 0 && i > 60) break;
        peak = Math.max(peak, state.y);
      }
      expect(peak, `press at ${pressAt}s`).toBeGreaterThan(HOP_HEIGHT * 2);
    }
  });

  test('the buffer expires rather than firing a jump much later', () => {
    const state = running();
    run(state, 0.1);
    state.obstacles = [];
    jumpRunner(state);
    state.y = 400;
    state.vy = 0;
    run(state, JUMP_BUFFER_SECONDS + 0.1);
    expect(state.jumpBuffer).toBe(0);
  });

  test('jumping is inert unless the run is live', () => {
    const idle = createRunnerState();
    expect(jumpRunner(idle)).toBe(false);
    expect(idle.vy).toBe(0);
  });
});

describe('duck', () => {
  test('holding the duck pins the blob to the ground, suppressing the gait', () => {
    const state = running();
    run(state, 0.4);
    state.obstacles = [];
    setDucking(state, true);
    state.y = 0;
    state.vy = 0;
    runClear(state, 0.5);
    expect(state.y).toBe(0);
    expect(isDucked(state)).toBe(true);
  });

  test('releasing the duck resumes the gait', () => {
    const state = running();
    setDucking(state, true);
    runClear(state, 0.3);
    expect(state.y).toBe(0);

    setDucking(state, false);
    let apex = 0;
    for (let i = 0; i < 120; i++) {
      stepRunner(state, 1 / 120, VIEW_WIDTH, midRng);
      state.obstacles = [];
      apex = Math.max(apex, state.y);
    }
    expect(apex).toBeGreaterThan(0);
  });

  test('ducking in mid-air fast-falls instead of squashing', () => {
    const floating = running();
    const falling = running();
    for (const state of [floating, falling]) {
      state.y = 60;
      state.vy = 0;
      state.dwell = 0;
    }
    setDucking(falling, true);
    expect(isDucked(falling)).toBe(false);

    runClear(floating, 0.08);
    runClear(falling, 0.08);
    expect(falling.y).toBeLessThan(floating.y);
  });
});

describe('deformation', () => {
  test('ducked is a deliberate flatten', () => {
    const state = running();
    setDucking(state, true);
    const { scaleX, scaleY } = deformationOf(state);
    expect(scaleY).toBe(DUCK_SCALE_Y);
    expect(scaleX).toBeGreaterThan(1);
  });

  test('impact squashes hardest on contact and eases back out', () => {
    const state = running();
    state.y = 0;
    state.vy = 0;
    state.dwell = GROUND_DWELL_SECONDS;
    const onImpact = deformationOf(state);

    state.dwell = GROUND_DWELL_SECONDS * 0.1;
    const nearlyRecovered = deformationOf(state);

    expect(onImpact.scaleY).toBeLessThan(1);
    expect(onImpact.scaleY).toBeLessThan(nearlyRecovered.scaleY);
    expect(onImpact.scaleX).toBeGreaterThan(1);
  });

  test('airborne stretches with vertical speed and is round at the apex', () => {
    const state = running();
    state.y = 20;
    state.dwell = 0;

    state.vy = JUMP_VELOCITY;
    const takeoff = deformationOf(state);
    state.vy = 0;
    const apex = deformationOf(state);

    expect(takeoff.scaleY).toBeGreaterThan(1);
    expect(takeoff.scaleX).toBeLessThan(1);
    expect(apex.scaleY).toBeCloseTo(1, 6);
    expect(apex.scaleX).toBeCloseTo(1, 6);
  });

  test('stretch is bounded no matter how fast the blob is moving', () => {
    const state = running();
    state.y = 20;
    state.dwell = 0;
    state.vy = JUMP_VELOCITY * 50;
    const { scaleY } = deformationOf(state);
    expect(scaleY).toBeLessThanOrEqual(1.22);
  });
});

describe('collision box tracks the rendered shape', () => {
  test('ducking shrinks the box and widens it', () => {
    const state = running();
    const standing = playerBox(state);
    setDucking(state, true);
    const ducked = playerBox(state);

    expect(ducked.top).toBeLessThan(standing.top);
    expect(ducked.right - ducked.left).toBeGreaterThan(standing.right - standing.left);
  });

  test('the widened duck box spreads from the centre, not the left edge', () => {
    const state = running();
    const standingCentre = (playerBox(state).left + playerBox(state).right) / 2;
    setDucking(state, true);
    const duckedCentre = (playerBox(state).left + playerBox(state).right) / 2;
    expect(duckedCentre).toBeCloseTo(standingCentre, 6);
  });
});

describe('phase gating', () => {
  test('a fresh state is idle and does not advance', () => {
    const state = createRunnerState();
    expect(state.phase).toBe('idle');
    stepRunner(state, 1, VIEW_WIDTH, midRng);
    expect(state.distance).toBe(0);
    expect(state.obstacles).toHaveLength(0);
  });

  test('startRunner clears the previous run', () => {
    const state = running();
    runClear(state, 3);
    expect(state.distance).toBeGreaterThan(0);

    state.jumping = true;
    state.jumpBuffer = 1;
    state.ducking = true;

    startRunner(state);
    expect(state.phase).toBe('running');
    expect(state.jumping).toBe(false);
    expect(state.distance).toBe(0);
    expect(state.speed).toBe(START_SPEED);
    expect(state.obstacles).toHaveLength(0);
    expect(state.ducking).toBe(false);
    expect(state.jumpBuffer).toBe(0);
  });
});

describe('speed and score', () => {
  test('speed climbs from the start value and caps', () => {
    const state = running();
    runClear(state, 2);
    expect(state.speed).toBeGreaterThan(START_SPEED);
    expect(state.speed).toBeLessThan(MAX_SPEED);

    runClear(state, 120);
    expect(state.speed).toBe(MAX_SPEED);
  });

  test('score grows monotonically while running', () => {
    const state = running();
    let previous = scoreOf(state);
    for (let i = 0; i < 30; i++) {
      runClear(state, 0.2);
      const current = scoreOf(state);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
    expect(previous).toBeGreaterThan(0);
  });
});

describe('obstacle stream', () => {
  test('obstacles spawn off the right edge and scroll left', () => {
    const state = running();
    runClear(state, 0.5);
    stepRunner(state, 1 / 60, VIEW_WIDTH, midRng);
    run(state, 3);
    for (const obstacle of state.obstacles) {
      expect(obstacle.x).toBeLessThanOrEqual(VIEW_WIDTH);
      expect(obstacle.x + obstacle.width).toBeGreaterThan(0);
    }
  });

  test('overhead obstacles only appear after the warmup', () => {
    const state = running();
    const kinds: string[] = [];
    let seen = state.nextObstacleId;
    const alwaysOverhead = () => 0;
    for (let i = 0; i < 300; i++) {
      stepRunner(state, 1 / 60, 0, alwaysOverhead);
      if (state.nextObstacleId > seen) {
        seen = state.nextObstacleId;
        const spawned = state.obstacles.at(-1);
        if (spawned) kinds.push(spawned.kind);
      }
      state.obstacles = [];
      if (state.distance > 600) break;
    }
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((kind) => kind === 'ground')).toBe(true);
  });

  test('a degenerate view width still spawns clear of the player', () => {
    const state = running();
    const spawnXs: number[] = [];
    let seen = state.nextObstacleId;
    for (let i = 0; i < 600; i++) {
      stepRunner(state, 1 / 60, 0, midRng);
      if (state.nextObstacleId > seen) {
        seen = state.nextObstacleId;
        const spawned = state.obstacles.at(-1);
        if (spawned) spawnXs.push(spawned.x);
      }
      state.obstacles = [];
    }
    expect(spawnXs.length).toBeGreaterThan(0);
    for (const x of spawnXs) expect(x).toBeGreaterThan(playerBox(state).right);
  });

  test('the gap between obstacles stays jumpable at top speed', () => {
    const state = running();
    runClear(state, 120);
    expect(state.speed).toBe(MAX_SPEED);

    const spawnPositions: number[] = [];
    let seen = state.nextObstacleId;
    for (let i = 0; i < 4000 && spawnPositions.length < 12; i++) {
      stepRunner(state, 1 / 60, VIEW_WIDTH, () => 0);
      if (state.nextObstacleId > seen) {
        seen = state.nextObstacleId;
        spawnPositions.push(state.distance);
      }
      state.obstacles = [];
    }

    expect(spawnPositions.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < spawnPositions.length; i++) {
      const gapSeconds = (spawnPositions[i] - spawnPositions[i - 1]) / MAX_SPEED;
      expect(gapSeconds).toBeGreaterThan(JUMP_AIRTIME_SECONDS);
    }
  });
});

describe('frame-time guards', () => {
  test('a stalled frame cannot tunnel an obstacle through the player', () => {
    const stalled = running();
    const paced = running();
    stepRunner(stalled, 5, VIEW_WIDTH, midRng);
    stepRunner(paced, MAX_FRAME_SECONDS, VIEW_WIDTH, midRng);
    expect(stalled.distance).toBeCloseTo(paced.distance, 6);
  });

  test('negative or zero elapsed time is inert', () => {
    const state = running();
    stepRunner(state, -1, VIEW_WIDTH, midRng);
    stepRunner(state, 0, VIEW_WIDTH, midRng);
    expect(state.distance).toBe(0);
    expect(state.phase).toBe('running');
  });

  test('sub-stepping makes the result independent of frame pacing', () => {
    const coarse = running();
    const fine = running();
    for (let i = 0; i < 100; i++) {
      stepRunner(coarse, 1 / 30, VIEW_WIDTH, midRng);
      coarse.obstacles = [];
    }
    for (let i = 0; i < 200; i++) {
      stepRunner(fine, 1 / 60, VIEW_WIDTH, midRng);
      fine.obstacles = [];
    }
    expect(coarse.distance).toBeCloseTo(fine.distance, 0);
    expect(coarse.speed).toBeCloseTo(fine.speed, 6);
  });
});

describe('progressive difficulty', () => {
  test('difficulty climbs with distance and clamps at 1', () => {
    expect(difficultyOf(0)).toBe(0);
    expect(difficultyOf(5000)).toBeGreaterThan(0);
    expect(difficultyOf(5000)).toBeLessThan(1);
    expect(difficultyOf(5000)).toBeLessThan(difficultyOf(10_000));
    expect(difficultyOf(1e9)).toBe(1);
    expect(difficultyOf(-100)).toBe(0);
  });

  test('the gap closes as the run goes on', () => {
    expect(gapSecondsAt(10_000)).toBeLessThan(gapSecondsAt(0));
    expect(gapSecondsAt(1e9)).toBeLessThan(gapSecondsAt(10_000));
  });

  test('the gap NEVER closes past what a jump can clear', () => {
    for (const distance of [0, 1000, 7000, 14_000, 100_000, 1e9]) {
      expect(gapSecondsAt(distance), `at ${distance}px`).toBeGreaterThan(JUMP_AIRTIME_SECONDS);
    }
  });

  test('overhead hazards stay off during the warmup, then grow more common', () => {
    expect(overheadChanceAt(0)).toBe(0);
    expect(overheadChanceAt(500)).toBe(0);
    const early = overheadChanceAt(1000);
    const late = overheadChanceAt(1e9);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThan(1);
  });

  test('a long run really does spawn denser than its opening', () => {
    function gapsAround(startDistance: number): number {
      const state = running();
      state.distance = startDistance;
      const marks: number[] = [];
      let seen = state.nextObstacleId;
      for (let i = 0; i < 6000 && marks.length < 8; i++) {
        stepRunner(state, 1 / 60, VIEW_WIDTH, midRng);
        if (state.nextObstacleId > seen) {
          seen = state.nextObstacleId;
          marks.push(state.distance);
        }
        state.obstacles = [];
      }
      const deltas = marks.slice(1).map((m, i) => m - marks[i]);
      return deltas.reduce((a, b) => a + b, 0) / deltas.length;
    }
    const openingSeconds = gapsAround(0) / START_SPEED;
    const lateSeconds = gapsAround(60_000) / MAX_SPEED;
    expect(lateSeconds).toBeLessThan(openingSeconds);
  });
});

describe('persisted high score', () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      map,
    };
  }

  test('a written score round-trips', () => {
    const storage = fakeStorage();
    writeBestScore(412, storage);
    expect(readBestScore(storage)).toBe(412);
  });

  test('absent storage reads zero instead of throwing', () => {
    expect(readBestScore(null)).toBe(0);
    expect(() => writeBestScore(10, null)).not.toThrow();
  });

  test('garbage in storage reads as no score, never NaN', () => {
    for (const junk of ['', 'abc', '-5', 'NaN', 'Infinity', '{}']) {
      expect(readBestScore(fakeStorage({ 'ok-blob-runner-best': junk })), junk).toBe(0);
    }
  });

  test('a throwing storage is survivable in both directions', () => {
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readBestScore(hostile)).toBe(0);
    expect(() => writeBestScore(99, hostile)).not.toThrow();
  });

  test('non-scores are never persisted', () => {
    const storage = fakeStorage();
    writeBestScore(0, storage);
    writeBestScore(-1, storage);
    writeBestScore(Number.NaN, storage);
    expect(storage.map.size).toBe(0);
  });
});

describe('rage streak (reveal gate)', () => {
  test('the reveal threshold is the value the product ships', () => {
    expect(RAGE_STREAK_TO_REVEAL).toBe(6);
  });

  test('a first burst never reaches the reveal threshold', () => {
    expect(nextRageStreak(0, Number.POSITIVE_INFINITY)).toBe(1);
    expect(nextRageStreak(0, 0)).toBe(1);
    expect(nextRageStreak(0, 10)).toBeLessThan(RAGE_STREAK_TO_REVEAL);
  });

  test('rage clicks inside the window accumulate to the threshold', () => {
    let streak = 0;
    for (let i = 0; i < RAGE_STREAK_TO_REVEAL; i++) {
      streak = nextRageStreak(streak, RAGE_STREAK_WINDOW_MS - 1);
    }
    expect(streak).toBe(RAGE_STREAK_TO_REVEAL);
  });

  test('one click short of the threshold still hides the game', () => {
    expect(nextRageStreak(RAGE_STREAK_TO_REVEAL - 2, RAGE_STREAK_WINDOW_MS - 1)).toBe(
      RAGE_STREAK_TO_REVEAL - 1,
    );
  });

  test('a later burst after the window restarts the streak', () => {
    expect(nextRageStreak(1, RAGE_STREAK_WINDOW_MS)).toBe(1);
    expect(nextRageStreak(1, RAGE_STREAK_WINDOW_MS + 5_000)).toBe(1);
    expect(nextRageStreak(3, 60_000)).toBe(1);
  });

  test('the window is overridable for tests and tuning', () => {
    expect(nextRageStreak(1, 200, { windowMs: 100 })).toBe(1);
    expect(nextRageStreak(1, 50, { windowMs: 100 })).toBe(2);
  });
});

describe('pool bound', () => {
  test('concurrent obstacles never exceed the render pool, even ultrawide', () => {
    for (const width of [1200, 1600, 2400, 3400, 5000, 8000]) {
      const state = running();
      let peak = 0;
      for (let i = 0; i < 8000; i++) {
        stepRunner(state, 1 / 60, width, () => 0);
        peak = Math.max(peak, state.obstacles.length);
        state.phase = 'running';
      }
      expect({ width, fits: peak <= OBSTACLE_POOL_SIZE }).toEqual({ width, fits: true });
    }
  });
});

describe('mid-air duck', () => {
  test('ducking in mid-air does NOT shrink the hitbox', () => {
    const state = running();
    state.y = HOP_HEIGHT;
    setDucking(state, true);
    expect(isDucked(state)).toBe(false);
    expect(collides(state, atPlayer('overhead'))).toBe(true);
  });
});
