import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATOMIC_TEMP_PATH_RE } from '@inkeep/open-knowledge-core/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { __setQuiescentOverrideForTests } from './bridge-quiescence.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { contentHash, writeTracker } from './file-watcher.ts';
import * as fsTraced from './fs-traced.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
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

function supersededCounter(): number {
  return getMetrics().persistenceStoreSupersededCount;
}

interface DocStateObservation {
  disk: string;
  reconciledBase: string | undefined;
  docText: string;
}

describe('persistence superseded-store drop — a store that loses the publish race exits without publishing side effects', () => {
  let tmpDir: string;
  let docName: string;
  let docPath: string;
  let document: Y.Doc;
  let durabilityState: DocumentDurabilityState;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let warnings: string[];
  let diskFlushMarkdowns: string[];

  function findEventLines(eventName: string): Array<Record<string, unknown>> {
    const matches: Array<Record<string, unknown>> = [];
    for (const line of warnings) {
      if (!line.includes(`"event":"${eventName}"`)) continue;
      try {
        matches.push(JSON.parse(line) as Record<string, unknown>);
      } catch {}
    }
    return matches;
  }

  function createPersistence(): ReturnType<typeof createPersistenceExtension> {
    return createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
      onDiskFlush: (_docName, _sv, persistedMarkdown) => {
        diskFlushMarkdowns.push(persistedMarkdown);
      },
    });
  }

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-store-superseded-drop-')));
    docName = 'superseded-drop';
    docPath = join(tmpDir, `${docName}.md`);
    document = new Y.Doc();
    durabilityState = new DocumentDurabilityState();
    resetMetrics();
    warnings = [];
    diskFlushMarkdowns = [];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    __setQuiescentOverrideForTests(document, undefined);
    warnSpy.mockRestore();
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

  function observeDocState(): DocStateObservation {
    return {
      disk: readFileSync(docPath, 'utf-8'),
      reconciledBase: durabilityState.getReconciledBase(docName),
      docText: document.getText('source').toString(),
    };
  }

  test('a superseded store leaves the newer bytes published and drops without a disk ack, a write-tracker entry, temp residue, or a kept defer count', async () => {
    const persistence = createPersistence();
    await loadFromDisk(persistence);

    document.transact(() => replaceDocParagraphs(document, STALE_PARAGRAPHS), BROWSER_ORIGIN);
    await queueDeferredStore(persistence, durabilityState, document, docName);
    expect(readFileSync(docPath, 'utf-8')).toBe(INITIAL_CONTENT);
    expect(writeTracker.get(docPath)).toBeUndefined();
    expect(diskFlushMarkdowns).toEqual([]);

    const realMkdir = fsTraced.tracedMkdir;
    let newerStoreRan = false;
    const observations: {
      afterNewerStore?: DocStateObservation;
      deferCountAfterNewerStore?: number;
    } = {};
    vi.spyOn(fsTraced, 'tracedMkdir').mockImplementation(async (path, options) => {
      if (!newerStoreRan) {
        newerStoreRan = true;
        document.transact(() => replaceDocParagraphs(document, NEWER_PARAGRAPHS), BROWSER_ORIGIN);
        await runHookStore(persistence, document, docName);
        __setQuiescentOverrideForTests(document, false);
        await runHookStore(persistence, document, docName);
        __setQuiescentOverrideForTests(document, undefined);
        observations.afterNewerStore = observeDocState();
        observations.deferCountAfterNewerStore = persistence.getQueueDepths().quiescenceDeferred;
        durabilityState.recordStoreFailure(docName, {
          code: 'EIO',
          message: 'recorded store failure that the superseded drop must not clear',
        });
      }
      return realMkdir(path, options);
    });

    const supersededBefore = supersededCounter();

    try {
      await persistence.flushDeferredStores('within-branch');
    } finally {
      vi.restoreAllMocks();
    }

    expect(observations.afterNewerStore).toEqual({
      disk: NEWER_CONTENT,
      reconciledBase: NEWER_CONTENT,
      docText: NEWER_CONTENT,
    });
    expect(observations.deferCountAfterNewerStore).toBe(1);
    expect(readFileSync(docPath, 'utf-8')).toBe(NEWER_CONTENT);
    expect(durabilityState.getReconciledBase(docName)).toBe(NEWER_CONTENT);
    expect(document.getText('source').toString()).toBe(NEWER_CONTENT);

    expect(diskFlushMarkdowns).toEqual([NEWER_CONTENT]);
    expect((writeTracker.get(docPath) ?? []).map((entry) => entry.hash)).toEqual([
      contentHash(NEWER_CONTENT),
    ]);

    const events = findEventLines('persistence-store-superseded');
    expect(events).toHaveLength(1);
    const ev = events[0] as Record<string, unknown>;
    expect(ev.event).toBe('persistence-store-superseded');
    expect(ev['doc.name']).toBe(docName);
    expect(ev.baseBytes).toBe(INITIAL_CONTENT.length);
    expect(ev.candidateBytes).toBe(STALE_CONTENT.length);
    expect(ev.generation).toBe(1);
    expect(Object.keys(ev).sort()).toEqual([
      'baseBytes',
      'candidateBytes',
      'doc.name',
      'event',
      'generation',
    ]);

    expect(supersededCounter() - supersededBefore).toBe(1);
    expect(persistence.getQueueDepths().quiescenceDeferred).toBe(0);
    expect(readdirSync(tmpDir).filter((name) => ATOMIC_TEMP_PATH_RE.test(name))).toEqual([]);
    expect(durabilityState.takeStoreFailure(docName)).toEqual({
      code: 'EIO',
      message: 'recorded store failure that the superseded drop must not clear',
    });
  });

  test('a reentrant store refusal emits its own refusal event, drops without advancing the superseded counter, and still removes the temp file and the defer count', async () => {
    const persistence = createPersistence();
    await loadFromDisk(persistence);

    document.transact(() => replaceDocParagraphs(document, STALE_PARAGRAPHS), BROWSER_ORIGIN);
    __setQuiescentOverrideForTests(document, false);
    await runHookStore(persistence, document, docName);
    __setQuiescentOverrideForTests(document, undefined);
    expect(persistence.getQueueDepths().quiescenceDeferred).toBe(1);

    let deferCountAtDispatch: number | undefined;
    vi.spyOn(durabilityState, 'tryPublishStore').mockImplementation(() => {
      deferCountAtDispatch = persistence.getQueueDepths().quiescenceDeferred;
      return 'reentrant';
    });

    const supersededBefore = supersededCounter();
    await runHookStore(persistence, document, docName);

    const events = findEventLines('persistence-store-reentrant-refused');
    expect(events).toHaveLength(1);
    const ev = events[0] as Record<string, unknown>;
    expect(ev.event).toBe('persistence-store-reentrant-refused');
    expect(ev['doc.name']).toBe(docName);
    expect(ev.generation).toBe(1);
    expect(ev.baseBytes).toBe(INITIAL_CONTENT.length);
    expect(ev.candidateBytes).toBe(STALE_CONTENT.length);
    expect(Object.keys(ev).sort()).toEqual([
      'baseBytes',
      'candidateBytes',
      'doc.name',
      'event',
      'generation',
    ]);

    expect(findEventLines('persistence-store-superseded')).toEqual([]);
    expect(supersededCounter() - supersededBefore).toBe(0);
    expect(deferCountAtDispatch).toBe(1);
    expect(persistence.getQueueDepths().quiescenceDeferred).toBe(0);
    expect(readdirSync(tmpDir).filter((name) => ATOMIC_TEMP_PATH_RE.test(name))).toEqual([]);
  });
});
