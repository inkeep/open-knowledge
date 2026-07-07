import { describe, expect, test } from 'bun:test';
import {
  FIREWORK_COLORS,
  FIREWORK_LEVEL_CONFIG,
  generateFireworkParticles,
  nextClickLevel,
  RAGE_WINDOW_MS,
} from './ok-blob-logic';

describe('nextClickLevel', () => {
  test('first click from idle returns 1 regardless of dt', () => {
    expect(nextClickLevel(0, 0)).toBe(1);
    expect(nextClickLevel(0, 10_000)).toBe(1);
    expect(nextClickLevel(0, Number.POSITIVE_INFINITY)).toBe(1);
  });

  test('click after window elapsed resets to 1', () => {
    expect(nextClickLevel(1, RAGE_WINDOW_MS)).toBe(1);
    expect(nextClickLevel(2, RAGE_WINDOW_MS + 50)).toBe(1);
    expect(nextClickLevel(3, 5_000)).toBe(1);
  });

  test('rapid click within window increments', () => {
    expect(nextClickLevel(1, 100)).toBe(2);
    expect(nextClickLevel(2, 100)).toBe(3);
  });

  test('caps at max level on sustained rage', () => {
    expect(nextClickLevel(3, 100)).toBe(3);
    expect(nextClickLevel(3, 0)).toBe(3);
  });

  test('respects custom window override', () => {
    expect(nextClickLevel(1, 200, { windowMs: 100 })).toBe(1);
    expect(nextClickLevel(1, 50, { windowMs: 100 })).toBe(2);
  });

  test('respects custom max-level override', () => {
    expect(nextClickLevel(2, 100, { maxLevel: 2 })).toBe(2);
  });
});

// Deterministic seeded PRNG (mulberry32) so firework tests don't rely on Math.random
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('generateFireworkParticles', () => {
  test('level 0 emits no particles', () => {
    expect(generateFireworkParticles(0, { rng: mulberry32(1) })).toEqual([]);
  });

  test('particle count matches config per level', () => {
    for (const level of [1, 2, 3] as const) {
      const particles = generateFireworkParticles(level, { rng: mulberry32(level) });
      expect(particles).toHaveLength(FIREWORK_LEVEL_CONFIG[level].count);
    }
  });

  test('firework is reserved for rage — levels 1 and 2 emit no particles', () => {
    expect(FIREWORK_LEVEL_CONFIG[1].count).toBe(0);
    expect(FIREWORK_LEVEL_CONFIG[2].count).toBe(0);
    expect(FIREWORK_LEVEL_CONFIG[3].count).toBeGreaterThan(0);
    expect(generateFireworkParticles(1, { rng: mulberry32(1) })).toEqual([]);
    expect(generateFireworkParticles(2, { rng: mulberry32(2) })).toEqual([]);
    expect(generateFireworkParticles(3, { rng: mulberry32(3) }).length).toBeGreaterThan(0);
  });

  test('each particle stays within configured distance and size bounds', () => {
    const level = 3;
    const cfg = FIREWORK_LEVEL_CONFIG[level];
    const particles = generateFireworkParticles(level, { rng: mulberry32(42) });
    const maxReach = cfg.baseDistance + cfg.distanceVariance;
    const minReach = cfg.baseDistance - cfg.distanceVariance;
    for (const p of particles) {
      const radius = Math.hypot(p.dx, p.dy);
      expect(radius).toBeGreaterThanOrEqual(minReach - 1e-6);
      expect(radius).toBeLessThanOrEqual(maxReach + 1e-6);
      expect(p.size).toBeGreaterThanOrEqual(cfg.sizeMin);
      expect(p.size).toBeLessThanOrEqual(cfg.sizeMax);
      expect(p.delay).toBeGreaterThanOrEqual(0);
      expect(p.delay).toBeLessThanOrEqual(cfg.maxDelay);
      expect(p.duration).toBeGreaterThanOrEqual(cfg.durationMin);
      expect(p.duration).toBeLessThanOrEqual(cfg.durationMax);
    }
  });

  test('particles spread around the full circle — not clustered in one quadrant', () => {
    // With 16 evenly-sliced angles, at least 4 distinct quadrants should be hit.
    const particles = generateFireworkParticles(3, { rng: mulberry32(7) });
    const quadrants = new Set<string>();
    for (const p of particles) {
      const qx = p.dx >= 0 ? 'R' : 'L';
      const qy = p.dy >= 0 ? 'B' : 'T';
      quadrants.add(qx + qy);
    }
    expect(quadrants.size).toBe(4);
  });

  test('particles use the provided color palette', () => {
    const palette = ['#ff0000', '#00ff00'];
    const particles = generateFireworkParticles(3, { rng: mulberry32(3), colors: palette });
    for (const p of particles) {
      expect(palette).toContain(p.color);
    }
  });

  test('palette actually mixes — rage burst pulls from multiple colors', () => {
    const particles = generateFireworkParticles(3, { rng: mulberry32(9) });
    const used = new Set(particles.map((p) => p.color));
    expect(used.size).toBeGreaterThanOrEqual(3);
    for (const color of used) {
      expect(FIREWORK_COLORS).toContain(color);
    }
  });

  test('empty palette falls back to zero particles rather than throwing', () => {
    expect(generateFireworkParticles(3, { rng: mulberry32(1), colors: [] })).toEqual([]);
  });

  test('same seed produces identical bursts (pure function)', () => {
    const a = generateFireworkParticles(3, { rng: mulberry32(123) });
    const b = generateFireworkParticles(3, { rng: mulberry32(123) });
    expect(a).toEqual(b);
  });
});
