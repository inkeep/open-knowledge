/**
 * Pure logic for the OkBlob runner mini-game — the offline-dino easter egg
 * that takes over the mascot slot on a server-unreachable error screen.
 *
 * No DOM and no React here: `OkBlobRunner` drives `stepRunner` from a rAF loop
 * and writes the resulting positions and deformations straight to element
 * styles, so this module stays testable against a fake clock.
 *
 * The blob is not a ball on a track. Its default state is a continuous hop —
 * it boings along the ground on its own, squashing on contact and stretching
 * through the air — and the player only intervenes to clear something. Squash
 * and stretch are derived from the live physics (`deformationOf`) rather than
 * from CSS keyframes, so the animation and the collision box can never
 * disagree about the shape the blob is currently in.
 *
 * Coordinate box: x grows rightward from the play area's left edge, y grows
 * UPWARD from the ground line. Units are CSS pixels; time is seconds.
 */

/** Player's fixed horizontal position, px from the play area's left edge. */
export const PLAYER_X = 28;
/** Rendered blob size at rest, px. */
export const PLAYER_SIZE = 64;

/**
 * The blob path's lowest point sits a little above the floor of its own 30-unit
 * viewBox, so aligning the SVG box to the ground line leaves the silhouette
 * visibly hovering. Nudge the rendered player down by this much to plant it.
 * Measured against the real path, not guessed.
 */
export const PLAYER_FOOT_INSET = PLAYER_SIZE * 0.055;

/**
 * The silhouette is round, so a full-square hitbox reads as unfair — empty
 * corners collide on a pass the player sees as clean. Expressed as a fraction
 * of the CURRENT size so a ducked blob gets a proportionally smaller box
 * instead of a stale one sized for standing.
 */
const HITBOX_INSET_RATIO = 0.1875;

/** Downward acceleration, px/s². */
const GRAVITY = 2400;

/** Push-off velocity for the idle gait — the hop the blob does unprompted. */
const HOP_VELOCITY = 310;
/** Push-off velocity for a player-commanded jump. */
export const JUMP_VELOCITY = 580;

/** Apex of an idle hop, px. */
export const HOP_HEIGHT = HOP_VELOCITY ** 2 / (2 * GRAVITY);
/** Apex of a full jump, px. Sets how tall the play area has to be. */
export const MAX_JUMP_HEIGHT = JUMP_VELOCITY ** 2 / (2 * GRAVITY);
/** Ground-to-ground airtime of a full jump, seconds. Sets the spawn gap floor. */
export const JUMP_AIRTIME_SECONDS = (2 * JUMP_VELOCITY) / GRAVITY;

/**
 * Beat the blob spends compressed against the ground between hops. Decoupling
 * the gait's rhythm from its height is what lets the hop stay low enough that
 * it never clears an obstacle for free while still reading as an unhurried
 * bounce rather than a vibration. It is also exactly when the squash happens.
 */
export const GROUND_DWELL_SECONDS = 0.09;

/**
 * A jump pressed mid-air is remembered and spent on the next landing. Without
 * it the control feels broken: the gait is airborne roughly three quarters of
 * every cycle, so most honest presses would land on a frame that cannot jump.
 *
 * MUST exceed the longest airtime the blob can be in (a full jump), or the
 * buffer expires before touchdown and the press is silently eaten. A second
 * press during a jump is the single most common input in the game, so a buffer
 * shorter than the jump reads directly as input lag.
 */
export const JUMP_BUFFER_SECONDS = JUMP_AIRTIME_SECONDS + 0.1;

/** Vertical squash while ducking. Also scales the collision box. */
export const DUCK_SCALE_Y = 0.5;
/** Horizontal spread while ducking — the volume has to go somewhere. */
const DUCK_SCALE_X = 1.3;
/** Extra downward acceleration while ducking in mid-air, px/s². */
const DUCK_FASTFALL_GRAVITY = 3200;

export const START_SPEED = 260;
export const MAX_SPEED = 620;
/** Speed gained per second survived, px/s². */
const SPEED_RAMP = 14;

/**
 * Obstacle spacing is expressed in SECONDS of travel, not pixels, so the gap
 * scales with speed. A fixed pixel gap becomes uncleatable once the ramp
 * outruns the jump's airtime.
 *
 * Speed alone does not make a runner harder for long: if the gap stays constant
 * in seconds the player faces the same rhythm forever and only the scenery
 * moves faster. Difficulty therefore also closes the gap and mixes in more
 * overhead hazards as distance grows.
 */
const GAP_SECONDS_EARLY = JUMP_AIRTIME_SECONDS * 2.4;
/**
 * The late-game floor. MUST stay above JUMP_AIRTIME_SECONDS, or consecutive
 * obstacles arrive while the blob is still committed to clearing the last one,
 * which is unwinnable rather than hard.
 */
const GAP_SECONDS_LATE = JUMP_AIRTIME_SECONDS * 1.35;
const GAP_JITTER_EARLY = 0.9;
const GAP_JITTER_LATE = 0.3;

/** Distance, px, over which difficulty climbs from 0 to its ceiling. */
const DIFFICULTY_RAMP_DISTANCE = 14000;

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/**
 * How far into the difficulty ramp this run is, 0 to 1. Pure and exported so
 * the pacing can be asserted directly rather than inferred from play.
 */
export function difficultyOf(distance: number): number {
  return Math.min(1, Math.max(0, distance / DIFFICULTY_RAMP_DISTANCE));
}

/** Minimum spacing, in seconds of travel, at the given distance. */
export function gapSecondsAt(distance: number): number {
  return lerp(GAP_SECONDS_EARLY, GAP_SECONDS_LATE, difficultyOf(distance));
}

/** Share of spawns that hang overhead at the given distance. */
export function overheadChanceAt(distance: number): number {
  if (distance <= OVERHEAD_WARMUP_DISTANCE) return 0;
  return lerp(OVERHEAD_CHANCE_EARLY, OVERHEAD_CHANCE_LATE, difficultyOf(distance));
}

/**
 * Ground obstacles are tall enough that the idle hop cannot clear them (hop
 * apex plus the standing hitbox inset), and short enough that a full jump
 * comfortably can. Those two bounds are the whole difficulty contract.
 */
const GROUND_MIN_HEIGHT = 38;
const GROUND_MAX_HEIGHT = 52;
const GROUND_MIN_WIDTH = 12;
const GROUND_MAX_WIDTH = 20;

/**
 * Overhead obstacles hang at a height a ducked blob slips under and a hopping
 * one does not. Jumping clean over them is allowed — same as the bird in the
 * game this is riffing on.
 */
const OVERHEAD_BOTTOM = 34;
const OVERHEAD_MIN_HEIGHT = 14;
const OVERHEAD_MAX_HEIGHT = 18;
const OVERHEAD_MIN_WIDTH = 22;
const OVERHEAD_MAX_WIDTH = 30;

/** Overhead share at the start of the ramp and at its ceiling. Climbing this
    makes late runs demand ducking, not just better jump timing. */
const OVERHEAD_CHANCE_EARLY = 0.15;
const OVERHEAD_CHANCE_LATE = 0.45;
/** Distance, px, before overhead obstacles start appearing at all. */
const OVERHEAD_WARMUP_DISTANCE = 900;

/**
 * Spawns are placed at the right edge of the play area, so a zero or absurdly
 * narrow measurement (pre-layout, collapsed flex parent) would drop obstacles
 * on top of the player. Clamping the width keeps the spawn off-screen instead.
 */
const MIN_VIEW_WIDTH = 240;

/**
 * Real elapsed time is clamped before it drives physics. A backgrounded tab or
 * a stalled main thread hands back a multi-second dt, which would teleport the
 * player past an obstacle on the first frame after the stall.
 */
export const MAX_FRAME_SECONDS = 0.05;

/**
 * Physics runs on fixed sub-steps regardless of frame pacing. At MAX_SPEED a
 * single MAX_FRAME_SECONDS step sweeps an obstacle ~31px, wider than the inset
 * player box — so one slow frame could tunnel an obstacle clean through the
 * blob without ever registering an overlap.
 */
const FIXED_STEP_SECONDS = 1 / 120;

/** Distance in px that scores one point. */
const PX_PER_POINT = 12;

export type RunnerPhase = 'idle' | 'running' | 'over';
type ObstacleKind = 'ground' | 'overhead';

export interface RunnerObstacle {
  id: number;
  kind: ObstacleKind;
  /** Left edge, px from the play area's left edge. */
  x: number;
  /** Bottom edge, px above the ground line. */
  y: number;
  width: number;
  height: number;
}

export interface RunnerState {
  phase: RunnerPhase;
  /** Player's height above the ground line, px. 0 = in contact. */
  y: number;
  /** Player's vertical velocity, px/s. Positive = rising. */
  vy: number;
  /** Seconds left of the compressed beat on the ground. 0 when airborne. */
  dwell: number;
  /** Seconds left to honour a jump pressed during a commanded jump. */
  jumpBuffer: number;
  /**
   * Whether the blob is airborne because the PLAYER jumped, as opposed to the
   * idle gait. Only a commanded jump blocks another one; being mid-hop does
   * not, or the control feels laggy for the ~74% of the cycle the gait spends
   * off the ground.
   */
  jumping: boolean;
  /** Whether the duck input is currently held. */
  ducking: boolean;
  /** Current scroll speed, px/s. */
  speed: number;
  /** Total distance travelled, px. Score derives from this. */
  distance: number;
  obstacles: RunnerObstacle[];
  /** Distance remaining, px, until the next obstacle spawns. */
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
    // The first obstacle gets a full gap of breathing room so a run never opens
    // with an unreactable jump.
    spawnCountdown: START_SPEED * gapSecondsAt(0),
    nextObstacleId: 0,
  };
}

/**
 * Reset to a fresh run in place. Mutates rather than returning a new object
 * because the component holds one long-lived state ref across runs.
 */
export function startRunner(state: RunnerState): void {
  Object.assign(state, createRunnerState(), { phase: 'running' as const });
}

/**
 * Command a jump. Launches immediately when the blob is in ground contact,
 * otherwise arms the buffer so the press is spent on the next landing.
 * Returns whether it launched right away.
 */
export function jumpRunner(state: RunnerState): boolean {
  if (state.phase !== 'running') return false;
  // Grounded OR merely bouncing along: launch NOW. Gating on `y > 0` made the
  // gait swallow most presses into the buffer, so the blob visibly waited to
  // land before honouring a jump — the input lag players actually feel.
  if (!state.jumping) {
    state.vy = JUMP_VELOCITY;
    state.dwell = 0;
    state.jumpBuffer = 0;
    state.jumping = true;
    return true;
  }
  // Already committed to a jump. Remember it for the next landing.
  state.jumpBuffer = JUMP_BUFFER_SECONDS;
  return false;
}

/** Hold or release the duck. Holding also fast-falls an airborne blob. */
export function setDucking(state: RunnerState, ducking: boolean): void {
  if (state.phase !== 'running') return;
  state.ducking = ducking;
}

/** Is the blob squashed flat right now? Drives both the box and the render. */
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

/**
 * Squash and stretch, derived from the live physics rather than a keyframe.
 * Ducked reads as a deliberate flatten; ground contact compresses hardest at
 * the moment of impact and eases back out over the dwell; airborne stretches
 * in proportion to vertical speed, so the blob is longest at takeoff and
 * landing and round at the apex. Roughly volume-preserving, which is what
 * sells it as a blob instead of a scaling rectangle.
 */
export function deformationOf(state: RunnerState): Deformation {
  if (isDucked(state)) return { scaleX: DUCK_SCALE_X, scaleY: DUCK_SCALE_Y };

  if (state.y === 0 && state.dwell > 0) {
    // dwell counts DOWN, so progress 0 = just landed = maximum squash.
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

/**
 * The player's collision box for the shape it is in this frame. Ducking really
 * does shrink it — that is the whole point of ducking — so the box is derived
 * from the same duck state the renderer uses.
 */
export function playerBox(state: RunnerState): Box {
  const ducked = isDucked(state);
  const width = PLAYER_SIZE * (ducked ? DUCK_SCALE_X : 1);
  const height = PLAYER_SIZE * (ducked ? DUCK_SCALE_Y : 1);
  const insetX = width * HITBOX_INSET_RATIO;
  const insetY = height * HITBOX_INSET_RATIO;
  // Widening on the duck spreads from the blob's centre, not its left edge.
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
    // Airborne. Ducking here is a fast-fall rather than a squash.
    const gravity = state.ducking ? GRAVITY + DUCK_FASTFALL_GRAVITY : GRAVITY;
    state.vy -= gravity * dt;
    state.y += state.vy * dt;
    if (state.y <= 0) {
      state.y = 0;
      state.vy = 0;
      state.jumping = false;
      // A press made during the jump is spent the instant we touch down.
      if (state.jumpBuffer > 0) {
        state.vy = JUMP_VELOCITY;
        state.jumpBuffer = 0;
        state.jumping = true;
      } else {
        state.dwell = GROUND_DWELL_SECONDS;
      }
    }
  } else if (state.ducking) {
    // Held flat against the ground: no gait, no rebound.
    state.dwell = 0;
  } else {
    // In contact: compress, then push off into the next hop.
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

/**
 * Advance the run by `elapsedSeconds` of wall time. Mutates and returns the
 * same state object. A no-op unless the run is live, so the caller can drive it
 * unconditionally from its loop.
 */
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

/** The slice of `Storage` the high score needs; injectable so tests stay pure. */
export interface BestScoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * `localStorage`, or null when it is not usable.
 *
 * BOTH the reference and every call are guarded, because the two failure modes
 * are different: Node without `--localstorage-file` leaves the global
 * undefined (a bare mention throws ReferenceError), while Safari in private
 * mode has the object but throws on write.
 */
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
    // Persisted state is user-editable and can be anything; anything that is
    // not a positive finite number reads as "no score yet" rather than NaN.
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
  } catch {
    // Quota exhaustion or a private-mode denial. A lost high score is not
    // worth taking down the pane the user is looking at.
  }
}

/**
 * How long a second rage-click burst still counts as "in a row". Generous
 * enough that a deliberate second go registers, short enough that two
 * unrelated bursts minutes apart do not.
 */
export const RAGE_STREAK_WINDOW_MS = 4000;

/** Consecutive rage bursts required to reveal the game. */
export const RAGE_STREAK_TO_REVEAL = 2;

/**
 * Consecutive-rage counter. One burst is the firework and nothing else; the
 * reveal is deliberately gated behind doing it twice, so a user who stumbles
 * into the sparkle once keeps the sparkle and nothing surprising happens.
 *
 * Pure so the cadence can be asserted without a clock. Mirrors
 * `nextClickLevel`, which does the same job one level down.
 */
export function nextRageStreak(
  previousStreak: number,
  dtMs: number,
  opts?: { windowMs?: number },
): number {
  const windowMs = opts?.windowMs ?? RAGE_STREAK_WINDOW_MS;
  if (previousStreak <= 0 || dtMs >= windowMs) return 1;
  return previousStreak + 1;
}
