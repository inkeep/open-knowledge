import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  resetStagedThreadDrafts,
  stageThreadDraft,
  subscribeStagedThreadDraft,
} from './thread-draft-staging';

afterEach(() => {
  resetStagedThreadDrafts();
});

describe('thread draft staging', () => {
  test('delivers to a subscriber that arrives AFTER the stage', () => {
    stageThreadDraft('thread-1', 'fix this lint error');
    const seen: string[] = [];
    subscribeStagedThreadDraft('thread-1', (text) => seen.push(text));
    expect(seen).toEqual(['fix this lint error']);
  });

  test('delivers to a subscriber that arrives BEFORE the stage', () => {
    const seen: string[] = [];
    subscribeStagedThreadDraft('thread-1', (text) => seen.push(text));
    stageThreadDraft('thread-1', 'fix this lint error');
    expect(seen).toEqual(['fix this lint error']);
  });

  test('consumes exactly once', () => {
    stageThreadDraft('thread-1', 'first');
    const first: string[] = [];
    const stop = subscribeStagedThreadDraft('thread-1', (text) => first.push(text));
    stop();
    const second: string[] = [];
    subscribeStagedThreadDraft('thread-1', (text) => second.push(text));
    expect(first).toEqual(['first']);
    expect(second).toEqual([]);
  });

  test('routes each thread its own draft', () => {
    stageThreadDraft('thread-1', 'for one');
    stageThreadDraft('thread-2', 'for two');
    const one: string[] = [];
    const two: string[] = [];
    subscribeStagedThreadDraft('thread-1', (text) => one.push(text));
    subscribeStagedThreadDraft('thread-2', (text) => two.push(text));
    expect(one).toEqual(['for one']);
    expect(two).toEqual(['for two']);
  });

  test.each([' ', '', '\n\t '])('ignores whitespace-only text (%j)', (text) => {
    const seen: string[] = [];
    subscribeStagedThreadDraft('thread-1', (t) => seen.push(t));
    stageThreadDraft('thread-1', text);
    expect(seen).toEqual([]);
  });

  test('unsubscribe stops delivery', () => {
    const seen: string[] = [];
    const stop = subscribeStagedThreadDraft('thread-1', (text) => seen.push(text));
    stop();
    stageThreadDraft('thread-1', 'too late');
    expect(seen).toEqual([]);
  });

  test('a stale unsubscribe does not evict a newer listener', () => {
    const older = vi.fn();
    const newer = vi.fn();
    const stopOlder = subscribeStagedThreadDraft('thread-1', older);
    subscribeStagedThreadDraft('thread-1', newer);
    stopOlder();
    stageThreadDraft('thread-1', 'after remount');
    expect(newer).toHaveBeenCalledWith('after remount');
    expect(older).not.toHaveBeenCalled();
  });
});
