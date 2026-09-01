import { afterEach, expect, test } from 'vitest';
import {
  __resetSkillsDockExpandedForTests,
  readSkillsDockExpanded,
  requestSkillsDockExpanded,
  subscribeSkillsDockExpanded,
  writeSkillsDockExpanded,
} from './skills-dock-expanded-store';

afterEach(() => {
  __resetSkillsDockExpandedForTests();
});

test('ships collapsed when nothing was ever stored', () => {
  expect(readSkillsDockExpanded()).toBe(false);
});

test('a write is readable back', () => {
  writeSkillsDockExpanded(true);
  expect(readSkillsDockExpanded()).toBe(true);
});

test('notifies subscribers so an outside reveal reaches the mounted dock', () => {
  const seen: boolean[] = [];
  const unsubscribe = subscribeSkillsDockExpanded((value) => seen.push(value));

  requestSkillsDockExpanded();
  expect(seen).toEqual([true]);

  requestSkillsDockExpanded();
  expect(seen).toEqual([true]);

  unsubscribe();
  writeSkillsDockExpanded(false);
  expect(seen).toEqual([true]);
});
