import { describe, expect, test } from 'vitest';
import { placeValueThreads, threadAtValueOffset } from './property-anchor-click';
import type { CommentThread } from './types';

const VALUE = 'Italian-American';

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    docName: 'recipes/chicken-alfredo-pasta',
    target: { kind: 'property', key: 'cuisine', path: [] },
    anchor: { quote: 'ian-American', prefix: '', suffix: '', start: 4, end: 16 },
    status: 'open',
    body: 'is this right?',
    createdAt: 1000,
    updatedAt: 1000,
    queued: false,
    ...overrides,
  };
}

describe('threadAtValueOffset', () => {
  test('a caret inside the passage opens its thread', () => {
    expect(threadAtValueOffset([thread()], 'cuisine', VALUE, 8)).toBe('t1');
  });

  test('a caret before the passage opens nothing', () => {
    expect(threadAtValueOffset([thread()], 'cuisine', VALUE, 2)).toBeNull();
  });

  test('both edges count as on the passage', () => {
    expect(threadAtValueOffset([thread()], 'cuisine', VALUE, 4)).toBe('t1');
    expect(threadAtValueOffset([thread()], 'cuisine', VALUE, 16)).toBe('t1');
  });

  test('a thread on a different row is not offered', () => {
    expect(threadAtValueOffset([thread()], 'protein', VALUE, 8)).toBeNull();
  });

  test('a resolved thread is not offered', () => {
    expect(threadAtValueOffset([thread({ status: 'resolved' })], 'cuisine', VALUE, 8)).toBeNull();
  });

  test('a whole-field thread covers the whole value', () => {
    const whole = thread({ id: 'whole', anchor: null });
    expect(threadAtValueOffset([whole], 'cuisine', VALUE, 0)).toBe('whole');
    expect(threadAtValueOffset([whole], 'cuisine', VALUE, VALUE.length)).toBe('whole');
  });

  test('the narrowest covering thread wins', () => {
    const threads = [thread({ id: 'whole', anchor: null }), thread({ id: 'passage' })];
    expect(threadAtValueOffset(threads, 'cuisine', VALUE, 8)).toBe('passage');
    expect(threadAtValueOffset(threads, 'cuisine', VALUE, 1)).toBe('whole');
  });

  test('a nested row is addressed by its own last step', () => {
    const nested = thread({
      id: 'nested',
      target: { kind: 'property', key: 'author', path: ['name'] },
      anchor: { quote: 'Italian', prefix: '', suffix: '', start: 0, end: 7 },
    });
    expect(threadAtValueOffset([nested], 'name', VALUE, 3)).toBe('nested');
    expect(threadAtValueOffset([nested], 'author', VALUE, 3)).toBeNull();
  });
});

describe('placeValueThreads', () => {
  test('stale offsets fall back to searching the value', () => {
    const shifted = thread({
      anchor: { quote: 'American', prefix: '', suffix: '', start: 99, end: 107 },
    });
    expect(placeValueThreads([shifted], 'cuisine', VALUE)).toEqual([
      { threadId: 't1', start: 8, end: 16 },
    ]);
  });

  test('a passage that is no longer in the value has no range', () => {
    const gone = thread({
      anchor: { quote: 'Sichuanese', prefix: '', suffix: '', start: 0, end: 10 },
    });
    expect(placeValueThreads([gone], 'cuisine', VALUE)).toEqual([]);
    expect(threadAtValueOffset([gone], 'cuisine', VALUE, 3)).toBeNull();
  });

  test('two rows sharing a key are separated by their values', () => {
    const onName = thread({
      id: 'onName',
      target: { kind: 'property', key: 'author', path: ['name'] },
      anchor: { quote: 'Ada', prefix: '', suffix: '', start: 0, end: 3 },
    });
    expect(placeValueThreads([onName], 'name', 'Ada Lovelace')).toHaveLength(1);
    expect(placeValueThreads([onName], 'name', 'Grace Hopper')).toEqual([]);
  });
});
