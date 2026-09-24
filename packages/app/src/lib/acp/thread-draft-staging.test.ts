import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  isEmptyThreadDraft,
  readThreadDraft,
  registerThreadDraftReader,
  resetStagedThreadDrafts,
  stageThreadDraft,
  stageThreadDraftContent,
  subscribeStagedThreadDraft,
  subscribeStagedThreadDraftContent,
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

describe('thread draft readers', () => {
  const snapshot = (text: string) => ({
    text,
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    attachments: [],
    uploadsPending: false,
  });

  test('reads the live draft through the registered reader and nothing once it unregisters', () => {
    expect(readThreadDraft('t1')).toBeNull();
    const stop = registerThreadDraftReader('t1', () => snapshot('typed so far'));
    expect(readThreadDraft('t1')?.text).toBe('typed so far');
    stop();
    expect(readThreadDraft('t1')).toBeNull();
  });

  test('a stale unregister does not remove a newer reader', () => {
    const stopFirst = registerThreadDraftReader('t2', () => snapshot('first'));
    registerThreadDraftReader('t2', () => snapshot('second'));
    stopFirst();
    expect(readThreadDraft('t2')?.text).toBe('second');
  });

  test('a draft with no text and no attachments is empty', () => {
    expect(
      isEmptyThreadDraft({ text: '', doc: null, attachments: [], uploadsPending: false }),
    ).toBe(true);
    expect(isEmptyThreadDraft(snapshot('x'))).toBe(false);
    expect(
      isEmptyThreadDraft({
        text: '',
        doc: null,
        attachments: [{ kind: 'image', mimeType: 'image/png', data: 'aGk=', name: 'a.png' }],
        uploadsPending: false,
      }),
    ).toBe(false);
  });
});

describe('thread draft content staging', () => {
  const content = {
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
    attachments: [{ kind: 'image', mimeType: 'image/png', data: 'aGk=', name: 'a.png' }],
  } as const;

  test('holds content until a subscriber arrives, then delivers it once', () => {
    stageThreadDraftContent('t3', content);
    const seen: unknown[] = [];
    const stop = subscribeStagedThreadDraftContent('t3', (c) => seen.push(c));
    expect(seen).toEqual([content]);
    stop();
    const later: unknown[] = [];
    const stopLater = subscribeStagedThreadDraftContent('t3', (c) => later.push(c));
    expect(later).toEqual([]);
    stopLater();
  });

  test('delivers straight to a live subscriber', () => {
    const seen: unknown[] = [];
    const stop = subscribeStagedThreadDraftContent('t4', (c) => seen.push(c));
    stageThreadDraftContent('t4', content);
    expect(seen).toEqual([content]);
    stop();
  });
});
