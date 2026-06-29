import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { HocuspocusAuthRejection, LINEAGE_EPOCH_KEY } from './auth-token-schema.ts';
import { type DocLineageGuardDeps, runDocLineageGuard } from './doc-lineage-guard.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

const docs: Y.Doc[] = [];

function liveDoc(epoch?: unknown): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  if (epoch !== undefined) {
    doc.getMap('lifecycle').set(LINEAGE_EPOCH_KEY, epoch);
  }
  return doc;
}

function depsFor(doc: Y.Doc | undefined): DocLineageGuardDeps {
  return { getLoadedDoc: () => doc };
}

function expectRejection(fn: () => void): HocuspocusAuthRejection {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(HocuspocusAuthRejection);
  return caught as HocuspocusAuthRejection;
}

beforeEach(() => {
  resetMetrics();
});

afterEach(() => {
  while (docs.length > 0) {
    docs.pop()?.destroy();
  }
  resetMetrics();
});

describe('runDocLineageGuard', () => {
  test('admits absent and empty claims unconditionally, even for unloaded docs', () => {
    expect(() => runDocLineageGuard('notes/a', undefined, depsFor(undefined))).not.toThrow();
    expect(() => runDocLineageGuard('notes/a', '', depsFor(undefined))).not.toThrow();
  });

  test('short-circuits system and config docs before any doc lookup', () => {
    const deps: DocLineageGuardDeps = {
      getLoadedDoc: () => {
        throw new Error('must not be consulted for synthetic docs');
      },
    };
    expect(() => runDocLineageGuard('__system__', 'epoch-1', deps)).not.toThrow();
    expect(() => runDocLineageGuard('__config__/project', 'epoch-1', deps)).not.toThrow();
    expect(() => runDocLineageGuard('__user__/config.yml', 'epoch-1', deps)).not.toThrow();
  });

  test('rejects a claim against an unloaded doc (stale by construction)', () => {
    const err = expectRejection(() => runDocLineageGuard('notes/a', 'epoch-1', depsFor(undefined)));
    expect(err.kind).toBe('doc-lineage-mismatch');
    expect(err.payload).toBeUndefined();
    expect(err.reason).toBe('doc-lineage-mismatch');
  });

  test('rejects when the live doc carries no epoch', () => {
    const err = expectRejection(() => runDocLineageGuard('notes/a', 'epoch-1', depsFor(liveDoc())));
    expect(err.kind).toBe('doc-lineage-mismatch');
  });

  test('rejects when the live epoch is the empty string and a claim is present', () => {
    const err = expectRejection(() =>
      runDocLineageGuard('notes/a', 'epoch-1', depsFor(liveDoc(''))),
    );
    expect(err.kind).toBe('doc-lineage-mismatch');
  });

  test('rejects when the live epoch differs from the claim', () => {
    const err = expectRejection(() =>
      runDocLineageGuard('notes/a', 'epoch-old', depsFor(liveDoc('epoch-new'))),
    );
    expect(err.kind).toBe('doc-lineage-mismatch');
  });

  test('rejects when the live epoch is present but not a string', () => {
    const err = expectRejection(() => runDocLineageGuard('notes/a', '42', depsFor(liveDoc(42))));
    expect(err.kind).toBe('doc-lineage-mismatch');
  });

  test('admits when the claim matches the live epoch exactly', () => {
    expect(() =>
      runDocLineageGuard('notes/a', 'epoch-1', depsFor(liveDoc('epoch-1'))),
    ).not.toThrow();
  });

  test('admits (fail-open) when the dependency throws unexpectedly', () => {
    const deps: DocLineageGuardDeps = {
      getLoadedDoc: () => {
        throw new Error('synthetic registry failure');
      },
    };
    expect(() => runDocLineageGuard('notes/a', 'epoch-1', deps)).not.toThrow();
  });

  test('increments the mismatch counter on each rejection arm', () => {
    expectRejection(() => runDocLineageGuard('notes/a', 'epoch-1', depsFor(undefined)));
    expect(getMetrics().authDocLineageMismatchCount).toBe(1);
    expectRejection(() =>
      runDocLineageGuard('notes/a', 'epoch-old', depsFor(liveDoc('epoch-new'))),
    );
    expect(getMetrics().authDocLineageMismatchCount).toBe(2);
    expect(getMetrics().authDocLineageGuardErrors).toBe(0);
  });

  test('does not increment any counter on admits (absent claim, synthetic doc, exact match)', () => {
    runDocLineageGuard('notes/a', undefined, depsFor(undefined));
    runDocLineageGuard('__system__', 'epoch-1', depsFor(undefined));
    runDocLineageGuard('notes/a', 'epoch-1', depsFor(liveDoc('epoch-1')));
    expect(getMetrics().authDocLineageMismatchCount).toBe(0);
    expect(getMetrics().authDocLineageGuardErrors).toBe(0);
  });

  test('increments the guard-error counter on fail-open, not the mismatch counter', () => {
    const deps: DocLineageGuardDeps = {
      getLoadedDoc: () => {
        throw new Error('synthetic registry failure');
      },
    };
    runDocLineageGuard('notes/a', 'epoch-1', deps);
    expect(getMetrics().authDocLineageGuardErrors).toBe(1);
    expect(getMetrics().authDocLineageMismatchCount).toBe(0);
  });

  test('HocuspocusAuthRejection rethrow path does NOT increment the guard-error counter', () => {
    expectRejection(() => runDocLineageGuard('notes/a', 'epoch-1', depsFor(undefined)));
    expect(getMetrics().authDocLineageGuardErrors).toBe(0);
  });
});

test('LINEAGE_EPOCH_KEY wire value is stable', () => {
  expect(LINEAGE_EPOCH_KEY).toBe('epoch');
});
