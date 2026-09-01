import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createFeedbackNudgeStore,
  FEEDBACK_NUDGE_MIN_AGE_MS,
  FEEDBACK_NUDGE_MIN_DOCS,
  type FeedbackNudgeStorage,
  type FeedbackNudgeStore,
} from '@/lib/feedback-nudge-store';
import {
  createFeedbackNudgeSession,
  type FeedbackNudgeSession,
  useFeedbackNudgeVisible,
} from './use-feedback-nudge';

const NOW = 1_800_000_000_000;
const RIPE = NOW - FEEDBACK_NUDGE_MIN_AGE_MS;

function docs(n: number): Set<string> {
  return new Set(Array.from({ length: n }, (_, i) => `doc-${i}`));
}

function persistentStorage(): FeedbackNudgeStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function freshSession(): FeedbackNudgeSession {
  return createFeedbackNudgeSession();
}

function ripeStore(storage: FeedbackNudgeStorage = persistentStorage()): FeedbackNudgeStore {
  const store = createFeedbackNudgeStore(storage);
  store.recordFirstSeen(RIPE);
  return store;
}

function Harness({
  store,
  session,
  pages = docs(FEEDBACK_NUDGE_MIN_DOCS),
  ready = true,
  blocked = false,
}: {
  store: FeedbackNudgeStore;
  session: FeedbackNudgeSession;
  pages?: Set<string> | null;
  ready?: boolean;
  blocked?: boolean;
}) {
  const visible = useFeedbackNudgeVisible({
    pages,
    ready,
    blocked,
    store,
    session,
    now: () => NOW,
  });
  return <div data-testid="visible">{String(visible)}</div>;
}

const shown = (view: { getByTestId: (id: string) => HTMLElement }) =>
  view.getByTestId('visible').textContent;

describe('useFeedbackNudgeVisible', () => {
  afterEach(() => cleanup());

  test('shows when both gates pass at launch, and latches shownAt', () => {
    const store = ripeStore();
    const view = render(<Harness store={store} session={freshSession()} />);

    expect(shown(view)).toBe('true');
    expect(store.getSnapshot().shownAt).toBe(NOW);
  });

  test('stays visible after shownAt latches', () => {
    const store = ripeStore();
    const session = freshSession();
    const view = render(<Harness store={store} session={session} />);
    expect(shown(view)).toBe('true');

    view.rerender(
      <Harness store={store} session={session} pages={docs(FEEDBACK_NUDGE_MIN_DOCS + 3)} />,
    );
    expect(shown(view)).toBe('true');
  });

  test('a showing card SURVIVES a React remount within the same session', () => {
    const store = ripeStore();
    const session = freshSession();
    const first = render(<Harness store={store} session={session} />);
    expect(shown(first)).toBe('true');

    first.unmount();
    const second = render(<Harness store={store} session={session} />);
    expect(shown(second)).toBe('true');
  });

  test('hides as soon as the user answers, and never returns', () => {
    const store = ripeStore();
    const session = freshSession();
    const view = render(<Harness store={store} session={session} />);
    expect(shown(view)).toBe('true');

    act(() => store.dismiss());
    expect(shown(view)).toBe('false');

    view.unmount();
    const remounted = render(<Harness store={store} session={session} />);
    expect(shown(remounted)).toBe('false');
  });

  test('shown once, ever: a fresh session after being shown does not re-show', () => {
    const storage = persistentStorage();
    const first = ripeStore(storage);
    expect(shown(render(<Harness store={first} session={freshSession()} />))).toBe('true');
    cleanup();

    const relaunchedStore = createFeedbackNudgeStore(storage);
    const relaunched = render(<Harness store={relaunchedStore} session={freshSession()} />);
    expect(shown(relaunched)).toBe('false');
  });

  test('does not show before the two-week clock has run', () => {
    const store = createFeedbackNudgeStore(persistentStorage());
    store.recordFirstSeen(RIPE + 1);
    const view = render(<Harness store={store} session={freshSession()} />);

    expect(shown(view)).toBe('false');
    expect(store.getSnapshot().shownAt).toBeNull();
  });

  test('does not show below the document threshold', () => {
    const store = ripeStore();
    const view = render(
      <Harness store={store} session={freshSession()} pages={docs(FEEDBACK_NUDGE_MIN_DOCS - 1)} />,
    );

    expect(shown(view)).toBe('false');
    expect(store.getSnapshot().shownAt).toBeNull();
  });

  test('waits for the page list to load before deciding', () => {
    const store = ripeStore();
    const session = freshSession();
    const view = render(
      <Harness store={store} session={session} pages={new Set()} ready={false} />,
    );
    expect(shown(view)).toBe('false');
    expect(store.getSnapshot().shownAt).toBeNull();

    view.rerender(
      <Harness store={store} session={session} pages={docs(FEEDBACK_NUDGE_MIN_DOCS)} ready />,
    );
    expect(shown(view)).toBe('true');
  });

  test('null page set fails closed', () => {
    const store = ripeStore();
    const view = render(<Harness store={store} session={freshSession()} pages={null} />);
    expect(shown(view)).toBe('false');
    expect(store.getSnapshot().shownAt).toBeNull();
  });

  test('evaluated at launch, not on the fly: crossing the threshold mid-session does not fire', () => {
    const store = ripeStore();
    const session = freshSession();
    const view = render(<Harness store={store} session={session} pages={docs(4)} />);
    expect(shown(view)).toBe('false');

    view.rerender(<Harness store={store} session={session} pages={docs(11)} />);
    expect(shown(view)).toBe('false');
    expect(store.getSnapshot().shownAt).toBeNull();
  });

  test('a below-threshold count at the ready-flip latches the decision for the session', () => {
    const store = ripeStore();
    const session = freshSession();
    const view = render(<Harness store={store} session={session} pages={docs(4)} ready={false} />);
    expect(shown(view)).toBe('false');

    view.rerender(<Harness store={store} session={session} pages={docs(4)} ready />);
    expect(shown(view)).toBe('false');
    expect(store.getSnapshot().shownAt).toBeNull();

    view.rerender(
      <Harness store={store} session={session} pages={docs(FEEDBACK_NUDGE_MIN_DOCS + 5)} ready />,
    );
    expect(shown(view)).toBe('false');
    expect(store.getSnapshot().shownAt).toBeNull();
  });

  test('stamps firstSeenAt on a first-ever mount and stays hidden that session', () => {
    const store = createFeedbackNudgeStore(persistentStorage());
    const view = render(<Harness store={store} session={freshSession()} pages={docs(400)} />);

    expect(store.getSnapshot().firstSeenAt).toBe(NOW);
    expect(shown(view)).toBe('false');
  });

  test('blocked at launch defers to the next launch, not to later this session', () => {
    const storage = persistentStorage();
    const store = ripeStore(storage);
    const session = freshSession();
    const view = render(<Harness store={store} session={session} blocked />);
    expect(shown(view)).toBe('false');
    expect(store.getSnapshot().shownAt).toBeNull();

    view.rerender(<Harness store={store} session={session} blocked={false} />);
    expect(shown(view)).toBe('false');

    cleanup();
    const relaunchedStore = createFeedbackNudgeStore(storage);
    relaunchedStore.recordFirstSeen(RIPE);
    expect(shown(render(<Harness store={relaunchedStore} session={freshSession()} />))).toBe(
      'true',
    );
  });

  test('a store that already recorded a show does not re-show', () => {
    const store = ripeStore();
    store.recordShown(NOW - 1);
    const view = render(<Harness store={store} session={freshSession()} pages={docs(400)} />);

    expect(shown(view)).toBe('false');
  });
});
