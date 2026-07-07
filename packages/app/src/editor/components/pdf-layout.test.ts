/**
 * Unit coverage for `computeBaseScale` — the pure layout-math helper that
 * picks the per-page render scale for each of the five PDF layout modes
 * (fit-width, fit-height, single, two-odd, two-even). Each branch is
 * exercised independently so a future tweak to one mode can't silently
 * regress the others; the toolbar's zoom multiplier composes on top of
 * these base scales.
 */

import { describe, expect, test } from 'bun:test';
import { computeBaseScale, type PdfPageInfo } from './pdf-layout.ts';

const A4: PdfPageInfo = { naturalWidth: 612, naturalHeight: 792 };

describe('computeBaseScale', () => {
  describe('fit-width', () => {
    test('scales width-only to fill (containerW - padX) for an A4 page', () => {
      // 720 - 24 = 696 → 696 / 612 ≈ 1.137
      expect(computeBaseScale('fit-width', A4, 720, 600)).toBeCloseTo(696 / 612, 5);
    });

    test('falls back to 1 when containerW is 0 (pre-ResizeObserver)', () => {
      expect(computeBaseScale('fit-width', A4, 0, 600)).toBe(1);
    });

    test('does not depend on containerH', () => {
      const a = computeBaseScale('fit-width', A4, 720, 600);
      const b = computeBaseScale('fit-width', A4, 720, 9999);
      expect(a).toBe(b);
    });

    test('floors at 0.1 for pathologically small widths', () => {
      // (30 - 24) / 612 = 0.0098… → floored to 0.1
      expect(computeBaseScale('fit-width', A4, 30, 600)).toBe(0.1);
    });
  });

  describe('fit-height', () => {
    test('scales height-only to fill (containerH - padY) for an A4 page', () => {
      // 1000 - 24 = 976 → 976 / 792 ≈ 1.232
      expect(computeBaseScale('fit-height', A4, 720, 1000)).toBeCloseTo(976 / 792, 5);
    });

    test('falls back to 1 when containerH is 0', () => {
      expect(computeBaseScale('fit-height', A4, 720, 0)).toBe(1);
    });

    test('does not depend on containerW', () => {
      const a = computeBaseScale('fit-height', A4, 720, 1000);
      const b = computeBaseScale('fit-height', A4, 9999, 1000);
      expect(a).toBe(b);
    });
  });

  describe('single', () => {
    test('always returns 1 (natural size) regardless of container', () => {
      expect(computeBaseScale('single', A4, 720, 600)).toBe(1);
      expect(computeBaseScale('single', A4, 0, 0)).toBe(1);
      expect(computeBaseScale('single', A4, 9999, 9999)).toBe(1);
    });
  });

  describe('two-odd', () => {
    test('halves the container width and subtracts the gutter for an A4 page', () => {
      // (720 - 24) / 2 - 12 = 348 - 12 = 336 → 336 / 612 ≈ 0.549
      expect(computeBaseScale('two-odd', A4, 720, 600)).toBeCloseTo(336 / 612, 5);
    });

    test('falls back to 1 when containerW is 0', () => {
      expect(computeBaseScale('two-odd', A4, 0, 600)).toBe(1);
    });

    test('produces the same scale as two-even (both are two-column layouts)', () => {
      expect(computeBaseScale('two-odd', A4, 720, 600)).toBe(
        computeBaseScale('two-even', A4, 720, 600),
      );
    });
  });

  describe('two-even', () => {
    test('halves the container width and subtracts the gutter for an A4 page', () => {
      expect(computeBaseScale('two-even', A4, 720, 600)).toBeCloseTo(336 / 612, 5);
    });

    test('falls back to 1 when containerW is 0', () => {
      expect(computeBaseScale('two-even', A4, 0, 600)).toBe(1);
    });
  });

  describe('cross-mode invariants', () => {
    test('fit-width >= two-odd for the same container — two-up gets half the budget', () => {
      const fit = computeBaseScale('fit-width', A4, 720, 600);
      const two = computeBaseScale('two-odd', A4, 720, 600);
      expect(fit).toBeGreaterThan(two);
    });

    test('different page sizes produce different scales in fit-* modes', () => {
      const small: PdfPageInfo = { naturalWidth: 300, naturalHeight: 400 };
      const large: PdfPageInfo = { naturalWidth: 1200, naturalHeight: 1600 };
      expect(computeBaseScale('fit-width', small, 720, 600)).toBeGreaterThan(
        computeBaseScale('fit-width', large, 720, 600),
      );
    });

    test('single mode is page-size-independent', () => {
      const small: PdfPageInfo = { naturalWidth: 300, naturalHeight: 400 };
      const large: PdfPageInfo = { naturalWidth: 1200, naturalHeight: 1600 };
      expect(computeBaseScale('single', small, 720, 600)).toBe(
        computeBaseScale('single', large, 720, 600),
      );
    });
  });
});
