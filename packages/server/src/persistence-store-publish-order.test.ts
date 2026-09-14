import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { DocumentDurabilityState } from './document-durability-state.ts';
import * as fsTraced from './fs-traced.ts';
import { getMetrics } from './metrics.ts';
import { createPersistenceExtension } from './persistence.ts';
import {
  BROWSER_ORIGIN,
  queueDeferredStore,
  replaceDocParagraphs,
  runHookStore,
} from './persistence-store-overlap.test-helper.ts';

const STALE_PARAGRAPHS = ['alpha'];
const STALE_CONTENT = 'alpha\n';
const NEWER_PARAGRAPHS = ['beta'];
const NEWER_CONTENT = 'beta\n';
const INITIAL_CONTENT = 'initial\n';

type NewerStoreVia = 'hook' | 'forceStore';
type StaleStoreVia = 'drain' | 'hook' | 'forceStore';

const OVERLAPPING_STORE_PAIRS: ReadonlyArray<{
  staleVia: StaleStoreVia;
  newerVia: NewerStoreVia;
}> = [
  { staleVia: 'drain', newerVia: 'hook' },
  { staleVia: 'drain', newerVia: 'forceStore' },
  { staleVia: 'hook', newerVia: 'forceStore' },
  { staleVia: 'forceStore', newerVia: 'hook' },
];

interface DocStateObservation {
  disk: string;
  reconciledBase: string | undefined;
  docText: string;
}

describe('persistence publish ordering — a store must not publish bytes older than a completed store', () => {
  let tmpDir: string;
  let docName: string;
  let docPath: string;
  let document: Y.Doc;
  let durabilityState: DocumentDurabilityState;

  function createPersistence(): ReturnType<typeof createPersistenceExtension> {
    return createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
    });
  }

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-store-publish-order-')));
    docName = 'publish-order';
    docPath = join(tmpDir, `${docName}.md`);
    document = new Y.Doc();
    durabilityState = new DocumentDurabilityState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadFromDisk(
    persistence: ReturnType<typeof createPersistenceExtension>,
  ): Promise<void> {
    writeFileSync(docPath, INITIAL_CONTENT, 'utf-8');
    await persistence.extension.onLoadDocument?.({
      document,
      documentName: docName,
      context: {},
    } as never);
    expect(durabilityState.getReconciledBase(docName)).toBe(INITIAL_CONTENT);
  }

  function observeDocState(docNameForBase: string): DocStateObservation {
    return {
      disk: readFileSync(docPath, 'utf-8'),
      reconciledBase: durabilityState.getReconciledBase(docNameForBase),
      docText: document.getText('source').toString(),
    };
  }

  function interleaveNewerStoreInsideStaleStoreMkdir(
    persistence: ReturnType<typeof createPersistenceExtension>,
    newerVia: NewerStoreVia,
    observations: { afterNewerStore?: DocStateObservation },
  ): void {
    const realMkdir = fsTraced.tracedMkdir;
    let newerStoreRan = false;
    vi.spyOn(fsTraced, 'tracedMkdir').mockImplementation(async (path, options) => {
      if (!newerStoreRan) {
        newerStoreRan = true;
        document.transact(() => replaceDocParagraphs(document, NEWER_PARAGRAPHS), BROWSER_ORIGIN);
        if (newerVia === 'hook') {
          await runHookStore(persistence, document, docName);
        } else {
          await persistence.forceStore(document, docName);
        }
        observations.afterNewerStore = observeDocState(docName);
      }
      return realMkdir(path, options);
    });
  }

  test.each(OVERLAPPING_STORE_PAIRS)(
    'a late $staleVia store whose capture predates a completed $newerVia publish leaves the newer bytes on disk and in the reconciled base',
    async ({ staleVia, newerVia }) => {
      const persistence = createPersistence();
      await loadFromDisk(persistence);

      document.transact(() => replaceDocParagraphs(document, STALE_PARAGRAPHS), BROWSER_ORIGIN);
      if (staleVia === 'drain') {
        await queueDeferredStore(persistence, durabilityState, document, docName);
        expect(readFileSync(docPath, 'utf-8')).toBe(INITIAL_CONTENT);
      }

      const observations: { afterNewerStore?: DocStateObservation } = {};
      interleaveNewerStoreInsideStaleStoreMkdir(persistence, newerVia, observations);
      const supersededBefore = getMetrics().persistenceStoreSupersededCount;

      try {
        if (staleVia === 'drain') {
          await persistence.flushDeferredStores('within-branch');
        } else if (staleVia === 'forceStore') {
          await persistence.forceStore(document, docName);
        } else {
          await runHookStore(persistence, document, docName);
        }
      } finally {
        vi.restoreAllMocks();
      }

      expect(observations.afterNewerStore).toEqual({
        disk: NEWER_CONTENT,
        reconciledBase: NEWER_CONTENT,
        docText: NEWER_CONTENT,
      });
      expect(readFileSync(docPath, 'utf-8')).toBe(NEWER_CONTENT);
      expect(durabilityState.getReconciledBase(docName)).toBe(NEWER_CONTENT);
      expect(document.getText('source').toString()).toBe(NEWER_CONTENT);
      expect(durabilityState.inFlightFlushCount(docName)).toBe(0);
      expect(getMetrics().persistenceStoreSupersededCount).toBe(supersededBefore + 1);
    },
  );

  test('a store whose capture is still the newest published when it lands is not dropped', async () => {
    const persistence = createPersistence();
    await loadFromDisk(persistence);

    document.transact(() => replaceDocParagraphs(document, STALE_PARAGRAPHS), BROWSER_ORIGIN);
    await queueDeferredStore(persistence, durabilityState, document, docName);
    expect(readFileSync(docPath, 'utf-8')).toBe(INITIAL_CONTENT);

    const realMkdir = fsTraced.tracedMkdir;
    let docEditedInFlight = false;
    vi.spyOn(fsTraced, 'tracedMkdir').mockImplementation(async (path, options) => {
      if (!docEditedInFlight) {
        docEditedInFlight = true;
        document.transact(() => replaceDocParagraphs(document, NEWER_PARAGRAPHS), BROWSER_ORIGIN);
      }
      return realMkdir(path, options);
    });

    try {
      await persistence.flushDeferredStores('within-branch');
    } finally {
      vi.restoreAllMocks();
    }

    expect(docEditedInFlight).toBe(true);
    expect(readFileSync(docPath, 'utf-8')).toBe(STALE_CONTENT);
    expect(durabilityState.getReconciledBase(docName)).toBe(STALE_CONTENT);
    expect(document.getText('source').toString()).toBe(NEWER_CONTENT);

    await runHookStore(persistence, document, docName);
    expect(readFileSync(docPath, 'utf-8')).toBe(NEWER_CONTENT);
    expect(durabilityState.getReconciledBase(docName)).toBe(NEWER_CONTENT);
  });
});
