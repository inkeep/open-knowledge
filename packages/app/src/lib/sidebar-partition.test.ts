import { describe, expect, test } from 'vitest';
import {
  LEFT_COLLAPSE_THRESHOLD,
  RIGHT_COLLAPSE_THRESHOLD,
  resolvePartition,
  type SidebarSide,
  smartDefault,
} from './sidebar-partition.ts';

describe('threshold constants', () => {
  test('left collapses at 1024 (Tailwind lg, the "both-comfortable" floor)', () => {
    expect(LEFT_COLLAPSE_THRESHOLD).toBe(1024);
  });

  test('right collapses at 1280 (staggered — right collapses first)', () => {
    expect(RIGHT_COLLAPSE_THRESHOLD).toBe(1280);
  });

  test('right threshold is higher than left (right collapses first)', () => {
    expect(RIGHT_COLLAPSE_THRESHOLD).toBeGreaterThan(LEFT_COLLAPSE_THRESHOLD);
  });
});

describe('resolvePartition', () => {
  const sides: SidebarSide[] = ['left', 'right'];

  for (const side of sides) {
    describe(`${side} sidebar`, () => {
      const threshold = side === 'left' ? LEFT_COLLAPSE_THRESHOLD : RIGHT_COLLAPSE_THRESHOLD;

      test('embedded host returns embedded regardless of width', () => {
        expect(resolvePartition('cursor', 2000, side)).toBe('embedded');
        expect(resolvePartition('codex', 500, side)).toBe('embedded');
        expect(resolvePartition('claude-desktop', 1024, side)).toBe('embedded');
      });

      test(`non-embedded at this side's threshold (${threshold}) returns above`, () => {
        expect(resolvePartition(null, threshold, side)).toBe('above');
      });

      test("non-embedded above this side's threshold returns above", () => {
        expect(resolvePartition(null, threshold + 1, side)).toBe('above');
      });

      test("non-embedded below this side's threshold returns below", () => {
        expect(resolvePartition(null, threshold - 1, side)).toBe('below');
      });

      test('non-embedded at zero returns below', () => {
        expect(resolvePartition(null, 0, side)).toBe('below');
      });
    });
  }

  describe('staggered region (1024 ≤ viewport < 1280)', () => {
    test('left at 1024 is above, right at 1024 is below (right collapses first)', () => {
      expect(resolvePartition(null, 1024, 'left')).toBe('above');
      expect(resolvePartition(null, 1024, 'right')).toBe('below');
    });

    test('left at 1100 is above, right at 1100 is below', () => {
      expect(resolvePartition(null, 1100, 'left')).toBe('above');
      expect(resolvePartition(null, 1100, 'right')).toBe('below');
    });

    test('both above at 1280', () => {
      expect(resolvePartition(null, 1280, 'left')).toBe('above');
      expect(resolvePartition(null, 1280, 'right')).toBe('above');
    });

    test('both below at 1023', () => {
      expect(resolvePartition(null, 1023, 'left')).toBe('below');
      expect(resolvePartition(null, 1023, 'right')).toBe('below');
    });
  });
});

describe('smartDefault', () => {
  test('above partition defaults to open', () => {
    expect(smartDefault('above')).toBe('open');
  });

  test('below partition defaults to collapsed', () => {
    expect(smartDefault('below')).toBe('collapsed');
  });

  test('embedded partition defaults to collapsed', () => {
    expect(smartDefault('embedded')).toBe('collapsed');
  });
});
