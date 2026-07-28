import { act, cleanup, render, screen } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Dummy ws URL: the pool constructs real providers but they never reach the
// wire, matching `DocumentContext.branch-fanout.dom.test.tsx`.
vi.doMock('@/lib/use-collab-url', () => ({
  useCollabUrl: () => ({
    collabUrl: 'ws://localhost:1/collab',
    attempts: 0,
    terminal: false,
    lastError: null,
    retry: () => {},
  }),
}));

const { DocumentProvider, useDocumentContext, useDocumentTransition } = await import(
  './DocumentContext'
);

const originalFetch = globalThis.fetch;

/**
 * Past this many runs the effect stops feeding the cycle, so a regression
 * fails the assertion below instead of spinning until React's own
 * nested-update limit trips (which surfaces as an opaque minified #185).
 */
const EFFECT_RUN_CAP = 25;

let effectRuns = 0;
let consumerCommits = 0;

/**
 * Mirrors `NavigationHandler` in `App.tsx`: the effect calls the navigation
 * entry point in its body AND lists that same callback as a dependency.
 *
 * That pairing is only safe while a pool notify which changes nothing
 * observable leaves the provider's snapshot state untouched. If every notify
 * allocates a fresh snapshot, the callback gets a new identity per commit and
 * the pairing closes into a cycle: effect → `openTargetTransition` →
 * `pool.open()` → notify → re-render → new callback identity → effect.
 */
function NavigationEffectShape({ docName }: { docName: string }) {
  const { openTargetTransition } = useDocumentTransition();
  useEffect(() => {
    effectRuns += 1;
    if (effectRuns > EFFECT_RUN_CAP) return;
    openTargetTransition({ kind: 'doc', target: docName, docName });
  }, [openTargetTransition, docName]);
  return null;
}

function SnapshotConsumer() {
  const { poolEntries } = useDocumentContext();
  // Depless effect runs once per commit — counts re-renders without the
  // impurity of mutating a counter during render.
  useEffect(() => {
    consumerCommits += 1;
  });
  return <span data-testid="pool-size">{poolEntries.length}</span>;
}

function ProviderHarness({ children }: { children: ReactNode }) {
  return <DocumentProvider>{children}</DocumentProvider>;
}

function getPool(): { open(docName: string): unknown } {
  const pool = (window as unknown as { __providerPool?: { open(docName: string): unknown } })
    .__providerPool;
  if (!pool) throw new Error('__providerPool not exposed');
  return pool;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('DocumentContext pool-snapshot stability', () => {
  afterEach(() => {
    cleanup();
    effectRuns = 0;
    consumerCommits = 0;
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    window.location.hash = '';
  });

  test('a navigation effect that re-opens its own target settles instead of looping', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;

    render(<NavigationEffectShape docName="Loop.md" />, { wrapper: ProviderHarness });
    await settle();
    const runsAtQuiescence = effectRuns;

    // Admitting the doc and marking it active are real transitions, so a
    // handful of re-runs is expected. The defect is unbounded re-running, so
    // assert well clear of the cap rather than pinning an exact count.
    expect(runsAtQuiescence).toBeLessThan(EFFECT_RUN_CAP / 2);

    // ...and it must have converged, not merely been throttled: further
    // draining adds no runs.
    await settle();
    await settle();
    expect(effectRuns).toBe(runsAtQuiescence);
  });

  test('re-opening an already-pooled doc does not re-render snapshot consumers', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;

    render(<SnapshotConsumer />, { wrapper: ProviderHarness });
    await settle();

    // The pool is cached per collab URL at module scope, so it can carry
    // entries admitted by an earlier test. Assert on deltas, not absolutes.
    const pool = getPool();
    const sizeBefore = Number(screen.getByTestId('pool-size').textContent);
    const commitsBeforeAdmission = consumerCommits;

    await act(async () => {
      pool.open('Warm.md');
    });
    await settle();

    // Admitting a new doc is a real change: it must reach consumers.
    expect(Number(screen.getByTestId('pool-size').textContent)).toBe(sizeBefore + 1);
    expect(consumerCommits).toBeGreaterThan(commitsBeforeAdmission);

    // A warm hit only bumps `lastAccessedAt` and re-touches the LRU order.
    // Neither reaches the DOM, so no consumer should re-render.
    const commitsAfterAdmission = consumerCommits;
    await act(async () => {
      pool.open('Warm.md');
      pool.open('Warm.md');
    });
    await settle();

    expect(consumerCommits).toBe(commitsAfterAdmission);
  });
});
