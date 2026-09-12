import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, test } from 'vitest';
import { FULL_PAGE_CM_HOST_SELECTORS, type FullPageCmHost } from './document-scrollports';
import {
  getFullPageCmEntryForDoc,
  getMarkdownSourceViewForDoc,
  registerFullPageCmView,
  subscribeFullPageCmViewRegistry,
  unregisterFullPageCmView,
} from './full-page-cm-views';

const fakeView = (id: string): EditorView => ({ __id: id }) as unknown as EditorView;

const FULL_PAGE_CM_HOSTS = Object.keys(FULL_PAGE_CM_HOST_SELECTORS) as FullPageCmHost[];

const HOST_DOC = 'doc-host-discrimination';

const TOUCHED_DOCS = ['doc-a', 'doc-b', 'doc-remounted'];

describe('full-page-cm-views registry', () => {
  afterEach(() => {
    for (const docName of TOUCHED_DOCS) {
      const entry = getFullPageCmEntryForDoc(docName);
      if (entry) unregisterFullPageCmView(docName, entry.view);
    }
  });

  test('hands back the view registered for a docName', () => {
    const view = fakeView('a');

    registerFullPageCmView('doc-a', view, 'sourceEditor');

    expect(getMarkdownSourceViewForDoc('doc-a')).toBe(view);
  });

  test('reports null for a docName with no mounted view', () => {
    expect(getMarkdownSourceViewForDoc('doc-a')).toBeNull();
  });

  test('unregisters the matching view', () => {
    const view = fakeView('a');
    registerFullPageCmView('doc-a', view, 'sourceEditor');

    unregisterFullPageCmView('doc-a', view);

    expect(getMarkdownSourceViewForDoc('doc-a')).toBeNull();
  });

  test('a stale unregister does not evict the live successor', () => {
    const previous = fakeView('previous');
    const current = fakeView('current');
    registerFullPageCmView('doc-remounted', previous, 'sourceEditor');
    registerFullPageCmView('doc-remounted', current, 'sourceEditor');

    unregisterFullPageCmView('doc-remounted', previous);

    expect(getMarkdownSourceViewForDoc('doc-remounted')).toBe(current);
  });

  test('the most recent registration wins for one docName', () => {
    const first = fakeView('first');
    const second = fakeView('second');

    registerFullPageCmView('doc-a', first, 'sourceEditor');
    registerFullPageCmView('doc-a', second, 'sourceEditor');

    expect(getMarkdownSourceViewForDoc('doc-a')).toBe(second);
  });

  test('keeps document names isolated', () => {
    const viewA = fakeView('a');
    const viewB = fakeView('b');
    registerFullPageCmView('doc-a', viewA, 'sourceEditor');
    registerFullPageCmView('doc-b', viewB, 'sourceEditor');

    unregisterFullPageCmView('doc-a', viewA);

    expect(getMarkdownSourceViewForDoc('doc-a')).toBeNull();
    expect(getMarkdownSourceViewForDoc('doc-b')).toBe(viewB);
  });

  test('notifies subscribers when a view mounts and when it unmounts', () => {
    const view = fakeView('a');
    let notifications = 0;
    const unsubscribe = subscribeFullPageCmViewRegistry(() => {
      notifications++;
    });

    registerFullPageCmView('doc-a', view, 'sourceEditor');
    expect(notifications).toBe(1);

    unregisterFullPageCmView('doc-a', view);
    expect(notifications).toBe(2);

    unsubscribe();
  });

  test('stops notifying after unsubscribe', () => {
    let notifications = 0;
    const unsubscribe = subscribeFullPageCmViewRegistry(() => {
      notifications++;
    });

    unsubscribe();
    registerFullPageCmView('doc-a', fakeView('a'), 'sourceEditor');

    expect(notifications).toBe(0);
  });

  test('does not notify when a stale unregister changes nothing', () => {
    const previous = fakeView('previous');
    const current = fakeView('current');
    registerFullPageCmView('doc-remounted', previous, 'sourceEditor');
    registerFullPageCmView('doc-remounted', current, 'sourceEditor');
    let notifications = 0;
    const unsubscribe = subscribeFullPageCmViewRegistry(() => {
      notifications++;
    });

    unregisterFullPageCmView('doc-remounted', previous);

    expect(notifications).toBe(0);
    unsubscribe();
  });

  test('notifies every subscriber', () => {
    const seen: string[] = [];
    const unsubscribeFirst = subscribeFullPageCmViewRegistry(() => seen.push('first'));
    const unsubscribeSecond = subscribeFullPageCmViewRegistry(() => seen.push('second'));

    registerFullPageCmView('doc-a', fakeView('a'), 'sourceEditor');

    expect(seen).toEqual(['first', 'second']);
    unsubscribeFirst();
    unsubscribeSecond();
  });
});

describe('full-page-cm-views discriminates the host a registered CodeMirror belongs to', () => {
  afterEach(() => {
    const entry = getFullPageCmEntryForDoc(HOST_DOC);
    if (entry) unregisterFullPageCmView(HOST_DOC, entry.view);
  });

  test('reports null for a docName with no mounted view', () => {
    expect(getFullPageCmEntryForDoc(HOST_DOC)).toBeNull();
  });

  test.each(FULL_PAGE_CM_HOSTS)(
    'hands back a view registered under the %s host together with that host',
    (host) => {
      const view = fakeView(host);

      registerFullPageCmView(HOST_DOC, view, host);

      expect(
        getFullPageCmEntryForDoc(HOST_DOC),
        `the registry must hand \`${host}\` back paired with the view it was given, so the caret ` +
          'reveal can pick that host scrollport. Which components actually register which host is ' +
          'a producer contract, pinned one component at a time in the three host-contract tests',
      ).toEqual({ view, host });
    },
  );

  test('the markdown source-editor accessor answers for a source-editor registration', () => {
    const view = fakeView('markdown');

    registerFullPageCmView(HOST_DOC, view, 'sourceEditor');

    expect(getMarkdownSourceViewForDoc(HOST_DOC)).toBe(view);
  });

  test.each(FULL_PAGE_CM_HOSTS.filter((host) => host !== 'sourceEditor'))(
    'the markdown source-editor accessor stays empty for a %s registration',
    (host) => {
      registerFullPageCmView(HOST_DOC, fakeView(host), host);

      expect(
        getMarkdownSourceViewForDoc(HOST_DOC),
        `\`getMarkdownSourceViewForDoc\` means "the markdown source editor for this doc" to its existing ` +
          `consumers. Widening it to answer for \`${host}\` would hand the markdown outline and ` +
          'landing resolvers a CodeMirror holding a different language',
      ).toBeNull();
    },
  );

  test('re-registering a document under a different host replaces the recorded host', () => {
    const markdownView = fakeView('markdown');
    const textDocView = fakeView('text-doc');
    registerFullPageCmView(HOST_DOC, markdownView, 'sourceEditor');

    registerFullPageCmView(HOST_DOC, textDocView, 'textDocEditor');

    expect(getFullPageCmEntryForDoc(HOST_DOC)).toEqual({
      view: textDocView,
      host: 'textDocEditor',
    });
    expect(getMarkdownSourceViewForDoc(HOST_DOC)).toBeNull();
  });

  test('unregistering clears both accessors', () => {
    const view = fakeView('markdown');
    registerFullPageCmView(HOST_DOC, view, 'sourceEditor');

    unregisterFullPageCmView(HOST_DOC, view);

    expect(getFullPageCmEntryForDoc(HOST_DOC)).toBeNull();
    expect(getMarkdownSourceViewForDoc(HOST_DOC)).toBeNull();
  });

  test('a stale unregister does not evict the live successor or its host', () => {
    const previous = fakeView('previous');
    const current = fakeView('current');
    registerFullPageCmView(HOST_DOC, previous, 'sourceEditor');
    registerFullPageCmView(HOST_DOC, current, 'textDocEditor');

    unregisterFullPageCmView(HOST_DOC, previous);

    expect(getFullPageCmEntryForDoc(HOST_DOC)).toEqual({ view: current, host: 'textDocEditor' });
  });
});
