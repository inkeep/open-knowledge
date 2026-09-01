import { act, cleanup, render, screen } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

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

const EFFECT_RUN_CAP = 25;

let effectRuns = 0;
let consumerCommits = 0;

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

    expect(runsAtQuiescence).toBeLessThan(EFFECT_RUN_CAP / 2);

    await settle();
    await settle();
    expect(effectRuns).toBe(runsAtQuiescence);
  });

  test('re-opening an already-pooled doc does not re-render snapshot consumers', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as never;

    render(<SnapshotConsumer />, { wrapper: ProviderHarness });
    await settle();

    const pool = getPool();
    const sizeBefore = Number(screen.getByTestId('pool-size').textContent);
    const commitsBeforeAdmission = consumerCommits;

    await act(async () => {
      pool.open('Warm.md');
    });
    await settle();

    expect(Number(screen.getByTestId('pool-size').textContent)).toBe(sizeBefore + 1);
    expect(consumerCommits).toBeGreaterThan(commitsBeforeAdmission);

    const commitsAfterAdmission = consumerCommits;
    await act(async () => {
      pool.open('Warm.md');
      pool.open('Warm.md');
    });
    await settle();

    expect(consumerCommits).toBe(commitsAfterAdmission);
  });
});
