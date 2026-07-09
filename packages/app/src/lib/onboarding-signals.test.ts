import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createOnboardingCardStore,
  type OnboardingCardStorage,
  type OnboardingCardStore,
} from './onboarding-card-store';
import { recordOnboardingAskedAi, recordOnboardingFileStep } from './onboarding-signals';

function freshStore(): OnboardingCardStore {
  const map = new Map<string, string>();
  const storage: OnboardingCardStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
  return createOnboardingCardStore(storage);
}

function mockDocuments(documents: unknown[], status = 200): void {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ documents }), { status })),
  ) as never;
}

const aDocument = { kind: 'document', docName: 'welcome', size: 0, modified: '2026-06-30' };

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('recordOnboardingAskedAi', () => {
  test('marks the step when onboarding is active', () => {
    const store = freshStore();
    store.activate();
    recordOnboardingAskedAi(store);
    expect(store.getSnapshot().steps.askedAi).toBe(true);
  });

  test('no-op when onboarding was never activated (established user)', () => {
    const store = freshStore();
    recordOnboardingAskedAi(store);
    expect(store.getSnapshot().steps.askedAi).toBe(false);
    expect(store.getSnapshot().initialized).toBe(false);
  });
});

describe('recordOnboardingFileStep', () => {
  test('marks the file step when the project has at least one entry', async () => {
    mockDocuments([aDocument]);
    const store = freshStore();
    store.activate();
    await recordOnboardingFileStep(store);
    expect(store.getSnapshot().steps.file).toBe(true);
  });

  test('does not mark the file step when the project is still empty', async () => {
    mockDocuments([]);
    const store = freshStore();
    store.activate();
    await recordOnboardingFileStep(store);
    expect(store.getSnapshot().steps.file).toBe(false);
  });

  test('a starter-pack seed (count === baseline) does not complete the file step', async () => {
    // Activated with a baseline of 2 (two seeded templates). A read that still
    // shows exactly 2 entries is the seed itself — the user has not authored a
    // file yet, so the step must stay incomplete.
    mockDocuments([aDocument, { ...aDocument, docName: 'guide' }]);
    const store = freshStore();
    store.activate(2);
    await recordOnboardingFileStep(store);
    expect(store.getSnapshot().steps.file).toBe(false);
  });

  test('a user-authored file beyond the seed baseline completes the file step', async () => {
    // Count rises to 3, above the baseline of 2 → the user created a doc.
    mockDocuments([
      aDocument,
      { ...aDocument, docName: 'guide' },
      { ...aDocument, docName: 'mine' },
    ]);
    const store = freshStore();
    store.activate(2);
    await recordOnboardingFileStep(store);
    expect(store.getSnapshot().steps.file).toBe(true);
  });

  test('no-op when onboarding is not active (file created by an established user)', async () => {
    const fetchSpy = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchSpy as never;
    const store = freshStore();
    await recordOnboardingFileStep(store);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.getSnapshot().steps.file).toBe(false);
  });

  test('is a no-op (no fetch) when the step is already complete', async () => {
    const fetchSpy = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchSpy as never;
    const store = freshStore();
    // activate() first so `initialized` is true — otherwise the guard's
    // `!initialized` arm would pass this test even if the `steps.file` arm were
    // removed. This isolates the already-complete branch.
    store.activate();
    store.markStepComplete('file');
    await recordOnboardingFileStep(store);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('swallows a failed count read and leaves the step incomplete', async () => {
    mockDocuments({ error: 'boom' } as never, 500);
    const store = freshStore();
    store.activate();
    await recordOnboardingFileStep(store);
    expect(store.getSnapshot().steps.file).toBe(false);
  });
});
