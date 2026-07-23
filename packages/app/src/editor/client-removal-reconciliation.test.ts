import { describe, expect, test } from 'vitest';
import {
  type ClientRemovalReconciliationPorts,
  createClientRemovalReconciler,
} from './client-removal-reconciliation';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createPorts(
  options: {
    activePoolDocName?: string | null;
    pooledDocNames?: readonly string[];
    deferredClears?: boolean;
    remapActiveTarget?: boolean;
    clearRejects?: boolean;
  } = {},
) {
  const log: string[] = [];
  let activePoolDocName = options.activePoolDocName ?? null;
  const clearDeferred = new Map<string, ReturnType<typeof deferred>>();
  const ports: ClientRemovalReconciliationPorts = {
    captureRenameSnapshots: (renamed) =>
      log.push(
        `capture:${renamed.map((entry) => `${entry.fromDocName}>${entry.toDocName}`).join(',')}`,
      ),
    getActivePoolDocName: () => activePoolDocName,
    hasPooledDocument: (docName) => (options.pooledDocNames ?? []).includes(docName),
    closeAndClear: (docName) => {
      log.push(`clear:start:${docName}`);
      if (options.clearRejects) return Promise.reject(new Error('clear failed'));
      if (!options.deferredClears) {
        if (activePoolDocName === docName) activePoolDocName = null;
        log.push(`clear:end:${docName}`);
        return Promise.resolve();
      }
      const pending = deferred();
      clearDeferred.set(docName, pending);
      pending.promise.then(() => {
        if (activePoolDocName === docName) activePoolDocName = null;
        log.push(`clear:end:${docName}`);
      });
      return pending.promise;
    },
    openAndActivate: (docName) => {
      activePoolDocName = docName;
      log.push(`open:${docName}`);
    },
    remapTabs: ({ renamed }) =>
      log.push(
        `remap:${renamed.map((entry) => `${entry.fromDocName}>${entry.toDocName}`).join(',')}`,
      ),
    closeTabs: (tabIds) => log.push(`close-tabs:${tabIds.join(',')}`),
    removeDocumentTab: (docName) => log.push(`remove-tab:${docName}`),
    remapActiveTargetForRename: (fromDocName, toDocName) => {
      log.push(`remap-target:${fromDocName}>${toDocName}`);
      return options.remapActiveTarget ?? false;
    },
    clearActiveTargetForRemoval: (docName) => log.push(`clear-target:${docName}`),
    navigateToDocument: (docName) => log.push(`navigate:${docName}`),
    navigateHome: () => log.push('navigate:home'),
  };
  return { clearDeferred, log, reconciler: createClientRemovalReconciler(ports) };
}

describe('ClientRemovalReconciler', () => {
  test('captures local rename before clears and remaps after every clear settles', async () => {
    const { clearDeferred, log, reconciler } = createPorts({
      pooledDocNames: ['to'],
      deferredClears: true,
    });
    const reconcile = reconciler.reconcileLocalRename({
      renamed: [{ fromDocName: 'from', toDocName: 'to' }],
    });
    expect(log).toEqual(['capture:from>to', 'clear:start:from', 'clear:start:to']);
    clearDeferred.get('from')?.resolve();
    await Promise.resolve();
    expect(log).not.toContain('remap:from>to');
    clearDeferred.get('to')?.resolve();
    await reconcile;
    expect(log).toEqual([
      'capture:from>to',
      'clear:start:from',
      'clear:start:to',
      'clear:end:from',
      'clear:end:to',
      'remap:from>to',
    ]);
  });

  test('clears both local rename ends when the destination is pooled', async () => {
    const { log, reconciler } = createPorts({ activePoolDocName: 'from', pooledDocNames: ['to'] });
    await reconciler.reconcileLocalRename({ renamed: [{ fromDocName: 'from', toDocName: 'to' }] });
    expect(log).toEqual([
      'capture:from>to',
      'clear:start:from',
      'clear:end:from',
      'clear:start:to',
      'clear:end:to',
      'remap:from>to',
    ]);
  });

  test('clears only the source when auth already reopened the destination', async () => {
    const { log, reconciler } = createPorts({ activePoolDocName: 'to', pooledDocNames: ['to'] });
    await reconciler.reconcileLocalRename({ renamed: [{ fromDocName: 'from', toDocName: 'to' }] });
    expect(log).toEqual(['capture:from>to', 'clear:start:from', 'clear:end:from', 'remap:from>to']);
  });

  test('clears only the source when the local destination was never pooled', async () => {
    const { log, reconciler } = createPorts();
    await reconciler.reconcileLocalRename({ renamed: [{ fromDocName: 'from', toDocName: 'to' }] });
    expect(log).toEqual(['capture:from>to', 'clear:start:from', 'clear:end:from', 'remap:from>to']);
  });

  test('dedupes multiple local mappings and additional removals', async () => {
    const { log, reconciler } = createPorts({ pooledDocNames: ['b', 'c'] });
    await reconciler.reconcileLocalRename({
      renamed: [
        { fromDocName: 'a', toDocName: 'b' },
        { fromDocName: 'b', toDocName: 'c' },
      ],
      additionalRemovedDocNames: ['a', 'c', 'asset-source'],
    });
    expect(log.filter((entry) => entry.startsWith('clear:start:'))).toEqual([
      'clear:start:a',
      'clear:start:b',
      'clear:start:c',
      'clear:start:asset-source',
    ]);
  });

  test('remaps local rename tabs without provider state', async () => {
    const { log, reconciler } = createPorts();
    await reconciler.reconcileLocalRename({
      renamed: [],
      renamedFolders: [{ fromPath: 'a', toPath: 'b' }],
    });
    expect(log).toEqual(['capture:', 'remap:']);
  });

  test('force-closes local removal tabs before deduped persistence clears', async () => {
    const { log, reconciler } = createPorts();
    await reconciler.reconcileLocalRemoval({
      tabIdsToClose: ['from', 'folder:old'],
      docNamesToClear: ['from', 'from', 'other'],
    });
    expect(log).toEqual([
      'close-tabs:from,folder:old',
      'clear:start:from',
      'clear:end:from',
      'clear:start:other',
      'clear:end:other',
    ]);
  });

  test('auth rename snapshots, clears, reopens, remaps, and navigates in order', async () => {
    const { clearDeferred, log, reconciler } = createPorts({
      activePoolDocName: 'from',
      deferredClears: true,
      remapActiveTarget: true,
    });
    const reconcile = reconciler.reconcileAuthRename({ fromDocName: 'from', toDocName: 'to' });
    expect(log).toEqual(['capture:from>to', 'clear:start:from', 'clear:start:to']);
    clearDeferred.get('from')?.resolve();
    clearDeferred.get('to')?.resolve();
    await reconcile;
    expect(log.slice(-4)).toEqual([
      'open:to',
      'remap:from>to',
      'remap-target:from>to',
      'navigate:to',
    ]);
  });

  test('auth rename of an inactive source does not reopen or navigate', async () => {
    const { log, reconciler } = createPorts({ activePoolDocName: 'other' });
    await reconciler.reconcileAuthRename({ fromDocName: 'from', toDocName: 'to' });
    expect(log).not.toContain('open:to');
    expect(log).not.toContain('navigate:to');
  });

  test('auth rename navigates when only the active target is remapped', async () => {
    const { log, reconciler } = createPorts({
      activePoolDocName: 'other',
      remapActiveTarget: true,
    });
    await reconciler.reconcileAuthRename({ fromDocName: 'from', toDocName: 'to' });
    expect(log).not.toContain('open:to');
    expect(log).toContain('remap-target:from>to');
    expect(log).toContain('navigate:to');
  });

  test('auth removal navigates home from the pre-teardown active snapshot', async () => {
    const { log, reconciler } = createPorts({ activePoolDocName: 'deleted' });
    await reconciler.reconcileAuthRemoval({ docName: 'deleted' });
    expect(log).toEqual([
      'clear:start:deleted',
      'clear:end:deleted',
      'remove-tab:deleted',
      'clear-target:deleted',
      'navigate:home',
    ]);
  });

  test('auth removal of an inactive document leaves unrelated navigation intact', async () => {
    const { log, reconciler } = createPorts({ activePoolDocName: 'other' });
    await reconciler.reconcileAuthRemoval({ docName: 'deleted' });
    expect(log).not.toContain('navigate:home');
    expect(log).toContain('remove-tab:deleted');
  });

  test('propagates adapter failures without remapping or navigating afterward', async () => {
    const { log, reconciler } = createPorts({ clearRejects: true });
    await expect(
      reconciler.reconcileAuthRename({ fromDocName: 'from', toDocName: 'to' }),
    ).rejects.toThrow('clear failed');
    expect(log).not.toContain('remap:from>to');
    expect(log).not.toContain('navigate:to');
  });

  test('propagates local rename failures before remapping', async () => {
    const { log, reconciler } = createPorts({
      pooledDocNames: ['to'],
      clearRejects: true,
    });
    await expect(
      reconciler.reconcileLocalRename({
        renamed: [{ fromDocName: 'from', toDocName: 'to' }],
      }),
    ).rejects.toThrow('clear failed');
    expect(log).not.toContain('remap:from>to');
  });

  test('propagates local removal cleanup failures after closing tabs', async () => {
    const { log, reconciler } = createPorts({ clearRejects: true });
    await expect(
      reconciler.reconcileLocalRemoval({
        tabIdsToClose: ['from'],
        docNamesToClear: ['from'],
      }),
    ).rejects.toThrow('clear failed');
    expect(log).toEqual(['close-tabs:from', 'clear:start:from']);
  });

  test('propagates auth removal failures without navigating', async () => {
    const { log, reconciler } = createPorts({
      activePoolDocName: 'deleted',
      clearRejects: true,
    });
    await expect(reconciler.reconcileAuthRemoval({ docName: 'deleted' })).rejects.toThrow(
      'clear failed',
    );
    expect(log).not.toContain('navigate:home');
  });
});
