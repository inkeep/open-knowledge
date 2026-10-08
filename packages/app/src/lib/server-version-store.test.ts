import { afterEach, describe, expect, test } from 'vitest';
import {
  __resetServerVersionStoreForTests,
  observeServerVersion,
  type ServerVersionChange,
  subscribeServerVersionChange,
} from './server-version-store';

afterEach(() => {
  __resetServerVersionStoreForTests();
});

function recordChanges(): ServerVersionChange[] {
  const changes: ServerVersionChange[] = [];
  subscribeServerVersionChange((change) => {
    changes.push(change);
  });
  return changes;
}

const loadedFrom = { runtimeVersion: '0.83.1', protocolVersion: 2 };

describe('server version seen by this tab', () => {
  test('the first server version observed is the one the tab loaded from', () => {
    const changes = recordChanges();

    observeServerVersion(loadedFrom);

    expect(changes).toEqual([]);
  });

  test('a restart on the same version is not a change', () => {
    const changes = recordChanges();

    observeServerVersion(loadedFrom);
    observeServerVersion({ ...loadedFrom });

    expect(changes).toEqual([]);
  });

  test('a newer runtime version drifts from the version the tab loaded from', () => {
    const changes = recordChanges();

    observeServerVersion(loadedFrom);
    observeServerVersion({ runtimeVersion: '0.83.2', protocolVersion: 2 });

    expect(changes).toEqual([
      {
        loaded: loadedFrom,
        current: { runtimeVersion: '0.83.2', protocolVersion: 2 },
        drifted: true,
      },
    ]);
  });

  test('an older runtime version drifts too', () => {
    const changes = recordChanges();

    observeServerVersion(loadedFrom);
    observeServerVersion({ runtimeVersion: '0.82.4', protocolVersion: 2 });

    expect(changes.map((c) => c.drifted)).toEqual([true]);
  });

  test('a different protocol on the same runtime version drifts', () => {
    const changes = recordChanges();

    observeServerVersion(loadedFrom);
    observeServerVersion({ runtimeVersion: '0.83.1', protocolVersion: 3 });

    expect(changes.map((c) => c.drifted)).toEqual([true]);
  });

  test('a server that stops reporting its version is a different build', () => {
    const changes = recordChanges();

    observeServerVersion(loadedFrom);
    observeServerVersion({ runtimeVersion: null, protocolVersion: null });

    expect(changes).toEqual([
      {
        loaded: loadedFrom,
        current: { runtimeVersion: null, protocolVersion: null },
        drifted: true,
      },
    ]);
  });

  test('a server that never reports its version never drifts', () => {
    const changes = recordChanges();

    observeServerVersion({ runtimeVersion: null, protocolVersion: null });
    observeServerVersion({ runtimeVersion: null, protocolVersion: null });

    expect(changes).toEqual([]);
  });

  test('repeated refreshes against one drifted server report it once', () => {
    const changes = recordChanges();

    observeServerVersion(loadedFrom);
    const upgraded = { runtimeVersion: '0.83.2', protocolVersion: 2 };
    observeServerVersion(upgraded);
    observeServerVersion({ ...upgraded });
    observeServerVersion({ ...upgraded });

    expect(changes).toHaveLength(1);
  });

  test('a second upgrade is reported again', () => {
    const changes = recordChanges();

    observeServerVersion(loadedFrom);
    observeServerVersion({ runtimeVersion: '0.83.2', protocolVersion: 2 });
    observeServerVersion({ runtimeVersion: '0.84.0', protocolVersion: 2 });

    expect(changes.map((c) => c.current.runtimeVersion)).toEqual(['0.83.2', '0.84.0']);
  });

  test('going back to the loaded version reports the tab in sync again', () => {
    const changes = recordChanges();

    observeServerVersion(loadedFrom);
    observeServerVersion({ runtimeVersion: '0.83.2', protocolVersion: 2 });
    observeServerVersion(loadedFrom);

    expect(changes.map((c) => c.drifted)).toEqual([true, false]);
  });

  test('unsubscribing stops delivery', () => {
    const changes: ServerVersionChange[] = [];
    const unsubscribe = subscribeServerVersionChange((change) => {
      changes.push(change);
    });
    unsubscribe();

    observeServerVersion(loadedFrom);
    observeServerVersion({ runtimeVersion: '0.83.2', protocolVersion: 2 });

    expect(changes).toEqual([]);
  });
});
