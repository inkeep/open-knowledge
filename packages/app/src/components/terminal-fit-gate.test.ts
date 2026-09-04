import { describe, expect, test } from 'vitest';
import { isRenderedBox, isRenderedContainer, shouldFitForResize } from './terminal-fit-gate';

describe('isRenderedBox', () => {
  test('accepts a box with positive width and height', () => {
    expect(isRenderedBox({ width: 742, height: 380 })).toBe(true);
  });

  test('rejects a box that is not being rendered', () => {
    expect(isRenderedBox({ width: 0, height: 0 })).toBe(false);
    expect(isRenderedBox({ width: 742, height: 0 })).toBe(false);
    expect(isRenderedBox({ width: 0, height: 380 })).toBe(false);
  });

  test('rejects a missing or non-finite box', () => {
    expect(isRenderedBox(null)).toBe(false);
    expect(isRenderedBox(undefined)).toBe(false);
    expect(isRenderedBox({ width: Number.NaN, height: 380 })).toBe(false);
    expect(isRenderedBox({ width: 742, height: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('shouldFitForResize', () => {
  test('fits when an observed box is being rendered', () => {
    expect(shouldFitForResize([{ contentRect: { width: 742, height: 380 } }])).toBe(true);
  });

  test('does not fit when every observed box is unrendered', () => {
    expect(shouldFitForResize([{ contentRect: { width: 0, height: 0 } }])).toBe(false);
    expect(
      shouldFitForResize([
        { contentRect: { width: 0, height: 0 } },
        { contentRect: { width: 0, height: 380 } },
      ]),
    ).toBe(false);
  });

  test('fits when at least one observed box is being rendered', () => {
    expect(
      shouldFitForResize([
        { contentRect: { width: 0, height: 0 } },
        { contentRect: { width: 742, height: 380 } },
      ]),
    ).toBe(true);
  });

  test('does not fit when no observations were delivered at all', () => {
    expect(shouldFitForResize()).toBe(false);
    expect(shouldFitForResize(null)).toBe(false);
    expect(shouldFitForResize([])).toBe(false);
  });

  test('does not fit when an observation carries no measurement', () => {
    expect(shouldFitForResize([{}])).toBe(false);
    expect(shouldFitForResize([{ contentRect: null }])).toBe(false);
  });
});

describe('isRenderedContainer', () => {
  const rendered = { width: 742, height: 380 };

  test('fits when both the border box and the content box are rendered', () => {
    expect(isRenderedContainer(rendered, { width: '730px', height: '380px' })).toBe(true);
  });

  test('does not fit when the content box has no usable width', () => {
    expect(isRenderedContainer({ width: 12, height: 380 }, { width: '0px', height: '380px' })).toBe(
      false,
    );
  });

  test('does not fit when the element is not rendered, despite a percentage content box', () => {
    expect(isRenderedContainer({ width: 0, height: 0 }, { width: '100%', height: '100%' })).toBe(
      false,
    );
  });

  test('does not fit when the content box is unresolvable', () => {
    expect(isRenderedContainer(rendered, { width: '', height: '' })).toBe(false);
    expect(isRenderedContainer(rendered, { width: 'auto', height: 'auto' })).toBe(false);
    expect(isRenderedContainer(rendered, null)).toBe(false);
  });
});
