import { describe, expect, test } from 'vitest';
import { CASCADE_OFFSET_PX, cascadePosition } from './cascade-position.ts';

const WORK_AREA = { x: 0, y: 25, width: 1920, height: 1055 };
const SIZE = { width: 1280, height: 800 };

describe('cascadePosition', () => {
  test('null anchor (first window) keeps default placement', () => {
    expect(cascadePosition({ anchor: null, size: SIZE, workArea: WORK_AREA })).toBeNull();
  });

  test('offsets down-right from the anchor by the default step', () => {
    const pos = cascadePosition({
      anchor: { x: 320, y: 152 },
      size: SIZE,
      workArea: WORK_AREA,
    });
    expect(pos).toEqual({ x: 320 + CASCADE_OFFSET_PX, y: 152 + CASCADE_OFFSET_PX });
  });

  test('chained anchors produce a marching cascade', () => {
    let anchor = { x: 320, y: 152 };
    const positions: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 3; i++) {
      const pos = cascadePosition({ anchor, size: SIZE, workArea: WORK_AREA });
      if (pos === null) throw new Error('expected a position');
      positions.push(pos);
      anchor = pos;
    }
    expect(positions).toEqual([
      { x: 348, y: 180 },
      { x: 376, y: 208 },
      { x: 404, y: 236 },
    ]);
  });

  test('wraps to the work-area top-left when overflowing the right edge', () => {
    const pos = cascadePosition({
      anchor: { x: WORK_AREA.x + WORK_AREA.width - SIZE.width - 10, y: 100 },
      size: SIZE,
      workArea: WORK_AREA,
    });
    expect(pos).toEqual({
      x: WORK_AREA.x + CASCADE_OFFSET_PX,
      y: WORK_AREA.y + CASCADE_OFFSET_PX,
    });
  });

  test('wraps to the work-area top-left when overflowing the bottom edge', () => {
    const pos = cascadePosition({
      anchor: { x: 100, y: WORK_AREA.y + WORK_AREA.height - SIZE.height - 10 },
      size: SIZE,
      workArea: WORK_AREA,
    });
    expect(pos).toEqual({
      x: WORK_AREA.x + CASCADE_OFFSET_PX,
      y: WORK_AREA.y + CASCADE_OFFSET_PX,
    });
  });

  test('exact fit at the edge does not wrap', () => {
    const anchor = {
      x: WORK_AREA.x + WORK_AREA.width - SIZE.width - CASCADE_OFFSET_PX,
      y: WORK_AREA.y + WORK_AREA.height - SIZE.height - CASCADE_OFFSET_PX,
    };
    const pos = cascadePosition({ anchor, size: SIZE, workArea: WORK_AREA });
    expect(pos).toEqual({ x: anchor.x + CASCADE_OFFSET_PX, y: anchor.y + CASCADE_OFFSET_PX });
  });

  test('secondary display with non-zero work-area origin wraps onto that display', () => {
    const secondary = { x: 1920, y: 0, width: 1440, height: 900 };
    const pos = cascadePosition({
      anchor: { x: 1920 + 1440 - SIZE.width, y: 50 },
      size: SIZE,
      workArea: secondary,
    });
    expect(pos).toEqual({
      x: secondary.x + CASCADE_OFFSET_PX,
      y: secondary.y + CASCADE_OFFSET_PX,
    });
  });

  test('window larger than the work area degrades to the wrapped origin', () => {
    const pos = cascadePosition({
      anchor: { x: 0, y: 25 },
      size: { width: 4000, height: 3000 },
      workArea: WORK_AREA,
    });
    expect(pos).toEqual({
      x: WORK_AREA.x + CASCADE_OFFSET_PX,
      y: WORK_AREA.y + CASCADE_OFFSET_PX,
    });
  });
});
