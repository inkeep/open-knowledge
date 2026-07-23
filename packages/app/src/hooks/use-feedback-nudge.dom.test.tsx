/**
 * Behavioral tests for `useFeedbackNudgeVisible` — the visibility latch behind
 * the sidebar-footer feedback card.
 *
 * Mounts the hook through a trivial harness over a real store backed by
 * in-memory storage, so both halves of the contract are pinned: when the card
 * takes its one session, and that it never returns once shown or answered.
 *
 * Session scope matters here: a `FeedbackNudgeSession` object stands in for
 * one JS context (one window, boot to reload). The same session across
 * mounts = a React remount; a fresh session over the same storage = an app
 * relaunch. Tests inject fresh sessions for isolation from the module default.
 */

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
/** `firstSeenAt` old enough that the two-week gate has run at `NOW`. */
const RIPE = NOW - FEEDBACK_NUDGE_MIN_AGE_MS;

/** A page set of `n` ordinary (non-`.ok`) documents. */
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

/** One JS context's worth of session state. */
function freshSession(): FeedbackNudgeSession {
  return createFeedbackNudgeSession();
}

/**
 * A store whose two-week clock has already run — an install that predates this
 * session by a fortnight — over storage that survives a remount.
 */
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
    // Stamping `shownAt` this session must not fold back into the prior-session
    // guard and hide the card it just decided to show.
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
    // The shadcn Sidebar tree remounts transparently (theme toggles, width
    // changes — see update-notices-store's doc block, which exists for this
    // exact reason). The remounted hook must re-adopt the session's show
    // rather than read its own `shownAt` as a prior session's and vanish.
    const store = ripeStore();
    const session = freshSession(); // same JS context throughout
    const first = render(<Harness store={store} session={session} />);
    expect(shown(first)).toBe('true');

    first.unmount();
    const second = render(<Harness store={store} session={session} />);
    expect(shown(second)).toBe('true'); // still up — remount is not a relaunch
  });

  test('hides as soon as the user answers, and never returns', () => {
    const store = ripeStore();
    const session = freshSession();
    const view = render(<Harness store={store} session={session} />);
    expect(shown(view)).toBe('true');

    act(() => store.dismiss());
    expect(shown(view)).toBe('false');

    view.unmount();
    // Same session (remount) — dismissed stays dismissed.
    const remounted = render(<Harness store={store} session={session} />);
    expect(shown(remounted)).toBe('false');
  });

  test('shown once, ever: a fresh session after being shown does not re-show', () => {
    // The persistence-backed store carries `shownAt` into the next launch. This
    // is the "ignored, quit, relaunched" case — it must NOT come back. A
    // relaunch = new store instance AND new session object over the same disk.
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
    // At launch the provider starts with an empty set and loading=true. The
    // card must not read that empty set as "0 docs, ineligible" and latch.
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
    // Below threshold when the launch decision is made. A later live edit that
    // pushes the count over ten must NOT surface the card this session — that
    // is the "interrupt mid-writing" case we deliberately avoid.
    const store = ripeStore();
    const session = freshSession();
    const view = render(<Harness store={store} session={session} pages={docs(4)} />);
    expect(shown(view)).toBe('false');

    view.rerender(<Harness store={store} session={session} pages={docs(11)} />);
    expect(shown(view)).toBe('false');
    expect(store.getSnapshot().shownAt).toBeNull();
  });

  test('a below-threshold count at the ready-flip latches the decision for the session', () => {
    // The launch decision latches when the page list loads, BEFORE the
    // eligibility check — so a load that settles under the threshold spends the
    // session's one evaluation. Guards against moving the latch inside the
    // eligible branch, which would let a later mid-session doc-count climb pop
    // the card in. Distinct from the test above: there the count is already
    // loaded; here it is the ready-flip itself that lands below threshold.
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
    // Another footer card owns the space at launch. Even when it clears in the
    // same session, the feedback card must NOT pop in mid-work — it waits for
    // the next launch.
    const storage = persistentStorage();
    const store = ripeStore(storage);
    const session = freshSession();
    const view = render(<Harness store={store} session={session} blocked />);
    expect(shown(view)).toBe('false');
    expect(store.getSnapshot().shownAt).toBeNull();

    view.rerender(<Harness store={store} session={session} blocked={false} />);
    expect(shown(view)).toBe('false'); // still hidden this session

    // Next launch (fresh store + fresh session, same storage, no blocker).
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
