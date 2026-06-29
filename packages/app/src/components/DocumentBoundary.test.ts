
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { __resetSyncPromiseCache, syncPromise } from '@/editor/sync-promise';
import { DocumentBoundary } from './DocumentBoundary';

const DUMMY_WS = 'ws://localhost:1/collab';

function makeProvider(docName: string): HocuspocusProvider {
  return new HocuspocusProvider({ url: DUMMY_WS, name: docName });
}

let providers: HocuspocusProvider[] = [];
function track<T extends HocuspocusProvider>(p: T): T {
  providers.push(p);
  return p;
}

beforeEach(() => {
  __resetSyncPromiseCache();
  providers = [];
});

afterEach(() => {
  __resetSyncPromiseCache();
  for (const p of providers) {
    try {
      p.destroy();
    } catch {
    }
  }
  providers = [];
});

describe('DocumentBoundary', () => {
  test('is a function (React component)', () => {
    expect(typeof DocumentBoundary).toBe('function');
  });

  test('syncPromise contract — same (docName, provider) returns stable reference (StrictMode double-invoke safe)', () => {
    const provider = track(makeProvider('doc-a'));
    const first = syncPromise('doc-a', provider);
    const second = syncPromise('doc-a', provider);
    expect(second).toBe(first);
  });

  test('syncPromise contract — different docNames produce distinct promises', () => {
    const a = track(makeProvider('doc-a'));
    const b = track(makeProvider('doc-b'));
    const pa = syncPromise('doc-a', a);
    const pb = syncPromise('doc-b', b);
    expect(pa).not.toBe(pb);
  });
});
