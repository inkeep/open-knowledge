import { afterEach, expect, test } from 'vitest';
import {
  __resetSkillsDockExpandedForTests,
  readSkillsDockExpanded,
  requestSkillsDockExpanded,
  subscribeSkillsDockExpanded,
  writeSkillsDockExpanded,
} from './skills-dock-expanded-store';

// Plain unit tier, not `.dom.test.tsx`: nothing here renders. The store degrades
// to its in-memory value with no `window`, which is exactly what this exercises —
// the localStorage mirror behind it is a guarded one-liner.
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

  // The command palette's Skills entry and an unresolved `/skill-name` link both
  // go through this: the dock reads the store once at mount, so without the
  // notification it would never see a write it did not make itself.
  requestSkillsDockExpanded();
  expect(seen).toEqual([true]);

  // Idempotent — re-requesting an already-expanded dock must not re-notify.
  requestSkillsDockExpanded();
  expect(seen).toEqual([true]);

  unsubscribe();
  writeSkillsDockExpanded(false);
  expect(seen).toEqual([true]);
});
