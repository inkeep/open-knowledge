import { describe, expect, test } from 'vitest';
import { clusterColor } from './graph-colors';

const PALETTE = [
  '#111111',
  '#222222',
  '#333333',
  '#444444',
  '#555555',
  '#666666',
  '#777777',
  '#888888',
];

describe('clusterColor', () => {
  test('a cluster keeps its color', () => {
    expect(clusterColor('retrieval', PALETTE)).toBe(clusterColor('retrieval', PALETTE));
  });

  test('clusters take every color of the palette and nothing else', () => {
    const colors = new Set(
      Array.from({ length: 64 }, (_, index) => clusterColor(`cluster-${index}`, PALETTE)),
    );
    expect([...colors].sort()).toEqual([...PALETTE].sort());
  });

  test('a one-character or very long cluster name still takes a palette color', () => {
    for (const cluster of ['x', 'a-very-long-cluster-name-that-goes-on-and-on']) {
      expect(PALETTE).toContain(clusterColor(cluster, PALETTE));
    }
  });

  test('a cluster keeps its slot when the theme changes the palette', () => {
    const other = PALETTE.map((_, index) => `#a0a0${index}0`);
    for (const cluster of ['retrieval', 'planning', 'x', 'a-very-long-cluster-name']) {
      expect(other.indexOf(clusterColor(cluster, other))).toBe(
        PALETTE.indexOf(clusterColor(cluster, PALETTE)),
      );
    }
  });
});
