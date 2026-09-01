import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getParseHealth,
  incrementBlockFallback,
  incrementJsxAutoConvertFailed,
  incrementJsxRenderFailure,
  incrementWholeDocFallback,
  incrementYpsMismatchBlock,
  incrementYpsMismatchInline,
  resetParseHealth,
} from './parse-health.ts';

describe('parse-health metrics', () => {
  beforeEach(() => resetParseHealth());
  afterEach(() => resetParseHealth());

  test('initial state is all zeros', () => {
    const h = getParseHealth();
    expect(h.parseFallback.blockLevel).toBe(0);
    expect(h.parseFallback.wholeDoc).toBe(0);
    expect(h.parseFallback.wholeDocBudget).toBe(0);
    expect(h.ypsMismatch.block).toBe(0);
    expect(h.ypsMismatch.inline).toBe(0);
    expect(h.jsxRenderFailure).toEqual({});
    expect(h.jsxAutoConvertFailed).toEqual({});
  });

  test('incrementBlockFallback increments blockLevel', () => {
    incrementBlockFallback();
    incrementBlockFallback();
    expect(getParseHealth().parseFallback.blockLevel).toBe(2);
  });

  test('incrementWholeDocFallback increments wholeDoc', () => {
    incrementWholeDocFallback();
    expect(getParseHealth().parseFallback.wholeDoc).toBe(1);
  });

  test('incrementYpsMismatchBlock increments ypsMismatch.block', () => {
    incrementYpsMismatchBlock();
    incrementYpsMismatchBlock();
    incrementYpsMismatchBlock();
    expect(getParseHealth().ypsMismatch.block).toBe(3);
  });

  test('incrementYpsMismatchInline increments ypsMismatch.inline', () => {
    incrementYpsMismatchInline();
    expect(getParseHealth().ypsMismatch.inline).toBe(1);
  });

  test('getParseHealth returns a defensive copy', () => {
    incrementBlockFallback();
    const snap1 = getParseHealth();
    incrementBlockFallback();
    const snap2 = getParseHealth();
    expect(snap1.parseFallback.blockLevel).toBe(1);
    expect(snap2.parseFallback.blockLevel).toBe(2);
  });

  test('resetParseHealth resets all counters', () => {
    incrementBlockFallback();
    incrementWholeDocFallback();
    incrementYpsMismatchBlock();
    incrementYpsMismatchInline();
    incrementJsxRenderFailure('Callout');
    incrementJsxAutoConvertFailed('wildcard');
    resetParseHealth();
    const h = getParseHealth();
    expect(h.parseFallback.blockLevel).toBe(0);
    expect(h.parseFallback.wholeDoc).toBe(0);
    expect(h.parseFallback.wholeDocBudget).toBe(0);
    expect(h.ypsMismatch.block).toBe(0);
    expect(h.ypsMismatch.inline).toBe(0);
    expect(h.jsxRenderFailure).toEqual({});
    expect(h.jsxAutoConvertFailed).toEqual({});
  });

  test('incrementJsxRenderFailure keys by clamped descriptor name', () => {
    incrementJsxRenderFailure('Callout');
    incrementJsxRenderFailure('Callout');
    incrementJsxRenderFailure('img');
    incrementJsxRenderFailure('wildcard');
    const h = getParseHealth();
    expect(h.jsxRenderFailure).toEqual({ Callout: 2, img: 1, wildcard: 1 });
  });

  test('incrementJsxAutoConvertFailed keys by clamped descriptor name', () => {
    incrementJsxAutoConvertFailed('wildcard');
    incrementJsxAutoConvertFailed('wildcard');
    incrementJsxAutoConvertFailed('video');
    const h = getParseHealth();
    expect(h.jsxAutoConvertFailed).toEqual({ wildcard: 2, video: 1 });
  });

  test('getParseHealth returns defensive copies of jsx counter objects', () => {
    incrementJsxRenderFailure('Callout');
    const snap1 = getParseHealth();
    incrementJsxRenderFailure('Callout');
    const snap2 = getParseHealth();
    expect(snap1.jsxRenderFailure.Callout).toBe(1);
    expect(snap2.jsxRenderFailure.Callout).toBe(2);
  });

  test('ypsMismatch counters are bridged via globalThis (CJS patch ↔ ESM)', () => {
    type GlobalWithCounters = typeof globalThis & {
      __okYpsCounters?: { block: number; inline: number };
    };
    const g = globalThis as GlobalWithCounters;
    g.__okYpsCounters ||= { block: 0, inline: 0 };
    g.__okYpsCounters.block += 5;
    g.__okYpsCounters.inline += 2;

    const h = getParseHealth();
    expect(h.ypsMismatch.block).toBe(5);
    expect(h.ypsMismatch.inline).toBe(2);
  });
});
