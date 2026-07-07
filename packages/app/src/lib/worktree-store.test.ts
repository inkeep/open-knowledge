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
});
