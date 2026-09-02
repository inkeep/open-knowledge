export type ClickLevel = 0 | 1 | 2 | 3;
export type ActiveClickLevel = Exclude<ClickLevel, 0>;

export const RAGE_WINDOW_MS = 600;
export const IDLE_RESET_MS = 3100;
const MAX_LEVEL: ActiveClickLevel = 3;

export function nextClickLevel(
  previousLevel: ClickLevel,
  dtMs: number,
  opts?: { windowMs?: number; maxLevel?: ActiveClickLevel },
): ActiveClickLevel {
  const windowMs = opts?.windowMs ?? RAGE_WINDOW_MS;
  const maxLevel = opts?.maxLevel ?? MAX_LEVEL;
  if (previousLevel === 0 || dtMs >= windowMs) return 1;
  const incremented = previousLevel + 1;
  return (incremented > maxLevel ? maxLevel : incremented) as ActiveClickLevel;
}

export interface FireworkParticle {
  id: number;
  dx: number;
  dy: number;
  originDx: number;
  originDy: number;
  size: number;
  color: string;
  delay: number;
  duration: number;
}

interface FireworkLevelConfig {
  count: number;
  startRadius: number;
  baseDistance: number;
  distanceVariance: number;
  sizeMin: number;
  sizeMax: number;
  maxDelay: number;
  durationMin: number;
  durationMax: number;
}

export const FIREWORK_LEVEL_CONFIG: Record<ClickLevel, FireworkLevelConfig> = {
  0: {
    count: 0,
    startRadius: 0,
    baseDistance: 0,
    distanceVariance: 0,
    sizeMin: 0,
    sizeMax: 0,
    maxDelay: 0,
    durationMin: 0,
    durationMax: 0,
  },
  1: {
    count: 0,
    startRadius: 0,
    baseDistance: 0,
    distanceVariance: 0,
    sizeMin: 0,
    sizeMax: 0,
    maxDelay: 0,
    durationMin: 0,
    durationMax: 0,
  },
  2: {
    count: 0,
    startRadius: 0,
    baseDistance: 0,
    distanceVariance: 0,
    sizeMin: 0,
    sizeMax: 0,
    maxDelay: 0,
    durationMin: 0,
    durationMax: 0,
  },
  3: {
    count: 16,
    startRadius: 11,
    baseDistance: 7,
    distanceVariance: 3,
    sizeMin: 0.45,
    sizeMax: 1.2,
    maxDelay: 500,
    durationMin: 1100,
    durationMax: 2400,
  },
};

export const FIREWORK_COLORS: readonly string[] = [
  'var(--color-azure-blue)',
  'var(--color-sky-blue)',
  'var(--color-violet-300)',
  'var(--color-orange-light)',
  'var(--color-crystal-blue)',
  'var(--color-white-cream)',
];

export function generateFireworkParticles(
  level: ClickLevel,
  opts: { rng?: () => number; colors?: readonly string[] } = {},
): FireworkParticle[] {
  const rng = opts.rng ?? Math.random;
  const colors = opts.colors ?? FIREWORK_COLORS;
  const config = FIREWORK_LEVEL_CONFIG[level];
  if (config.count === 0 || colors.length === 0) return [];

  const particles: FireworkParticle[] = [];
  const slice = (Math.PI * 2) / config.count;
  for (let i = 0; i < config.count; i++) {
    const baseAngle = i * slice;
    const angleJitter = (rng() - 0.5) * slice * 0.7;
    const angle = baseAngle + angleJitter;
    const distance = config.baseDistance + (rng() - 0.5) * 2 * config.distanceVariance;
    const size = config.sizeMin + rng() * (config.sizeMax - config.sizeMin);
    const delay = rng() * config.maxDelay;
    const duration = config.durationMin + rng() * (config.durationMax - config.durationMin);
    const colorIndex = Math.floor(rng() * colors.length);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    particles.push({
      id: i,
      dx: cos * distance,
      dy: sin * distance,
      originDx: cos * config.startRadius,
      originDy: sin * config.startRadius,
      size,
      color: colors[colorIndex] ?? 'currentColor',
      delay,
      duration,
    });
  }
  return particles;
}
