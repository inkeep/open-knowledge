import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, test } from 'vitest';
import {
  getSourceViewForDoc,
  registerSourceView,
  subscribeSourceViewRegistry,
  unregisterSourceView,
} from './active-source-view';

const fakeView = (id: string): EditorView => ({ __id: id }) as unknown as EditorView;

const TOUCHED_DOCS = ['doc-a', 'doc-b', 'doc-remounted'];

describe('active-source-view registry', () => {
  afterEach(() => {
    for (const docName of TOUCHED_DOCS) {
      const current = getSourceViewForDoc(docName);
      if (current) unregisterSourceView(docName, current);
    }
  });

  test('hands back the view registered for a docName', () => {
    const view = fakeView('a');

    registerSourceView('doc-a', view);

    expect(getSourceViewForDoc('doc-a')).toBe(view);
  });

  test('reports null for a docName with no mounted view', () => {
    expect(getSourceViewForDoc('doc-a')).toBeNull();
  });

  test('unregisters the matching view', () => {
    const view = fakeView('a');
    registerSourceView('doc-a', view);

    unregisterSourceView('doc-a', view);

    expect(getSourceViewForDoc('doc-a')).toBeNull();
  });

  test('a stale unregister does not evict the live successor', () => {
    const previous = fakeView('previous');
    const current = fakeView('current');
    registerSourceView('doc-remounted', previous);
    registerSourceView('doc-remounted', current);

    unregisterSourceView('doc-remounted', previous);

    expect(getSourceViewForDoc('doc-remounted')).toBe(current);
  });

  test('the most recent registration wins for one docName', () => {
    const first = fakeView('first');
    const second = fakeView('second');

    registerSourceView('doc-a', first);
    registerSourceView('doc-a', second);

    expect(getSourceViewForDoc('doc-a')).toBe(second);
  });

  test('keeps document names isolated', () => {
    const viewA = fakeView('a');
    const viewB = fakeView('b');
    registerSourceView('doc-a', viewA);
    registerSourceView('doc-b', viewB);

    unregisterSourceView('doc-a', viewA);

    expect(getSourceViewForDoc('doc-a')).toBeNull();
    expect(getSourceViewForDoc('doc-b')).toBe(viewB);
  });

  test('notifies subscribers when a view mounts and when it unmounts', () => {
    const view = fakeView('a');
    let notifications = 0;
    const unsubscribe = subscribeSourceViewRegistry(() => {
      notifications++;
    });

    registerSourceView('doc-a', view);
    expect(notifications).toBe(1);

    unregisterSourceView('doc-a', view);
    expect(notifications).toBe(2);

    unsubscribe();
  });

  test('stops notifying after unsubscribe', () => {
    let notifications = 0;
    const unsubscribe = subscribeSourceViewRegistry(() => {
      notifications++;
    });

    unsubscribe();
    registerSourceView('doc-a', fakeView('a'));

    expect(notifications).toBe(0);
  });

  test('does not notify when a stale unregister changes nothing', () => {
    const previous = fakeView('previous');
    const current = fakeView('current');
    registerSourceView('doc-remounted', previous);
    registerSourceView('doc-remounted', current);
    let notifications = 0;
    const unsubscribe = subscribeSourceViewRegistry(() => {
      notifications++;
    });

    unregisterSourceView('doc-remounted', previous);

    expect(notifications).toBe(0);
    unsubscribe();
  });

  test('notifies every subscriber', () => {
    const seen: string[] = [];
    const unsubscribeFirst = subscribeSourceViewRegistry(() => seen.push('first'));
    const unsubscribeSecond = subscribeSourceViewRegistry(() => seen.push('second'));

    registerSourceView('doc-a', fakeView('a'));

    expect(seen).toEqual(['first', 'second']);
    unsubscribeFirst();
    unsubscribeSecond();
  });
});
