import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import { createWorktreeStore } from './worktree-store.ts';

function model(mainRoot: string): WorktreeSelectorModel {
  return { mainRoot, currentBranch: 'main', entries: [], remoteBranches: [] };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createWorktreeStore', () => {
  test('fetches once on first subscribe and caches the snapshot', async () => {
    const fetchModel = vi.fn(() => Promise.resolve(model('/repo')));
    const store = createWorktreeStore({ fetchModel });
    expect(store.getSnapshot()).toBeNull();

    const unsub = store.subscribe(() => {});
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()?.mainRoot).toBe('/repo');

    store.subscribe(() => {});
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(1);
    unsub();
  });

  test('notifies subscribers when the model arrives', async () => {
    const fetchModel = vi.fn(() => Promise.resolve(model('/repo')));
    const store = createWorktreeStore({ fetchModel });
    const listener = vi.fn(() => {});
    store.subscribe(listener);
    await flush();
    expect(listener).toHaveBeenCalled();
  });

  test('refresh re-fetches and updates the snapshot', async () => {
    let next = model('/repo');
    const fetchModel = vi.fn(() => Promise.resolve(next));
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
    const fetchModel = vi.fn(() => Promise.resolve(result));
    const store = createWorktreeStore({ fetchModel });
    store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot()?.mainRoot).toBe('/repo');

    result = null;
    store.refresh();
    await flush();
    expect(store.getSnapshot()?.mainRoot).toBe('/repo');
  });

  test('coalesces a refresh that arrives while the initial load is still in-flight', async () => {
    let resolveFirst: ((m: WorktreeSelectorModel) => void) | null = null;
    let call = 0;
    const fetchModel = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return new Promise<WorktreeSelectorModel>((r) => {
          resolveFirst = r;
        });
      }
      return Promise.resolve(model('/repo-after-create'));
    });
    const store = createWorktreeStore({ fetchModel });
    store.subscribe(() => {});
    await flush();
    store.refresh();
    resolveFirst?.(model('/repo'));
    await flush();
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()?.mainRoot).toBe('/repo-after-create');
  });

  test('a rejected fetch keeps the prior snapshot', async () => {
    let shouldThrow = false;
    const fetchModel = vi.fn(() =>
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
    const fetchModel = vi.fn(() => Promise.resolve(next));
    let fireRevalidate: (() => void) | null = null;
    const subscribeRevalidate = vi.fn((onRevalidate: () => void) => {
      fireRevalidate = onRevalidate;
      return () => {
        fireRevalidate = null;
      };
    });
    const store = createWorktreeStore({ fetchModel, subscribeRevalidate });
    const listener = vi.fn(() => {});
    store.subscribe(listener);
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(subscribeRevalidate).toHaveBeenCalledTimes(1);

    next = model('/repo-with-new-worktree');
    fireRevalidate?.();
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()?.mainRoot).toBe('/repo-with-new-worktree');
  });

  test('attaches the revalidation trigger once and detaches it when the last subscriber leaves', async () => {
    const fetchModel = vi.fn(() => Promise.resolve(model('/repo')));
    let attached = 0;
    let detached = 0;
    const subscribeRevalidate = vi.fn((_onRevalidate: () => void) => {
      attached += 1;
      return () => {
        detached += 1;
      };
    });
    const store = createWorktreeStore({ fetchModel, subscribeRevalidate });

    const unsubA = store.subscribe(() => {});
    const unsubB = store.subscribe(() => {});
    await flush();
    expect(attached).toBe(1);
    expect(detached).toBe(0);

    unsubA();
    expect(detached).toBe(0);

    unsubB();
    expect(detached).toBe(1);
  });

  test('re-attaches the revalidation trigger when a new subscriber arrives after the store went quiet', async () => {
    const fetchModel = vi.fn(() => Promise.resolve(model('/repo')));
    let attached = 0;
    const subscribeRevalidate = vi.fn((_onRevalidate: () => void) => {
      attached += 1;
      return () => {};
    });
    const store = createWorktreeStore({ fetchModel, subscribeRevalidate });

    store.subscribe(() => {})();
    await flush();
    expect(attached).toBe(1);

    store.subscribe(() => {});
    await flush();
    expect(attached).toBe(2);
  });

  test('a revalidation firing mid-flight is coalesced into one follow-up load', async () => {
    let resolveFirst: ((m: WorktreeSelectorModel) => void) | null = null;
    let call = 0;
    const fetchModel = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return new Promise<WorktreeSelectorModel>((r) => {
          resolveFirst = r;
        });
      }
      return Promise.resolve(model('/repo-revalidated'));
    });
    let fireRevalidate: (() => void) | null = null;
    const subscribeRevalidate = vi.fn((onRevalidate: () => void) => {
      fireRevalidate = onRevalidate;
      return () => {};
    });
    const store = createWorktreeStore({ fetchModel, subscribeRevalidate });
    store.subscribe(() => {});
    await flush();
    fireRevalidate?.();
    resolveFirst?.(model('/repo'));
    await flush();
    await flush();
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()?.mainRoot).toBe('/repo-revalidated');
  });
});
