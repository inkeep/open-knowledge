import { describe, expect, it } from 'vitest';
import {
  clampSkillsDockHeight,
  SKILLS_DOCK_MIN_HEIGHT,
  skillsDockMaxHeight,
} from './skills-dock-expanded-store';

describe('skillsDockMaxHeight', () => {
  it('is a fraction of the viewport, so the tree above always keeps a body', () => {
    expect(skillsDockMaxHeight(1000)).toBe(700);
  });

  it('never drops below the floor, even in a viewport shorter than it', () => {
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
    expect(clampSkillsDockHeight(-5000, 1000)).toBe(SKILLS_DOCK_MIN_HEIGHT);
  });

  it('keeps the floor when the viewport cannot honour it', () => {
    expect(clampSkillsDockHeight(500, 50)).toBe(SKILLS_DOCK_MIN_HEIGHT);
  });
});
