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
  // The two ends genuinely race: `launchAgentThread` stages once `createThread`
  // resolves, while `ThreadView` subscribes when the dock mounts its tab. Both
  // orders have to deliver, or an Ask AI silently loses the user's passage.
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

  // A remount must not re-seed a draft the user already cleared.
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

  // Nothing to review — staging it would just flash an empty composer.
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

  // A remount can register its listener before the previous one's cleanup runs
  // (React StrictMode, fast tab flips). The stale cleanup must not evict the
  // newer listener, or the very next stage goes nowhere.
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
