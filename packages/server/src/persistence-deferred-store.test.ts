import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeInvariantViolationError } from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { __setQuiescentOverrideForTests } from './bridge-quiescence.ts';
import * as fsTraced from './fs-traced.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import {
  classifyDeferredStoreError,
  createPersistenceExtension,
  getReconciledBase,
  setBatchInProgress,
  switchReconciledBaseScope,
} from './persistence.ts';

const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test' } },
};

function replaceDocParagraph(document: Y.Doc, text: string): void {
  replaceDocParagraphs(document, [text]);
}

/**
 * Mutates BOTH the XmlFragment and Y.Text under the same transaction so the
 * Y.Text-is-truth contract sees consistent state. In a real server,
 * Observer A would mirror fragment → ytext after a browser-origin write;
 * these tests don't wire up the observer bridge, so the helper has to
 * produce both sides itself.
 *
 * The body bytes match `mdManager.serialize(parse(body))` for paragraph
 * blocks: "para 1\n\npara 2\n" — newline-separated with trailing newline.
 * That keeps the bridge invariant comparator happy on the persistence
 * pre-write sanity check and satisfies the markdownSemanticallyUnchanged
 * gate's normalizeBridge comparison against reconciledBase.
 */
function replaceDocParagraphs(document: Y.Doc, texts: string[]): void {
  const body = `${texts.join('\n\n')}\n`;
  const fragment = document.getXmlFragment('default');
  const ytext = document.getText('source');
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }
  fragment.insert(
    0,
    texts.map((text) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(text)]);
      return paragraph;
    }),
  );
  if (ytext.length > 0) {
    ytext.delete(0, ytext.length);
  }
  ytext.insert(0, body);
}

async function loadDocument(
  persistence: ReturnType<typeof createPersistenceExtension>,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  await persistence.extension.onLoadDocument?.({
    document,
    documentName,
    context: {},
  } as never);
}

async function storeDocument(
  persistence: ReturnType<typeof createPersistenceExtension>,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  await persistence.extension.onStoreDocument?.({
    document,
    documentName,
    lastTransactionOrigin: BROWSER_ORIGIN,
    lastContext: {},
  } as never);
}

describe('batch-gated L1 persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-deferred-store-'));
    mkdirSync(tmpDir, { recursive: true });
    setBatchInProgress(false);
    switchReconciledBaseScope('main');
  });

  afterEach(() => {
    setBatchInProgress(false);
    switchReconciledBaseScope('main');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('defers browser-style stores during a batch and drains them after batch end', async () => {
    const docName = 'batch-edit';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');
    const acks: Array<{ docName: string; sv: Uint8Array }> = [];
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      onDiskFlush: (name, sv) => acks.push({ docName: name, sv }),
    });
    const document = new Y.Doc();

    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraph(document, 'queued edit'), BROWSER_ORIGIN);

    setBatchInProgress(true);
    await storeDocument(persistence, document, docName);

    expect(readFileSync(docPath, 'utf-8')).toBe('initial\n');
    expect(acks).toHaveLength(0);

    setBatchInProgress(false);
    await persistence.flushDeferredStores('within-branch');

    expect(readFileSync(docPath, 'utf-8')).toContain('queued edit');
    expect(acks).toHaveLength(1);
    expect(acks[0]?.docName).toBe(docName);

    document.destroy();
  });

  test('disk flush callback receives previous and persisted markdown', async () => {
    const docName = 'flush-payload';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');
    const flushes: Array<{
      docName: string;
      sv: Uint8Array;
      persistedMarkdown: string;
      previousMarkdown: string | null;
    }> = [];
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      onDiskFlush: (name, sv, persistedMarkdown, previousMarkdown) =>
        flushes.push({ docName: name, sv, persistedMarkdown, previousMarkdown }),
    });
    const document = new Y.Doc();

    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraph(document, 'edited'), BROWSER_ORIGIN);
    await storeDocument(persistence, document, docName);

    expect(readFileSync(docPath, 'utf-8')).toBe('edited\n');
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.docName).toBe(docName);
    expect(flushes[0]?.sv).toBeInstanceOf(Uint8Array);
    expect(flushes[0]?.previousMarkdown).toBe('initial\n');
    expect(flushes[0]?.persistedMarkdown).toBe('edited\n');

    document.destroy();
  });

  test('within-branch no-disk-event batches do not strand queued stores', async () => {
    const docName = 'index-lock-noise';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'clean\n', 'utf-8');
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    const document = new Y.Doc();

    await loadDocument(persistence, document, docName);
    document.transact(
      () => replaceDocParagraph(document, 'dirty after index lock'),
      BROWSER_ORIGIN,
    );

    setBatchInProgress(true);
    await storeDocument(persistence, document, docName);
    setBatchInProgress(false);
    await persistence.flushDeferredStores('within-branch');

    expect(readFileSync(docPath, 'utf-8')).toContain('dirty after index lock');

    document.destroy();
  });

  test('within-branch flush continues after one deferred store fails', async () => {
    const badDocName = 'deferred-bad';
    const goodDocName = 'deferred-good';
    mkdirSync(join(tmpDir, `${badDocName}.md`));
    const goodPath = join(tmpDir, `${goodDocName}.md`);
    writeFileSync(goodPath, 'good base\n', 'utf-8');
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    const badDoc = new Y.Doc();
    const goodDoc = new Y.Doc();

    badDoc.transact(() => replaceDocParagraph(badDoc, 'bad queued edit'), BROWSER_ORIGIN);
    await loadDocument(persistence, goodDoc, goodDocName);
    goodDoc.transact(() => replaceDocParagraph(goodDoc, 'good queued edit'), BROWSER_ORIGIN);

    setBatchInProgress(true);
    await storeDocument(persistence, badDoc, badDocName);
    await storeDocument(persistence, goodDoc, goodDocName);
    setBatchInProgress(false);

    await expect(persistence.flushDeferredStores('within-branch')).resolves.toBeUndefined();
    expect(readFileSync(goodPath, 'utf-8')).toContain('good queued edit');

    badDoc.destroy();
    goodDoc.destroy();
  });

  test('tripwire reset failure breaker only suppresses duplicate reset retries', async () => {
    const docName = 'tripwire-reset-failed';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'base\n', 'utf-8');
    let resetAttempts = 0;
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      applyDiskContentToDoc: () => {
        resetAttempts += 1;
        throw new Error('synthetic reset failure');
      },
    });
    const document = new Y.Doc();

    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraphs(document, ['base', 'base']), BROWSER_ORIGIN);

    await storeDocument(persistence, document, docName);
    expect(resetAttempts).toBe(1);
    expect(readFileSync(docPath, 'utf-8')).toBe('base\n');

    await storeDocument(persistence, document, docName);
    expect(resetAttempts).toBe(1);
    expect(readFileSync(docPath, 'utf-8')).toBe('base\n');

    document.transact(() => replaceDocParagraph(document, 'recovered edit'), BROWSER_ORIGIN);
    await storeDocument(persistence, document, docName);
    expect(readFileSync(docPath, 'utf-8')).toContain('recovered edit');

    document.destroy();
  });

  test('stale deferred stores are discarded across branch changes', async () => {
    const docName = 'branch-protected';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'branch A base\n', 'utf-8');
    const acks: Array<{ docName: string; sv: Uint8Array }> = [];
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      onDiskFlush: (name, sv) => acks.push({ docName: name, sv }),
    });
    const document = new Y.Doc();

    switchReconciledBaseScope('branch-a');
    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraph(document, 'old branch edit'), BROWSER_ORIGIN);

    setBatchInProgress(true);
    await storeDocument(persistence, document, docName);
    expect(readFileSync(docPath, 'utf-8')).toBe('branch A base\n');

    writeFileSync(docPath, 'target branch content\n', 'utf-8');
    switchReconciledBaseScope('branch-b');
    setBatchInProgress(false);
    await persistence.flushDeferredStores('discard-stale');

    expect(readFileSync(docPath, 'utf-8')).toBe('target branch content\n');
    expect(acks).toHaveLength(0);

    document.destroy();
  });

  test('concurrent discard-stale flush wins over an in-flight within-branch drain', async () => {
    const firstDocName = 'first-queued';
    const secondDocName = 'second-stale';
    const firstPath = join(tmpDir, `${firstDocName}.md`);
    const secondPath = join(tmpDir, `${secondDocName}.md`);
    writeFileSync(firstPath, 'first base\n', 'utf-8');
    writeFileSync(secondPath, 'second base\n', 'utf-8');

    const firstDoc = new Y.Doc();
    const secondDoc = new Y.Doc();
    let queuedSecondStore = false;
    let discardFlush: Promise<void> | undefined;

    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      onDiskFlush: (docName) => {
        if (docName !== firstDocName || queuedSecondStore) return;
        queuedSecondStore = true;

        setBatchInProgress(true);
        void storeDocument(persistence, secondDoc, secondDocName);
        setBatchInProgress(false);
        discardFlush = persistence.flushDeferredStores('discard-stale');
      },
    });

    await loadDocument(persistence, firstDoc, firstDocName);
    await loadDocument(persistence, secondDoc, secondDocName);
    firstDoc.transact(() => replaceDocParagraph(firstDoc, 'first queued edit'), BROWSER_ORIGIN);
    secondDoc.transact(() => replaceDocParagraph(secondDoc, 'second stale edit'), BROWSER_ORIGIN);

    setBatchInProgress(true);
    await storeDocument(persistence, firstDoc, firstDocName);
    setBatchInProgress(false);

    await persistence.flushDeferredStores('within-branch');
    await discardFlush;

    expect(queuedSecondStore).toBe(true);
    expect(readFileSync(firstPath, 'utf-8')).toContain('first queued edit');
    expect(readFileSync(secondPath, 'utf-8')).toBe('second base\n');

    firstDoc.destroy();
    secondDoc.destroy();
  });
});

describe('quiescence gate — deferCount cleanup on disk-write error', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-defer-disk-error-'));
    mkdirSync(tmpDir, { recursive: true });
    setBatchInProgress(false);
    switchReconciledBaseScope('main');
  });

  afterEach(() => {
    setBatchInProgress(false);
    switchReconciledBaseScope('main');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('disk-write error in force-flush path resets deferCount so next cycle resumes the gate', async () => {
    // Regression: when the quiescence gate force-flushes (deferCount >=
    // QUIESCENCE_MAX_DEFER) and tracedRename throws, the cleanup at
    // `persistenceDeferCounts.delete(documentName)` is unreachable
    // — the catch re-throws past it. Without explicit cleanup in the catch,
    // every subsequent cycle sees deferCount stuck and force-flushes again,
    // emitting `persistence-force-flush-during-burst` in a loop instead of
    // resuming normal gate semantics on the next cycle.
    const docName = 'force-flush-disk-error';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');

    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    const document = new Y.Doc();

    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraph(document, 'edited body'), BROWSER_ORIGIN);

    // Pin the gate to non-quiescent so each store cycle defers (or, after the
    // cap, force-flushes). Yjs's afterAllTransactions fires synchronously
    // after every drain, so a naturally non-quiescent moment doesn't survive
    // event-loop ticks — the override is the only way to drive the
    // force-flush path from a single-loop test.
    __setQuiescentOverrideForTests(document, false);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      // QUIESCENCE_MAX_DEFER is 8 in persistence.ts. Stores 1..8 take the
      // skip path (deferCount increments from 0 → 8). Each emits a structured
      // persistence-skip-non-quiescent telemetry event.
      for (let i = 0; i < 8; i++) {
        await storeDocument(persistence, document, docName);
      }
      const skipsBeforeFlush = warnings.filter((w) =>
        w.includes('"event":"persistence-skip-non-quiescent"'),
      ).length;
      expect(skipsBeforeFlush).toBe(8);

      // 9th store: deferCount=8, NOT < 8 → falls through to force-flush.
      // Make tracedRename fail by replacing the doc file with a directory at
      // the same path. realpath/mkdir/write succeed, but rename(file → dir)
      // fails with EISDIR/EEXIST. The catch re-throws the error.
      rmSync(docPath, { force: true });
      mkdirSync(docPath);

      let firstThrow: unknown = null;
      try {
        await storeDocument(persistence, document, docName);
      } catch (e) {
        firstThrow = e;
      }
      expect(firstThrow).not.toBeNull();
      const forceFlushesAfterFirst = warnings.filter((w) =>
        w.includes('"event":"persistence-force-flush-during-burst"'),
      ).length;
      expect(forceFlushesAfterFirst).toBe(1);

      // 10th store. With cleanup in place, deferCount was reset on the
      // disk-write error path, so the gate sees deferCount=0 and skips
      // normally (emitting persistence-skip-non-quiescent). Without
      // cleanup, deferCount is still 8 and the gate force-flushes again
      // (emitting persistence-force-flush-during-burst, then either
      // succeeding or throwing on the still-broken disk path).
      try {
        await storeDocument(persistence, document, docName);
      } catch {
        // Swallowed in this assertion's scope — the test is about gate
        // accounting, not about whether the disk write recovered.
      }
      const forceFlushesAfterSecond = warnings.filter((w) =>
        w.includes('"event":"persistence-force-flush-during-burst"'),
      ).length;
      const skipsAfterSecond = warnings.filter((w) =>
        w.includes('"event":"persistence-skip-non-quiescent"'),
      ).length;

      // Bug-free: cycle resumed gate semantics — no second force-flush, one
      // additional skip event (skipsBeforeFlush + 1 = 9).
      expect(forceFlushesAfterSecond).toBe(1);
      expect(skipsAfterSecond).toBe(9);
    } finally {
      console.warn = originalWarn;
      __setQuiescentOverrideForTests(document, undefined);
      document.destroy();
    }
  });
});

/**
 * wiring smoke tests — CI-runnable.
 *
 * The full contract suite lives in `persistence-ytext-truth.test.ts`
 * but those tests boot `createServer → initShadowRepo`, which spawns
 * git subprocesses that hit oven-sh/bun#11892 on Linux CI runners. These
 * lightweight tests piggyback on the deferred-store harness (no shadow
 * repo, no git subprocess, no createServer) so the load-bearing wiring
 * — "disk bytes come from ytext.toString(), NOT serialize(fragment)" —
 * has CI coverage.
 *
 * Source-form bytes that distinguish the two readers:
 *   - `__foo__\n`  (ytext bytes)            ← what we wrote via composeAndWriteRawBody
 *   - `**foo**\n`  (canonical fragment)     ← what serialize(fragment) would emit
 *                                             after the parser canonicalizes `__` → `**`
 *                                             absent the sourceDelimiter attr
 *
 * If a wiring regression makes persistence read fragment instead of
 * ytext, the disk bytes flip from `__foo__` to `**foo**` (or get
 * canonicalized away entirely) and these tests fail loudly.
 */
describe('Y.Text-is-truth wiring (FR-33 / FR-35)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-fr33-wiring-'));
    mkdirSync(tmpDir, { recursive: true });
    setBatchInProgress(false);
    switchReconciledBaseScope('main');
  });

  afterEach(() => {
    setBatchInProgress(false);
    switchReconciledBaseScope('main');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('FR-33: disk bytes come from ytext.toString(), not serialize(fragment)', async () => {
    const docName = 'fr33-wiring';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    const document = new Y.Doc();
    await loadDocument(persistence, document, docName);

    // Source-form bytes that the parser would canonicalize: `__foo__` →
    // `**foo**` absent the sourceDelimiter attr (which the bare
    // composeAndWriteRawBody path doesn't populate). Whichever side
    // persistence reads, the disk bytes prove it.
    document.transact(() => {
      composeAndWriteRawBody(document, '__foo__\n', 'agent');
    });

    await storeDocument(persistence, document, docName);

    const diskBytes = readFileSync(docPath, 'utf-8');
    expect(diskBytes).toContain('__foo__');
    // Negative assertion: if persistence had read serialize(fragment),
    // the canonicalized `**foo**` form would have landed instead.
    expect(diskBytes).not.toContain('**foo**');
    document.destroy();
  });

  test('FR-35: cold-load setReconciledBase stores raw disk bytes', async () => {
    const docName = 'fr35-cold-load';
    const docPath = join(tmpDir, `${docName}.md`);
    // Pre-write source-form bytes to disk before loading. The
    // cold-load path stores these raw bytes as the reconciledBase — NOT
    // the canonicalized post-parse-serialize form.
    writeFileSync(docPath, '__cold__\n', 'utf-8');

    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    const document = new Y.Doc();
    await loadDocument(persistence, document, docName);

    const base = getReconciledBase(docName);
    expect(base).toBe('__cold__\n');
    // Negative assertion: a regression to canonical-form storage would
    // surface as `**cold**\n` here.
    expect(base).not.toContain('**cold**');
    document.destroy();
  });
});

/**
 * `flushDeferredStores` deferred-drain failure observability.
 *
 * Pattern C tests: real fault injected at
 * a real boundary (`tracedRename` returns a failure, OR throws a malformed
 * error whose property access trips the classifier). Assertions are on the
 * user-visible structured event + counter — the operator-facing outcomes
 * dashboards consume. Pattern A (mock storeDocumentNow → throw → assert
 * catch fired) is forbidden.
 *
 * The disk-write failure path uses the file-as-directory trick (rename
 * target replaced with a directory pre-rename) — same fault injection
 * surface as the `force-flush-disk-error` test in the gate-cleanup describe
 * ; the kernel-surfaced ErrnoException is what production would see
 * during a real disk outage. The classifier-failure path uses a
 * spy-on-`tracedRename`-throws-Proxy injection because no naturally-
 * occurring production error has property accessors that throw — the inner
 * try/catch around the classifier is built to absorb that
 * exotic shape so the structured event still emits.
 */
describe('FR-9 — deferred-store-failed event + counter', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof spyOn>;
  let warnings: string[];

  function findEventLines(eventName: string): Array<Record<string, unknown>> {
    const matches: Array<Record<string, unknown>> = [];
    for (const line of warnings) {
      if (!line.includes(`"event":"${eventName}"`)) continue;
      try {
        matches.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Non-JSON warn lines from other observers are ignored — this
        // event-shape contract is exact (single JSON.stringify per emit).
      }
    }
    return matches;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-fr9-deferred-drain-'));
    mkdirSync(tmpDir, { recursive: true });
    setBatchInProgress(false);
    switchReconciledBaseScope('main');
    resetMetrics();
    warnings = [];
    warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    setBatchInProgress(false);
    switchReconciledBaseScope('main');
    warnSpy.mockRestore();
    delete process.env.OK_TELEMETRY_VERBOSE;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('emits deferred-store-failed with errorClass=disk-write under default redaction', async () => {
    const docName = 'fr9-disk-write-default';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    const document = new Y.Doc();
    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraph(document, 'queued edit'), BROWSER_ORIGIN);

    setBatchInProgress(true);
    await storeDocument(persistence, document, docName);
    setBatchInProgress(false);

    // Replace the doc file with a directory so the deferred drain's rename
    // operation surfaces an ErrnoException (EISDIR/EEXIST/ENOTEMPTY
    // depending on platform) — a real disk-failure shape, not a mocked one.
    rmSync(docPath, { force: true });
    mkdirSync(docPath);

    const before = getMetrics().deferredStoreFailures;
    await persistence.flushDeferredStores('within-branch');
    const after = getMetrics().deferredStoreFailures;

    expect(after).toBe(before + 1);

    const events = findEventLines('deferred-store-failed');
    expect(events).toHaveLength(1);
    const ev = events[0] as Record<string, unknown>;
    expect(ev.event).toBe('deferred-store-failed');
    expect(ev['doc.name']).toBe(docName);
    // Either disk-write (most kernels) or traced-rename (when the Node fs
    // error message contains 'rename') — both are correct disk-layer bins;
    // the test pins a real-fault outcome rather than a brittle exact label.
    expect(ev.errorClass).toMatch(/^(disk-write|traced-rename)$/);
    expect(typeof ev.errorMessageHash).toBe('string');
    expect((ev.errorMessageHash as string).length).toBe(8); // FNV-1a 32-bit hex
    expect(typeof ev.timestamp).toBe('string');
    // Default redaction: raw errorMessage MUST NOT be present unless
    // OK_TELEMETRY_VERBOSE=1 is set.
    expect(ev.errorMessage).toBeUndefined();

    document.destroy();
  });

  test('OK_TELEMETRY_VERBOSE=1 surfaces raw errorMessage on the event', async () => {
    process.env.OK_TELEMETRY_VERBOSE = '1';
    const docName = 'fr9-disk-write-verbose';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    const document = new Y.Doc();
    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraph(document, 'queued edit'), BROWSER_ORIGIN);

    setBatchInProgress(true);
    await storeDocument(persistence, document, docName);
    setBatchInProgress(false);

    rmSync(docPath, { force: true });
    mkdirSync(docPath);

    await persistence.flushDeferredStores('within-branch');

    const events = findEventLines('deferred-store-failed');
    expect(events).toHaveLength(1);
    const ev = events[0] as Record<string, unknown>;
    expect(typeof ev.errorMessage).toBe('string');
    expect((ev.errorMessage as string).length).toBeGreaterThan(0);
    // Hash must STILL be present alongside the raw message — operator
    // pipelines may pivot off the hash even when verbose is on, so the
    // hash is unconditional.
    expect(typeof ev.errorMessageHash).toBe('string');

    document.destroy();
  });

  test('classifier failure emits deferred-store-classifier-failed and outer event with errorClass=unknown', async () => {
    const docName = 'fr9-classifier-fail';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    const document = new Y.Doc();
    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraph(document, 'queued edit'), BROWSER_ORIGIN);

    setBatchInProgress(true);
    await storeDocument(persistence, document, docName);
    setBatchInProgress(false);

    // Inject a malformed error whose `code` accessor throws. The classifier
    // accesses `e.code` via `typeof e.code === 'string'` — that property
    // read invokes the throwing getter, breaking the classifier. The outer
    // try/catch around `classifyDeferredStoreError(err)`
    // must absorb the throw and emit `deferred-store-classifier-failed`
    // alongside the outer `deferred-store-failed` event with
    // errorClass='unknown'.
    const renameSpy = spyOn(fsTraced, 'tracedRename').mockImplementation(async () => {
      const malformed = Object.create(Error.prototype) as Error & { name: string };
      Object.defineProperty(malformed, 'message', { value: 'malformed-error', enumerable: true });
      Object.defineProperty(malformed, 'name', { value: 'MalformedError', enumerable: true });
      Object.defineProperty(malformed, 'code', {
        get: () => {
          throw new Error('classifier-trip getter');
        },
        enumerable: true,
      });
      throw malformed;
    });

    try {
      const before = getMetrics().deferredStoreFailures;
      await persistence.flushDeferredStores('within-branch');
      const after = getMetrics().deferredStoreFailures;
      expect(after).toBe(before + 1);

      const classifierEvents = findEventLines('deferred-store-classifier-failed');
      expect(classifierEvents.length).toBeGreaterThanOrEqual(1);
      const cev = classifierEvents[0] as Record<string, unknown>;
      expect(cev['doc.name']).toBe(docName);
      expect(typeof cev.classifyErrorHash).toBe('string');
      expect((cev.classifyErrorHash as string).length).toBe(8);
      // Default-redacted: classifyErrorMessage MUST NOT appear unless
      // OK_TELEMETRY_VERBOSE=1 (mirrors the outer event's redaction shape).
      expect(cev.classifyErrorMessage).toBeUndefined();

      const outerEvents = findEventLines('deferred-store-failed');
      expect(outerEvents.length).toBeGreaterThanOrEqual(1);
      const oev = outerEvents[0] as Record<string, unknown>;
      expect(oev['doc.name']).toBe(docName);
      expect(oev.errorClass).toBe('unknown');
      // Correlation field: classifier-failed carries the same
      // errorMessageHash as the outer deferred-store-failed event so
      // triage can pivot from inner to outer when both fire on the same
      // doc within a drain.
      expect(typeof cev.errorMessageHash).toBe('string');
      expect((cev.errorMessageHash as string).length).toBe(8);
      expect(cev.errorMessageHash).toBe(oev.errorMessageHash);
    } finally {
      renameSpy.mockRestore();
      document.destroy();
    }
  });

  test('throwing `.message` getter is caught by the rawMessage extraction guard (mirror of classifier `.code`-throws path)', async () => {
    // Symmetric with the `.code`-throws test. The classifier's outer
    // try/catch is the documented observability boundary for exotic error
    // shapes, but `.message` is extracted
    // via a SEPARATE path (the rawMessage hash + verbose passthrough)
    // BEFORE the classifier runs. Without an equivalent guard there, a
    // throwing `.message` getter would propagate up and bypass
    // incrementDeferredStoreFailures + the deferred-store-failed event,
    // erasing the failure signal — the silent-loss class is built
    // to prevent. This test pins that the rawMessage-extraction guard
    // absorbs the throw and that the outer event still emits with an
    // empty errorMessageHash (hash of the empty fallback string).
    const docName = 'fr9-message-getter-throws';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    const document = new Y.Doc();
    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraph(document, 'queued edit'), BROWSER_ORIGIN);

    setBatchInProgress(true);
    await storeDocument(persistence, document, docName);
    setBatchInProgress(false);

    const renameSpy = spyOn(fsTraced, 'tracedRename').mockImplementation(async () => {
      const malformed = Object.create(Error.prototype) as Error & { name: string };
      Object.defineProperty(malformed, 'name', { value: 'MalformedError', enumerable: true });
      Object.defineProperty(malformed, 'message', {
        get: () => {
          throw new Error('message-trip getter');
        },
        enumerable: true,
      });
      throw malformed;
    });

    try {
      const before = getMetrics().deferredStoreFailures;
      await persistence.flushDeferredStores('within-branch');
      const after = getMetrics().deferredStoreFailures;
      // Counter MUST increment — the failure signal isn't lost.
      expect(after).toBe(before + 1);

      // Outer event MUST emit. errorMessageHash is the hash of the empty
      // fallback string (the guard's `rawMessage = ''` branch).
      const outerEvents = findEventLines('deferred-store-failed');
      expect(outerEvents.length).toBeGreaterThanOrEqual(1);
      const oev = outerEvents[0] as Record<string, unknown>;
      expect(oev['doc.name']).toBe(docName);
      expect(typeof oev.errorMessageHash).toBe('string');
      expect((oev.errorMessageHash as string).length).toBe(8);
    } finally {
      renameSpy.mockRestore();
      document.destroy();
    }
  });

  test('classifier failure with OK_TELEMETRY_VERBOSE=1 surfaces raw classifyErrorMessage', async () => {
    process.env.OK_TELEMETRY_VERBOSE = '1';
    const docName = 'fr9-classifier-fail-verbose';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    const document = new Y.Doc();
    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraph(document, 'queued edit'), BROWSER_ORIGIN);

    setBatchInProgress(true);
    await storeDocument(persistence, document, docName);
    setBatchInProgress(false);

    const renameSpy = spyOn(fsTraced, 'tracedRename').mockImplementation(async () => {
      const malformed = Object.create(Error.prototype) as Error & { name: string };
      Object.defineProperty(malformed, 'message', {
        value: 'malformed-error-verbose',
        enumerable: true,
      });
      Object.defineProperty(malformed, 'name', { value: 'MalformedError', enumerable: true });
      Object.defineProperty(malformed, 'code', {
        get: () => {
          throw new Error('classifier-trip getter');
        },
        enumerable: true,
      });
      throw malformed;
    });

    try {
      await persistence.flushDeferredStores('within-branch');

      const classifierEvents = findEventLines('deferred-store-classifier-failed');
      expect(classifierEvents.length).toBeGreaterThanOrEqual(1);
      const cev = classifierEvents[0] as Record<string, unknown>;
      // Verbose opt-in: raw classifyErrorMessage IS present alongside
      // the unconditional classifyErrorHash.
      expect(typeof cev.classifyErrorMessage).toBe('string');
      expect(cev.classifyErrorMessage).toBe('classifier-trip getter');
      expect(typeof cev.classifyErrorHash).toBe('string');
      expect((cev.classifyErrorHash as string).length).toBe(8);
    } finally {
      renameSpy.mockRestore();
      document.destroy();
    }
  });
});

/**
 * classifier behavioral pin (Pattern B).
 *
 * Pins the classifier's actual return domain — the four bins it currently
 * routes errors to (`disk-write`, `traced-rename`, `serialize`, `unknown`).
 * Pattern B (behavioral pin): tests the
 * public API, asserts on the return value, no observable I/O.
 *
 * Coverage scope (read this before adding bins or new test cases):
 * `DEFERRED_STORE_ERROR_CLASSES` declares 6 members, but only
 * the 4 above are reachable via `classifyDeferredStoreError`. The remaining
 * two (`reconcile`, `parse-fallback`) are forward-compat dashboard slots —
 * see `classifyDeferredStoreError`'s JSDoc for why they exist
 * even though no current code path returns them. Adding a test that asserts
 * those bins return through the classifier would lie about the contract;
 * adding a new bin to the type without wiring a classifier path leaves it
 * in the same forward-compat state and is intentionally not gated here.
 * The lockstep enforcement, when a contributor wires a NEW reachable bin,
 * is reviewer attention — not this test.
 */
describe('FR-9 — classifyDeferredStoreError behavior', () => {
  test('symlink-escape errors classify as disk-write', () => {
    const err = new Error('symlink-escape: /a resolves to /etc/passwd outside /content');
    expect(classifyDeferredStoreError(err)).toBe('disk-write');
  });

  test('ErrnoException with rename in message classifies as traced-rename', () => {
    const err = Object.assign(new Error('EISDIR: illegal operation on a directory, rename'), {
      code: 'EISDIR',
    });
    expect(classifyDeferredStoreError(err)).toBe('traced-rename');
  });

  test('ErrnoException without rename in message classifies as disk-write', () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(classifyDeferredStoreError(err)).toBe('disk-write');
  });

  test('BridgeInvariantViolationError instances classify as serialize', () => {
    // Pins the production contract: actual `BridgeInvariantViolationError`
    // instances (the only shape that ever reaches this catch from
    // `storeDocumentNow`'s pre-write sanity check) classify as serialize.
    const err = new BridgeInvariantViolationError({
      site: 'persistence',
      ytextSnapshot: '',
      fragmentMdSnapshot: '',
      unifiedDiff: '',
      stack: undefined,
    });
    expect(classifyDeferredStoreError(err)).toBe('serialize');
  });

  test('non-instance error with matching name classifies as unknown (instanceof contract)', () => {
    // Pins the strictness of the `instanceof` check vs the prior
    // string-name match: an impostor `Error` with `.name` set to
    // `'BridgeInvariantViolationError'` has no actual bridge-invariant
    // context (no .violation field, not the real class). Routing it to
    // the `serialize` bin would mis-attribute non-bridge failures to
    // the bridge in dashboards. The instanceof check filters those out.
    const err = Object.assign(new Error('bridge'), { name: 'BridgeInvariantViolationError' });
    expect(classifyDeferredStoreError(err)).toBe('unknown');
  });

  test('plain Error classifies as unknown', () => {
    expect(classifyDeferredStoreError(new Error('something else'))).toBe('unknown');
  });

  test('null and non-object throws classify as unknown', () => {
    expect(classifyDeferredStoreError(null)).toBe('unknown');
    expect(classifyDeferredStoreError('string-throw')).toBe('unknown');
    expect(classifyDeferredStoreError(42)).toBe('unknown');
  });
});
