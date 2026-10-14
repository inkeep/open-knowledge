import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CommentThread } from './types';

const revealComment = vi.fn();

vi.doMock('./reveal-comment', () => ({ revealComment }));

const { revealThread } = await import('./comment-chips');
const { __resetPropertiesCollapsedForTests, getPropertiesCollapsed, setPropertiesCollapsed } =
  await import('@/components/properties-collapsed-store');

const bodyThread: CommentThread = {
  id: 't1',
  docName: 'recipes/stir-fry',
  target: { kind: 'body' },
  anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
  status: 'open',
  body: 'press it?',
  createdAt: 1000,
  updatedAt: 1000,
  queued: true,
};

const propertyThread: CommentThread = {
  ...bodyThread,
  id: 't2',
  target: { kind: 'property', key: 'servings', path: [] },
};

afterEach(() => {
  revealComment.mockClear();
  __resetPropertiesCollapsedForTests();
});

describe('revealing a comment thread', () => {
  test('a property comment expands collapsed Properties before it resolves its row', () => {
    setPropertiesCollapsed(true);
    revealThread(propertyThread);
    expect(getPropertiesCollapsed()).toBe(false);
    expect(revealComment).toHaveBeenCalledTimes(1);
  });

  test('a body comment leaves Properties as they were', () => {
    setPropertiesCollapsed(true);
    revealThread(bodyThread);
    expect(getPropertiesCollapsed()).toBe(true);
    expect(revealComment).toHaveBeenCalledTimes(1);
  });
});
