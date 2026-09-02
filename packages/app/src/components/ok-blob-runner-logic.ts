export const PLAYER_X = 28;
export const PLAYER_SIZE = 64;

export const PLAYER_FOOT_INSET = PLAYER_SIZE * 0.055;

const HITBOX_INSET_RATIO = 0.1875;

const GRAVITY = 2400;

const HOP_VELOCITY = 310;
export const JUMP_VELOCITY = 580;

export const HOP_HEIGHT = HOP_VELOCITY ** 2 / (2 * GRAVITY);
export const MAX_JUMP_HEIGHT = JUMP_VELOCITY ** 2 / (2 * GRAVITY);
export const JUMP_AIRTIME_SECONDS = (2 * JUMP_VELOCITY) / GRAVITY;

export const GROUND_DWELL_SECONDS = 0.09;

export const JUMP_BUFFER_SECONDS = JUMP_AIRTIME_SECONDS + 0.1;

export const DUCK_SCALE_Y = 0.5;
const DUCK_SCALE_X = 1.3;
const DUCK_FASTFALL_GRAVITY = 3200;

export const START_SPEED = 260;
export const MAX_SPEED = 620;
const SPEED_RAMP = 14;

const GAP_SECONDS_EARLY = JUMP_AIRTIME_SECONDS * 2.4;
const GAP_SECONDS_LATE = JUMP_AIRTIME_SECONDS * 1.35;
const GAP_JITTER_EARLY = 0.9;
const GAP_JITTER_LATE = 0.3;

const DIFFICULTY_RAMP_DISTANCE = 14000;

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

export function difficultyOf(distance: number): number {
  return Math.min(1, Math.max(0, distance / DIFFICULTY_RAMP_DISTANCE));
}

export function gapSecondsAt(distance: number): number {
  return lerp(GAP_SECONDS_EARLY, GAP_SECONDS_LATE, difficultyOf(distance));
}

export function overheadChanceAt(distance: number): number {
  if (distance <= OVERHEAD_WARMUP_DISTANCE) return 0;
  return lerp(OVERHEAD_CHANCE_EARLY, OVERHEAD_CHANCE_LATE, difficultyOf(distance));
}

const GROUND_MIN_HEIGHT = 38;
const GROUND_MAX_HEIGHT = 52;
const GROUND_MIN_WIDTH = 12;
const GROUND_MAX_WIDTH = 20;

const OVERHEAD_BOTTOM = 34;
const OVERHEAD_MIN_HEIGHT = 14;
const OVERHEAD_MAX_HEIGHT = 18;
const OVERHEAD_MIN_WIDTH = 22;
const OVERHEAD_MAX_WIDTH = 30;

const OVERHEAD_CHANCE_EARLY = 0.15;
const OVERHEAD_CHANCE_LATE = 0.45;
const OVERHEAD_WARMUP_DISTANCE = 900;

const MIN_VIEW_WIDTH = 240;

export const MAX_FRAME_SECONDS = 0.05;

const FIXED_STEP_SECONDS = 1 / 120;

const PX_PER_POINT = 12;

export type RunnerPhase = 'idle' | 'running' | 'over';
type ObstacleKind = 'ground' | 'overhead';

export interface RunnerObstacle {
  id: number;
  kind: ObstacleKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RunnerState {
  phase: RunnerPhase;
  y: number;
  vy: number;
  dwell: number;
  jumpBuffer: number;
  jumping: boolean;
  ducking: boolean;
  speed: number;
  distance: number;
  obstacles: RunnerObstacle[];
  spawnCountdown: number;
  nextObstacleId: number;
}

export function createRunnerState(): RunnerState {
  return {
    phase: 'idle',
    y: 0,
    vy: 0,
    dwell: 0,
    jumpBuffer: 0,
    jumping: false,
    ducking: false,
    speed: START_SPEED,
    distance: 0,
    obstacles: [],
    spawnCountdown: START_SPEED * gapSecondsAt(0),
    nextObstacleId: 0,
  };
}

export function startRunner(state: RunnerState): void {
  Object.assign(state, createRunnerState(), { phase: 'running' as const });
}

export function jumpRunner(state: RunnerState): boolean {
  if (state.phase !== 'running') return false;
  if (!state.jumping) {
    state.vy = JUMP_VELOCITY;
    state.dwell = 0;
    state.jumpBuffer = 0;
    state.jumping = true;
    return true;
  }
  state.jumpBuffer = JUMP_BUFFER_SECONDS;
  return false;
}

export function setDucking(state: RunnerState, ducking: boolean): void {
  if (state.phase !== 'running') return;
  state.ducking = ducking;
}

export function isDucked(state: RunnerState): boolean {
  return state.ducking && state.y === 0;
}

export function scoreOf(state: RunnerState): number {
  return Math.floor(state.distance / PX_PER_POINT);
}

export interface Deformation {
  scaleX: number;
  scaleY: number;
}

export function deformationOf(state: RunnerState): Deformation {
  if (isDucked(state)) return { scaleX: DUCK_SCALE_X, scaleY: DUCK_SCALE_Y };

  if (state.y === 0 && state.dwell > 0) {
    const progress = 1 - state.dwell / GROUND_DWELL_SECONDS;
    const squash = 0.28 * (1 - progress);
    return { scaleX: 1 + squash * 0.8, scaleY: 1 - squash };
  }

  const stretch = 0.22 * Math.min(Math.abs(state.vy) / JUMP_VELOCITY, 1);
  return { scaleX: 1 - stretch * 0.7, scaleY: 1 + stretch };
}

export interface Box {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export function playerBox(state: RunnerState): Box {
  const ducked = isDucked(state);
  const width = PLAYER_SIZE * (ducked ? DUCK_SCALE_X : 1);
  const height = PLAYER_SIZE * (ducked ? DUCK_SCALE_Y : 1);
  const insetX = width * HITBOX_INSET_RATIO;
  const insetY = height * HITBOX_INSET_RATIO;
  const left = PLAYER_X - (width - PLAYER_SIZE) / 2;
  return {
    left: left + insetX,
    right: left + width - insetX,
    bottom: state.y + insetY,
    top: state.y + height - insetY,
  };
}

export function collides(state: RunnerState, obstacle: RunnerObstacle): boolean {
  const box = playerBox(state);
  return (
    box.left < obstacle.x + obstacle.width &&
    box.right > obstacle.x &&
    box.bottom < obstacle.y + obstacle.height &&
    box.top > obstacle.y
  );
}

function spawnObstacle(state: RunnerState, viewWidth: number, rng: () => number): void {
  const overhead = rng() < overheadChanceAt(state.distance);

  const [minW, maxW, minH, maxH, y] = overhead
    ? [
        OVERHEAD_MIN_WIDTH,
        OVERHEAD_MAX_WIDTH,
        OVERHEAD_MIN_HEIGHT,
        OVERHEAD_MAX_HEIGHT,
        OVERHEAD_BOTTOM,
      ]
    : [GROUND_MIN_WIDTH, GROUND_MAX_WIDTH, GROUND_MIN_HEIGHT, GROUND_MAX_HEIGHT, 0];

  state.obstacles.push({
    id: state.nextObstacleId,
    kind: overhead ? 'overhead' : 'ground',
    x: viewWidth,
    y,
    width: minW + rng() * (maxW - minW),
    height: minH + rng() * (maxH - minH),
  });
  state.nextObstacleId += 1;
  const jitter = lerp(GAP_JITTER_EARLY, GAP_JITTER_LATE, difficultyOf(state.distance));
  state.spawnCountdown = state.speed * (gapSecondsAt(state.distance) + rng() * jitter);
}

function advance(state: RunnerState, dt: number, viewWidth: number, rng: () => number): void {
  state.jumpBuffer = Math.max(0, state.jumpBuffer - dt);

  if (state.y > 0 || state.vy > 0) {
    const gravity = state.ducking ? GRAVITY + DUCK_FASTFALL_GRAVITY : GRAVITY;
    state.vy -= gravity * dt;
    state.y += state.vy * dt;
    if (state.y <= 0) {
      state.y = 0;
      state.vy = 0;
      state.jumping = false;
      if (state.jumpBuffer > 0) {
        state.vy = JUMP_VELOCITY;
        state.jumpBuffer = 0;
        state.jumping = true;
      } else {
        state.dwell = GROUND_DWELL_SECONDS;
      }
    }
  } else if (state.ducking) {
    state.dwell = 0;
  } else {
    state.dwell -= dt;
    if (state.dwell <= 0) {
      state.dwell = 0;
      state.vy = HOP_VELOCITY;
    }
  }

  state.speed = Math.min(MAX_SPEED, state.speed + SPEED_RAMP * dt);
  const travelled = state.speed * dt;
  state.distance += travelled;

  for (const obstacle of state.obstacles) {
    obstacle.x -= travelled;
  }
  state.obstacles = state.obstacles.filter((obstacle) => obstacle.x + obstacle.width > 0);

  state.spawnCountdown -= travelled;
  if (state.spawnCountdown <= 0) spawnObstacle(state, viewWidth, rng);

  for (const obstacle of state.obstacles) {
    if (collides(state, obstacle)) {
      state.phase = 'over';
      return;
    }
  }
}

export function stepRunner(
  state: RunnerState,
  elapsedSeconds: number,
  viewWidth: number,
  rng: () => number = Math.random,
): RunnerState {
  if (state.phase !== 'running') return state;
  const width = Math.max(viewWidth, MIN_VIEW_WIDTH);
  let remaining = Math.min(Math.max(elapsedSeconds, 0), MAX_FRAME_SECONDS);
  while (remaining > 0) {
    const dt = Math.min(remaining, FIXED_STEP_SECONDS);
    remaining -= dt;
    advance(state, dt, width, rng);
    if (state.phase !== 'running') break;
  }
  return state;
}

const BEST_SCORE_STORAGE_KEY = 'ok-blob-runner-best';

export interface BestScoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultBestScoreStorage(): BestScoreStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readBestScore(storage = defaultBestScoreStorage()): number {
  if (!storage) return 0;
  try {
    const parsed = Number(storage.getItem(BEST_SCORE_STORAGE_KEY));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  } catch {
    return 0;
  }
}

export function writeBestScore(score: number, storage = defaultBestScoreStorage()): void {
  if (!storage || !Number.isFinite(score) || score <= 0) return;
  try {
    storage.setItem(BEST_SCORE_STORAGE_KEY, String(Math.floor(score)));
  } catch {}
}

export const RAGE_STREAK_WINDOW_MS = 4000;

export const RAGE_STREAK_TO_REVEAL = 6;

export function nextRageStreak(
  previousStreak: number,
  dtMs: number,
  opts?: { windowMs?: number },
): number {
  const windowMs = opts?.windowMs ?? RAGE_STREAK_WINDOW_MS;
  if (previousStreak <= 0 || dtMs >= windowMs) return 1;
  return previousStreak + 1;
}
