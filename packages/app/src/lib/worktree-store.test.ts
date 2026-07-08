import { describe, expect, mock, test } from 'bun:test';
import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import { createWorktreeStore } from './worktree-store.ts';

function model(mainRoot: string): WorktreeSelectorModel {
  return { mainRoot, currentBranch: 'main', entries: [], remoteBranches: [] };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createWorktreeStore', () => {
  test('fetches once on first subscribe and caches the snapshot', async () => {
    const fetchModel = mock(() => Promise.resolve(model('/repo')));
    const store = createWorktreeStore({ fetchModel });
    expect(store.getSnapshot()).toBeNull();

    const unsub = store.subscribe(() => {});
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()?.mainRoot).toBe('/repo');

    // A second subscriber does not re-fetch — the cache is shared.
    store.subscribe(() => {});
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(1);
    unsub();
  });

  test('notifies subscribers when the model arrives', async () => {
    const fetchModel = mock(() => Promise.resolve(model('/repo')));
    const store = createWorktreeStore({ fetchModel });
    const listener = mock(() => {});
    store.subscribe(listener);
    await flush();
    expect(listener).toHaveBeenCalled();
  });

  test('refresh re-fetches and updates the snapshot', async () => {
    let next = model('/repo');
    const fetchModel = mock(() => Promise.resolve(next));
    const store = createWorktreeStore({ fetchModel });
    store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot()?.mainRoot).toBe('/repo');

    next = model('/repo2');
    store.refresh();
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()?.mainRoot).toBe('/repo2');
  });

  test('keeps the prior cache when a fetch resolves null (transient failure)', async () => {
    let result: WorktreeSelectorModel | null = model('/repo');
    const fetchModel = mock(() => Promise.resolve(result));
    const store = createWorktreeStore({ fetchModel });
    store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot()?.mainRoot).toBe('/repo');

    result = null;
    store.refresh();
    await flush();
    // Snapshot unchanged — a null result does not blank the cache.
    expect(store.getSnapshot()?.mainRoot).toBe('/repo');
  });

  test('coalesces a refresh that arrives while the initial load is still in-flight', async () => {
    let resolveFirst: ((m: WorktreeSelectorModel) => void) | null = null;
    let call = 0;
    const fetchModel = mock(() => {
      call += 1;
      if (call === 1) {
        // Hold the bootstrap load open so refresh() lands mid-flight.
        return new Promise<WorktreeSelectorModel>((r) => {
          resolveFirst = r;
        });
      }
      return Promise.resolve(model('/repo-after-create'));
    });
    const store = createWorktreeStore({ fetchModel });
    store.subscribe(() => {});
    await flush();
    // Bootstrap is in-flight; a create-triggered refresh must not be dropped.
    store.refresh();
    resolveFirst?.(model('/repo'));
    await flush();
    await flush();
    // The queued reload ran after the first settled → the newer model wins.
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()?.mainRoot).toBe('/repo-after-create');
  });

  test('a rejected fetch keeps the prior snapshot', async () => {
    let shouldThrow = false;
    const fetchModel = mock(() =>
      shouldThrow ? Promise.reject(new Error('ipc down')) : Promise.resolve(model('/repo')),
    );
    const store = createWorktreeStore({ fetchModel });
    store.subscribe(() => {});
    await flush();
    shouldThrow = true;
    store.refresh();
    await flush();
    expect(store.getSnapshot()?.mainRoot).toBe('/repo');
  });

  test('revalidation re-fetches so an out-of-band worktree surfaces without a refresh() call', async () => {
    let next = model('/repo');
    const fetchModel = mock(() => Promise.resolve(next));
    // Capture the store's revalidation callback so the test can fire a
    // focus/visible signal by hand (no DOM).
    let fireRevalidate: (() => void) | null = null;
    const subscribeRevalidate = mock((onRevalidate: () => void) => {
      fireRevalidate = onRevalidate;
      return () => {
        fireRevalidate = null;
      };
    });
    const store = createWorktreeStore({ fetchModel, subscribeRevalidate });
    const listener = mock(() => {});
    store.subscribe(listener);
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(subscribeRevalidate).toHaveBeenCalledTimes(1);

    // A worktree was created out-of-band (terminal / other window); the window
    // regains focus → the store re-fetches WITHOUT any explicit refresh().
    next = model('/repo-with-new-worktree');
    fireRevalidate?.();
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()?.mainRoot).toBe('/repo-with-new-worktree');
  });

  test('attaches the revalidation trigger once and detaches it when the last subscriber leaves', async () => {
    const fetchModel = mock(() => Promise.resolve(model('/repo')));
    let attached = 0;
    let detached = 0;
    const subscribeRevalidate = mock((_onRevalidate: () => void) => {
      attached += 1;
      return () => {
        detached += 1;
      };
    });
    const store = createWorktreeStore({ fetchModel, subscribeRevalidate });

    const unsubA = store.subscribe(() => {});
    const unsubB = store.subscribe(() => {});
    await flush();
    // Attached exactly once for the first subscriber; the second reuses it.
    expect(attached).toBe(1);
    expect(detached).toBe(0);

    // Still one subscriber left → trigger stays attached (no leak, no premature
    // teardown).
    unsubA();
    expect(detached).toBe(0);

    // Last subscriber leaves → the trigger is detached so the DOM listener can't
    // outlive the store's consumers.
    unsubB();
    expect(detached).toBe(1);
  });

  test('re-attaches the revalidation trigger when a new subscriber arrives after the store went quiet', async () => {
    const fetchModel = mock(() => Promise.resolve(model('/repo')));
    let attached = 0;
    const subscribeRevalidate = mock((_onRevalidate: () => void) => {
      attached += 1;
      return () => {};
    });
    const store = createWorktreeStore({ fetchModel, subscribeRevalidate });

    store.subscribe(() => {})();
    await flush();
    expect(attached).toBe(1);

    // A later subscriber (e.g. the switcher remounts) must re-arm revalidation.
    store.subscribe(() => {});
    await flush();
    expect(attached).toBe(2);
  });

  test('a revalidation firing mid-flight is coalesced into one follow-up load', async () => {
    let resolveFirst: ((m: WorktreeSelectorModel) => void) | null = null;
    let call = 0;
    const fetchModel = mock(() => {
      call += 1;
      if (call === 1) {
        return new Promise<WorktreeSelectorModel>((r) => {
          resolveFirst = r;
        });
      }
      return Promise.resolve(model('/repo-revalidated'));
    });
    let fireRevalidate: (() => void) | null = null;
    const subscribeRevalidate = mock((onRevalidate: () => void) => {
      fireRevalidate = onRevalidate;
      return () => {};
    });
    const store = createWorktreeStore({ fetchModel, subscribeRevalidate });
    store.subscribe(() => {});
    await flush();
    // Bootstrap load is in-flight; a focus revalidation lands mid-flight.
    fireRevalidate?.();
    resolveFirst?.(model('/repo'));
    await flush();
    await flush();
    // The queued reload ran once after the first settled — not an unbounded storm.
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()?.mainRoot).toBe('/repo-revalidated');
  });
});
