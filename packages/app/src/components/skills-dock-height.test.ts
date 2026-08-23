import { describe, expect, it } from 'vitest';
import {
  clampSkillsDockHeight,
  SKILLS_DOCK_MIN_HEIGHT,
  skillsDockMaxHeight,
} from './skills-dock-expanded-store';

/**
 * The dock's height bounds. Small functions, but they are the whole guard
 * between a drag and a panel dragged into a sliver or past the viewport — and
 * the drag feeds them raw pointer deltas, which go out of range constantly.
 */
describe('skillsDockMaxHeight', () => {
  it('is a fraction of the viewport, so the tree above always keeps a body', () => {
    expect(skillsDockMaxHeight(1000)).toBe(700);
  });

  it('never drops below the floor, even in a viewport shorter than it', () => {
    // A very short window would otherwise produce a max below the min and make
    // the clamp below invert its own bounds.
    expect(skillsDockMaxHeight(100)).toBe(SKILLS_DOCK_MIN_HEIGHT);
    expect(skillsDockMaxHeight(0)).toBe(SKILLS_DOCK_MIN_HEIGHT);
  });
});

describe('clampSkillsDockHeight', () => {
  it('passes an in-range height through, rounded', () => {
    expect(clampSkillsDockHeight(300.4, 1000)).toBe(300);
  });

  it('holds the floor and the ceiling', () => {
    expect(clampSkillsDockHeight(10, 1000)).toBe(SKILLS_DOCK_MIN_HEIGHT);
    expect(clampSkillsDockHeight(99_999, 1000)).toBe(700);
  });

  it('survives a drag past the top of the screen', () => {
    // Dragging up grows the dock, so a fast drag hands this a negative-derived
    // number well outside any sane range.
    expect(clampSkillsDockHeight(-5000, 1000)).toBe(SKILLS_DOCK_MIN_HEIGHT);
  });

  it('keeps the floor when the viewport cannot honour it', () => {
    expect(clampSkillsDockHeight(500, 50)).toBe(SKILLS_DOCK_MIN_HEIGHT);
  });
});
