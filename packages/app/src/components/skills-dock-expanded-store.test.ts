import { afterEach, expect, test } from 'vitest';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneVisibilityRequest,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import {
  __resetSkillsDockExpandedForTests,
  readSkillsDockExpanded,
  requestSkillsDockExpanded,
  subscribeSkillsDockExpanded,
  writeSkillsDockExpanded,
} from './skills-dock-expanded-store';

afterEach(() => {
  __resetSkillsDockExpandedForTests();
  __resetPaneVisibilityStoreForTests();
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

test('asking for the dock also asks a hidden editor to show, since the dock lives in it', () => {
  const requests: PaneVisibilityRequest[] = [];
  paneVisibilityStore.subscribeRequests((request) => requests.push(request));

  requestSkillsDockExpanded();

  expect(requests).toEqual([{ pane: 'editor', open: true }]);
});
