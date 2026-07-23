import { describe, expect, test } from 'vitest';
import { clusterColor } from './graph-colors';

describe('clusterColor', () => {
  test('returns deterministic output for the same input', () => {
    const color1 = clusterColor('retrieval', true);
    const color2 = clusterColor('retrieval', true);
    expect(color1).toBe(color2);
  });

  test('different clusters produce different colors for at least 5 inputs', () => {
    const clusters = [
      'retrieval',
      'long-term-memory',
      'planning',
      'knowledge-graphs',
      'evaluation',
    ];
    const darkColors = clusters.map((c) => clusterColor(c, true));
    const uniqueDark = new Set(darkColors);
    expect(uniqueDark.size).toBeGreaterThanOrEqual(5);
  });

  test('dark mode returns valid hex colors', () => {
    const clusters = [
      'retrieval',
      'long-term-memory',
      'planning',
      'knowledge-graphs',
      'evaluation',
    ];
    for (const c of clusters) {
      expect(clusterColor(c, true)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test('light mode returns valid hex colors', () => {
    const clusters = [
      'retrieval',
      'long-term-memory',
      'planning',
      'knowledge-graphs',
      'evaluation',
    ];
    for (const c of clusters) {
      expect(clusterColor(c, false)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test('dark and light palettes produce different colors for the same cluster', () => {
    const dark = clusterColor('retrieval', true);
    const light = clusterColor('retrieval', false);
    expect(dark).not.toBe(light);
  });

  test('handles single-character and long cluster names', () => {
    expect(clusterColor('x', true)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(clusterColor('a-very-long-cluster-name-that-goes-on-and-on', false)).toMatch(
      /^#[0-9a-f]{6}$/i,
    );
  });
});
