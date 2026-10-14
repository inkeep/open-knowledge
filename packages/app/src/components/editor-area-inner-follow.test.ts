import { describe, expect, test } from 'vitest';
import { computeInnerFollowLayout, predictInnerPanelSpacePx } from './editor-area-inner-follow';

const OUTER_PX = 1400;

describe('predictInnerPanelSpacePx', () => {
  test('is the editor column’s share of the outer row minus the chrome between the rows', () => {
    expect(
      predictInnerPanelSpacePx({
        outerLayout: { editor: 50, chat: 50 },
        outerResidualId: 'editor',
        outerPanelSpacePx: OUTER_PX,
        innerChromePx: 1,
      }),
    ).toBe(699);
  });

  test('refuses an outer layout without the editor column or an empty row', () => {
    expect(
      predictInnerPanelSpacePx({
        outerLayout: { chat: 100 },
        outerResidualId: 'editor',
        outerPanelSpacePx: OUTER_PX,
        innerChromePx: 0,
      }),
    ).toBeNull();
    expect(
      predictInnerPanelSpacePx({
        outerLayout: { editor: 50, chat: 50 },
        outerResidualId: 'editor',
        outerPanelSpacePx: 0,
        innerChromePx: 0,
      }),
    ).toBeNull();
    expect(
      predictInnerPanelSpacePx({
        outerLayout: { editor: 0, chat: 100 },
        outerResidualId: 'editor',
        outerPanelSpacePx: OUTER_PX,
        innerChromePx: 0,
      }),
    ).toBeNull();
  });
});

describe('computeInnerFollowLayout', () => {
  const innerLayout = { doc: 320 / 7, workspace: 100 - 320 / 7 };

  test('keeps the side panel at its pixel pin against the editor column the outer move produces', () => {
    const next = computeInnerFollowLayout({
      outerLayout: { editor: (550 / OUTER_PX) * 100, chat: (850 / OUTER_PX) * 100 },
      outerResidualId: 'editor',
      outerPanelSpacePx: OUTER_PX,
      innerChromePx: 0,
      innerLayout,
      innerResidualId: 'workspace',
      pinnedPx: { doc: 320 },
    });
    expect((next.doc / 100) * 550).toBeCloseTo(320, 6);
    expect((next.workspace / 100) * 550).toBeCloseTo(230, 6);
    expect(Object.keys(next)).toEqual(Object.keys(innerLayout));
  });

  test('pins a collapsed side panel at zero', () => {
    const next = computeInnerFollowLayout({
      outerLayout: { editor: 50, chat: 50 },
      outerResidualId: 'editor',
      outerPanelSpacePx: OUTER_PX,
      innerChromePx: 0,
      innerLayout,
      innerResidualId: 'workspace',
      pinnedPx: { doc: 0 },
    });
    expect(next.doc).toBe(0);
    expect(next.workspace).toBe(100);
  });

  test('leaves the inner row alone when the pin no longer fits the predicted column', () => {
    const next = computeInnerFollowLayout({
      outerLayout: { editor: (200 / OUTER_PX) * 100, chat: (1200 / OUTER_PX) * 100 },
      outerResidualId: 'editor',
      outerPanelSpacePx: OUTER_PX,
      innerChromePx: 0,
      innerLayout,
      innerResidualId: 'workspace',
      pinnedPx: { doc: 320 },
    });
    expect(next).toBe(innerLayout);
  });
});
