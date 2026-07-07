/**
 * Unit tests for the schema-incompatibility IPC handlers in
 * `main/update-state-handlers.ts`. The handlers are pure async functions
 * taking dep injections so the composition (persist → clear pending,
 * including saveAppState rollback) can be pinned without an Electron `app`
 * module. The update channel is the build-derived channel
 * (`channelFromVersion(app.getVersion())`) surfaced via the `getBuildChannel`
 * dep on `ok:state:query`.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
  type AppState,
  emptyState,
  type SchemaIncompatibilityDiagnostic,
  type UpdateChannel,
} from '../../src/main/state-store.ts';
import {
  applyResetIncompatible,
  applyStateQuery,
  type UpdateStateHandlerDeps,
} from '../../src/main/update-state-handlers.ts';

interface Rig {
  state: AppState;
  pending: SchemaIncompatibilityDiagnostic | null;
  saveCalls: AppState[];
  saveResult: boolean;
  buildChannel: UpdateChannel;
  clearPendingCalls: number;
  deps: UpdateStateHandlerDeps;
}

function makeRig(overrides?: {
  state?: AppState;
  pending?: SchemaIncompatibilityDiagnostic | null;
  saveResult?: boolean;
  buildChannel?: UpdateChannel;
}): Rig {
  const rig: Rig = {
    state: overrides?.state ?? emptyState(),
    pending: overrides?.pending ?? null,
    saveCalls: [],
    saveResult: overrides?.saveResult ?? true,
    buildChannel: overrides?.buildChannel ?? 'latest',
    clearPendingCalls: 0,
    deps: undefined as unknown as UpdateStateHandlerDeps,
  };
  rig.deps = {
    getAppState: () => rig.state,
    setAppState: (s) => {
      rig.state = s;
    },
    saveAppState: mock((next: AppState) => {
      rig.saveCalls.push(next);
      return rig.saveResult;
    }),
    getBuildChannel: () => rig.buildChannel,
    getPendingSchemaIncompatibility: () => rig.pending,
    clearPendingSchemaIncompatibility: () => {
      rig.clearPendingCalls++;
      rig.pending = null;
    },
  };
  return rig;
}

describe('applyResetIncompatible — happy path', () => {
  test('wipes state to defaults and clears pending', async () => {
    const polluted: AppState = { ...emptyState(), lastOpenedProject: '/tmp/some-project' };
    const rig = makeRig({
      state: polluted,
      pending: { currentBuild: '0.4.0', persistedSchemaVersion: 999, maxSupported: 1 },
    });

    await applyResetIncompatible(rig.deps);

    expect(rig.state).toEqual(emptyState());
    expect(rig.saveCalls).toHaveLength(1);
    expect(rig.clearPendingCalls).toBe(1);
    expect(rig.pending).toBeNull();
  });
});

describe('applyResetIncompatible — saveAppState rollback', () => {
  test('rollback restores prior state and rejects', async () => {
    const before: AppState = { ...emptyState(), lastOpenedProject: '/tmp/p' };
    const rig = makeRig({ state: before, saveResult: false });

    await expect(applyResetIncompatible(rig.deps)).rejects.toThrow(/saveAppState failed/);

    expect(rig.state).toBe(before);
    expect(rig.clearPendingCalls).toBe(0);
  });
});

describe('applyStateQuery', () => {
  test('returns the build channel + null when no pending diagnostic', async () => {
    const rig = makeRig({ buildChannel: 'beta' });
    const snapshot = await applyStateQuery(rig.deps);
    expect(snapshot).toEqual({ channel: 'beta', schemaIncompatibility: null });
  });

  test('reports `latest` for a stable build', async () => {
    const rig = makeRig({ buildChannel: 'latest' });
    const snapshot = await applyStateQuery(rig.deps);
    expect(snapshot.channel).toBe('latest');
  });

  test('returns pending diagnostic when armed', async () => {
    const diagnostic: SchemaIncompatibilityDiagnostic = {
      currentBuild: '0.4.0',
      persistedSchemaVersion: 999,
      maxSupported: 1,
    };
    const rig = makeRig({ pending: diagnostic });
    const snapshot = await applyStateQuery(rig.deps);
    expect(snapshot.schemaIncompatibility).toEqual({
      currentBuild: '0.4.0',
      persistedSchemaVersion: 999,
      maxSupported: 1,
    });
  });
});
