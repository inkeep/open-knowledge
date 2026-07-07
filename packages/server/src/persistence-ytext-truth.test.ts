/**
 * Bun-tier coverage for the Y.Text-is-truth persistence contract.
 *
 * Test classes:
 *   1. **Body source switch.** Persistence reads body bytes from
 *      `Y.Text('source')` directly, not from `mdManager.serialize(fragment)`.
 *      Round-trip preserves user-form bytes through ytext → disk → cold-load
 *      → ytext.
 *   2. **Cold-load `setReconciledBase(raw)`.** Disk bytes seed the
 *      reconciled base verbatim, not a fragment-derived re-serialization.
 *      The first onStoreDocument after load tolerates the
 *      "fragment is canonical, ytext is raw" gap via `normalizeBridge` so
 *      mere file open does NOT trigger a phantom write.
 *   3. **Quiescence gate.** When `isDocQuiescent` returns
 *      false, persistence skips the cycle and emits
 *      `persistence-skip-non-quiescent` telemetry. After
 *      `QUIESCENCE_MAX_DEFER` consecutive deferrals, the gate force-flushes
 *      and emits `persistence-force-flush-during-burst` telemetry.
 *   4. **Pre-write sanity check.** When `normalizeBridge(ytext) !=
 *      normalizeBridge(serialize(fragment))`, persistence emits
 *      `bridge-invariant-violation` telemetry, queues fragment reconciliation,
 *      and STILL writes the ytext bytes (data-loss-via-skip-cascade
 *      structurally avoided).
 */

import { describe as _bunDescribe, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';

// Skip-on-CI gate (oven-sh/bun#11892 — child-process reaping bug). The full
// contract surface lives in this file: every test boots a real
// `createServer`, which transitively calls `initShadowRepo` (shadow-repo.ts)
// → `simpleGit({...}).raw('init', '--bare', ...)` etc. — that's the leak
// source, NOT the per-test `setupFixture` git init alone. Even with
// `gitEnabled: false`, the shadow-repo init runs unconditionally inside
// `createServer.initAsync` (server-factory.ts), so splitting "git" from
// "non-git" tests would not let any test in this file run on CI Bun.
//
// Coverage is preserved on CI by the lower-tier unit tests that don't boot
// a server (`bridge-watchdog.test.ts`, `bridge-quiescence.test.ts`,
// `bridge-intake.test.ts`, `persistence-deferred-store.test.ts`). The
// integration tests here run on every developer's `bun run check` before
// push and on macOS CI where the bug doesn't reproduce.
//
// Re-enable condition: drop this gate when oven-sh/bun#11892 is closed AND
// a full canonical-gate run on ubuntu-latest GHA is green for ≥5 consecutive
// runs of this file. Track via the shared CI-skip pattern across server tests
// (~49 files).
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { __resetQuiescenceForTests, __setQuiescentOverrideForTests } from './bridge-quiescence.ts';
import { __resetBridgeWatchdogForTests } from './bridge-watchdog.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { getReconciledBase } from './persistence.ts';
import { createServer } from './server-factory.ts';

interface Fixture {
  tmpDir: string;
  contentDir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ok-ytext-truth-'));
  const contentDir = tmpDir;
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  return {
    tmpDir,
    contentDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

async function waitForCondition(
  predicate: () => boolean,
  {
    timeoutMs = 5_000,
    pollMs = 25,
    describe,
  }: { timeoutMs?: number; pollMs?: number; describe?: () => string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // Surface diagnostic context on timeout so CI flake triage doesn't have to
  // re-derive what the predicate was checking from a bare timeout message.
  const diagnostic = describe ? ` — ${describe()}` : '';
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms${diagnostic}`);
}

beforeEach(() => {
  resetMetrics();
  __resetQuiescenceForTests();
  __resetBridgeWatchdogForTests();
});

describe('FR-33: persistence reads body from Y.Text', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('source-form delimiter `__foo__` survives ytext write → disk write', async () => {
    const docName = 'fr33-source-form';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    // Pre-create empty file so onLoadDocument sets reconciledBase=''.
    writeFileSync(docPath, '', 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      // Direct ytext write under a user-origin (paired-write would require
      // composeAndWriteRawBody; the simplest test inserts to Y.Text under
      // a connection origin that the bridge observers will treat as a
      // source-mode user write — Observer B fires Phase 1 to derive the
      // fragment from parse(ytext)).
      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-fr33' } },
      };
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, '__foo__\n');
      }, userOrigin);

      // Wait for the debounce to fire. Disk bytes must be `__foo__\n`
      // (raw user form) NOT the canonicalized `**foo**\n`.
      await waitForCondition(
        () => {
          if (!existsSync(docPath)) return false;
          return readFileSync(docPath, 'utf-8').includes('__foo__');
        },
        {
          describe: () =>
            `disk read at ${docPath} did not contain '__foo__' (file exists: ${existsSync(docPath)})`,
        },
      );
      const diskBytes = readFileSync(docPath, 'utf-8');
      // Match raw user form — strong delimiter survives.
      expect(diskBytes).toContain('__foo__');
      // The canonical-form output would have been `**foo**` — verify it
      // is NOT present (would prove we accidentally re-canonicalized).
      expect(diskBytes).not.toContain('**foo**');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });

  test('CRLF line endings survive ytext write → disk write (modulo normalizeBridge tolerance)', async () => {
    const docName = 'fr33-crlf';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      if (!serverDoc) return;

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-fr33-crlf' } },
      };
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, 'Line1\r\nLine2\r\n');
      }, userOrigin);

      await waitForCondition(
        () => {
          if (!existsSync(docPath)) return false;
          const bytes = readFileSync(docPath, 'utf-8');
          return bytes.length > 0 && bytes.includes('Line1');
        },
        {
          describe: () =>
            `disk read at ${docPath} did not contain 'Line1' (file exists: ${existsSync(docPath)}, size: ${existsSync(docPath) ? readFileSync(docPath, 'utf-8').length : 'n/a'})`,
        },
      );
      const diskBytes = readFileSync(docPath, 'utf-8');
      // Under the contract, ytext holds CRLF and persistence writes ytext
      // bytes. The bridge invariant comparator tolerates the LF↔CRLF gap
      // so the watchdog doesn't fire.
      expect(diskBytes).toContain('Line1');
      expect(diskBytes).toContain('Line2');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});

describe('FR-35: cold-load setReconciledBase stores raw disk bytes', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('reconciledBase stores the raw disk content verbatim (not serialize(fragment))', async () => {
    const docName = 'fr35-raw-base';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    // Source-form bytes that would normalize differently if reconciledBase
    // had been canonicalized via fragment-serialize.
    const rawDiskContent = '# Heading\n\nA __strong__ paragraph.\n';
    writeFileSync(docPath, rawDiskContent, 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);

      // Wait for onLoadDocument to populate the doc + set reconciledBase.
      await waitForCondition(() => getReconciledBase(docName) !== undefined);
      // reconciledBase is the raw disk content verbatim.
      expect(getReconciledBase(docName)).toBe(rawDiskContent);

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });

  test('cold-load + first onStoreDocument tolerates fragment-canonical-vs-ytext-raw via normalizeBridge', async () => {
    // The reconciledBase = raw disk bytes; the doc post-load has
    // fragment derived from parse + ytext = full-file bytes. The first
    // onStoreDocument runs the markdownSemanticallyUnchanged check which
    // uses normalizeBridge — comparing ytext bytes (raw) to reconciledBase
    // (raw, identical on cold-load) — so no false-positive write fires.
    const docName = 'fr35-no-phantom-write';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const rawDiskContent = '# Title\n\nBody text.\n';
    writeFileSync(docPath, rawDiskContent, 'utf-8');

    const initialMtime = (await Bun.file(docPath).stat()).mtimeMs;

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      // Wait for cold-load to settle.
      await waitForCondition(() => getReconciledBase(docName) !== undefined);

      // Wait briefly to give the debounce a chance to fire if it would.
      await new Promise((r) => setTimeout(r, 250));

      // mtime unchanged → no phantom write.
      const finalMtime = (await Bun.file(docPath).stat()).mtimeMs;
      expect(finalMtime).toBe(initialMtime);

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});

describe('FR-33: full round-trip preserves user-form bytes', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('source bytes survive: write disk → cold-load → mutate (no canonical edit) → save → disk-bytes byte-equal', async () => {
    const docName = 'fr33-roundtrip';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const initialContent = '# Title\n\n__bold__ source.\n';
    writeFileSync(docPath, initialContent, 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      if (!serverDoc) return;

      await waitForCondition(() => getReconciledBase(docName) !== undefined);
      const ytextAfterLoad = serverDoc.getText('source').toString();
      // ytext should hold the disk content verbatim post-cold-load.
      expect(ytextAfterLoad).toBe(initialContent);

      // Source-mode append a line — append to ytext directly with
      // user-origin transact. This is a "source-mode write" semantic
      // (not paired-write); Observer B will derive fragment via
      // parse(ytext).
      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-fr33-rt' } },
      };
      const _newContent = `${initialContent}__more__\n`;
      serverDoc.transact(() => {
        const ytext = serverDoc.getText('source');
        ytext.insert(ytext.length, '__more__\n');
      }, userOrigin);

      // Wait for the debounce to fire and the file to update.
      await waitForCondition(
        () => {
          if (!existsSync(docPath)) return false;
          return readFileSync(docPath, 'utf-8').includes('__more__');
        },
        {
          describe: () =>
            `disk read at ${docPath} did not contain '__more__' (file exists: ${existsSync(docPath)})`,
        },
      );

      const diskAfterEdit = readFileSync(docPath, 'utf-8');
      // The user-form `__bold__` and `__more__` MUST survive — neither
      // canonicalized to `**bold**` / `**more**`.
      expect(diskAfterEdit).toContain('__bold__');
      expect(diskAfterEdit).toContain('__more__');
      expect(diskAfterEdit).not.toContain('**bold**');
      expect(diskAfterEdit).not.toContain('**more**');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});

describe('Quiescence gate via direct counter manipulation', () => {
  // These tests bypass Hocuspocus's debounce by calling onStoreDocument
  // directly through the persistence extension, with quiescence counters
  // forced into a non-quiescent state via the test seam. This is the
  // ONLY clean way to exercise the gate's skip-and-defer logic — Yjs's
  // afterAllTransactions fires synchronously after every drain, so a
  // naturally-occurring non-quiescent moment doesn't surface to async
  // observers.

  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('non-quiescent doc → onStoreDocument skips with persistence-skip-non-quiescent telemetry', async () => {
    const docName = 'gate-skip';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');
    const initialMtime = (await Bun.file(docPath).stat()).mtimeMs;

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      if (!serverDoc) return;

      await waitForCondition(() => getReconciledBase(docName) !== undefined);

      // Pin the predicate to non-quiescent for this doc. Yjs's
      // afterAllTransactions fires synchronously after every drain, so
      // counter-only manipulation is fragile against concurrent settlements.
      // The override seam is the canonical way to drive the gate from a
      // test on the same event loop.
      __setQuiescentOverrideForTests(serverDoc, false);

      // Mutate the doc to trigger Hocuspocus's debounce → onStoreDocument.
      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-gate' } },
      };
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, 'edit ');
      }, userOrigin);

      // Wait for the skip telemetry to fire (within debounce window).
      await waitForCondition(() => {
        return warnSpy.mock.calls.some((call) => {
          const arg = String(call[0] ?? '');
          return arg.includes('"event":"persistence-skip-non-quiescent"');
        });
      });

      const skipCalls = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('"event":"persistence-skip-non-quiescent"'));
      expect(skipCalls.length).toBeGreaterThan(0);
      const payload = JSON.parse(skipCalls[0] ?? '{}') as Record<string, unknown>;
      expect(payload.event).toBe('persistence-skip-non-quiescent');
      expect(payload['doc.name']).toBe(docName);
      expect(typeof payload.deferCount).toBe('number');
      expect(payload.deferCount).toBeGreaterThanOrEqual(0);
      // wallClockMsSinceLastTransaction may be number OR null, both are
      // bounded-cardinality-safe.
      expect(['number', 'object']).toContain(typeof payload.wallClockMsSinceLastTransaction);

      // The metric counter incremented.
      expect(getMetrics().persistenceSkipNonQuiescent).toBeGreaterThan(0);

      // Disk file should NOT have been rewritten with our edit.
      const finalMtime = (await Bun.file(docPath).stat()).mtimeMs;
      expect(finalMtime).toBe(initialMtime);

      // Clear override before exiting (so other tests don't see it).
      __setQuiescentOverrideForTests(serverDoc, undefined);
      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  });

  test('after QUIESCENCE_MAX_DEFER skips → force-flush emits persistence-force-flush-during-burst', async () => {
    const docName = 'gate-force-flush';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 80,
      // Tight maxDebounce so we cycle through deferrals quickly.
      maxDebounce: 200,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      if (!serverDoc) return;
      await waitForCondition(() => getReconciledBase(docName) !== undefined);

      __setQuiescentOverrideForTests(serverDoc, false);

      // Repeatedly mutate the doc; each mutation triggers a debounce
      // cycle. The persistence gate skips until deferCount >=
      // QUIESCENCE_MAX_DEFER (8); the next cycle force-flushes.
      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-force' } },
      };
      // Cycle through 12 mutations — enough to exceed the 8-defer cap.
      for (let i = 0; i < 12; i++) {
        serverDoc.transact(() => {
          serverDoc.getText('source').insert(0, `e${i} `);
        }, userOrigin);
        // Small spacing so debounce fires between cycles. With
        // maxDebounce=200, each iteration should produce at most one
        // onStoreDocument fire.
        await new Promise((r) => setTimeout(r, 250));
      }

      // Force-flush event MUST fire at least once.
      await waitForCondition(() => {
        return warnSpy.mock.calls.some((call) => {
          const arg = String(call[0] ?? '');
          return arg.includes('"event":"persistence-force-flush-during-burst"');
        });
      });

      const forceCalls = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('"event":"persistence-force-flush-during-burst"'));
      expect(forceCalls.length).toBeGreaterThan(0);
      const payload = JSON.parse(forceCalls[0] ?? '{}') as Record<string, unknown>;
      expect(payload.event).toBe('persistence-force-flush-during-burst');
      expect(payload['doc.name']).toBe(docName);
      expect(typeof payload.deferCount).toBe('number');
      // deferCount at force-flush time was >= QUIESCENCE_MAX_DEFER (8).
      expect(payload.deferCount).toBeGreaterThanOrEqual(8);

      expect(getMetrics().persistenceForceFlushDuringBurst).toBeGreaterThan(0);

      __setQuiescentOverrideForTests(serverDoc, undefined);
      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  }, 30_000);

  test('quiescence resumes naturally → next debounce flushes successfully', async () => {
    // This test follows the natural recovery path: after a brief
    // non-quiescent period, the next user-origin tx + settlement
    // bring the doc back to quiescent and the next debounce flushes
    // without skipping.
    const docName = 'gate-recover';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      if (!serverDoc) return;
      await waitForCondition(() => getReconciledBase(docName) !== undefined);

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-recover' } },
      };
      // Two transactions in quick succession; both naturally settle via
      // afterAllTransactions, so the gate sees quiescent on both.
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, 'recovered ');
      }, userOrigin);

      // Wait for disk write to land.
      await waitForCondition(() => {
        if (!existsSync(docPath)) return false;
        return readFileSync(docPath, 'utf-8').includes('recovered');
      });

      const diskBytes = readFileSync(docPath, 'utf-8');
      expect(diskBytes).toContain('recovered');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});

describe('Pre-write sanity check: divergence at persistence-fire time', () => {
  // Closes the unit-vs-integration gap: bridge-watchdog.test.ts pins
  // the suppressDevThrow mechanic in isolation; this file exercises the
  // full production call path through `storeDocumentNow` when ytext bytes
  // ≠ serialize(fragment) bytes outside the normalizeBridge tolerance set.
  //
  // Test discipline: the
  // pre-write sanity-check seam is reached via dependency-injection of a
  // dedicated `MarkdownManager` instance through `PersistenceOptions.mdManager`,
  // not via stack-frame string-matching on the function name. The test
  // constructs a real `new MarkdownManager({ extensions: sharedExtensions })`,
  // spies on its `serialize`, and threads it into `createServer({ mdManager })`.
  // Other serialize call sites (Observer A baseline, Observer B watchdog,
  // reconcileFragmentNow) keep using the production singleton, so observer
  // machinery stays correct without any stack inspection.
  //
  // NODE_ENV is forced to 'production' for the test scope so Observer B's
  // affirmative throw gate is bypassed. Persistence's call always opts out
  // of the throw path via suppressDevThrow:true, so its own behavior is
  // independent of the env override; the override only protects us from
  // collateral throws if Observer B's serialize call later diverges for
  // any reason.

  let fixture: Fixture;
  let originalNodeEnv: string | undefined;

  beforeEach(async () => {
    fixture = await setupFixture();
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    fixture.cleanup();
  });

  test('divergent serialize at persistence-time → ytext bytes win on disk + telemetry fires', async () => {
    const docName = 'fr33-divergence';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      warnings.push(msg);
    };

    // Per-test MarkdownManager — same shape as the production singleton
    // (caches included), so the serialize spy targets the exact seam
    // persistence reaches via `options.mdManager`. Other call sites keep
    // using the production `mdManager` singleton.
    const testMdManager = new MarkdownManager({ extensions: sharedExtensions });
    spyOn(testMdManager, 'serialize').mockImplementation(() => 'INJECTED-DIVERGENT-CANONICAL\n');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      mdManager: testMdManager,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-divergence' } },
      };
      // The user types a clear source-form payload. Disk write should land
      // these bytes despite the spy injecting divergent canonical bytes
      // into the persistence sanity check.
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, 'user-typed-bytes\n');
      }, userOrigin);

      await waitForCondition(() => {
        if (!existsSync(docPath)) return false;
        const bytes = readFileSync(docPath, 'utf-8');
        return bytes.includes('user-typed-bytes');
      });

      const diskBytes = readFileSync(docPath, 'utf-8');
      // (a) ytext bytes land on disk — the divergent canonical bytes
      // injected into persistence's sanity check do NOT win.
      expect(diskBytes).toContain('user-typed-bytes');
      expect(diskBytes).not.toContain('INJECTED-DIVERGENT-CANONICAL');

      // (b) Telemetry fires with site=persistence. The watchdog routed
      // through assertBridgeInvariant emits a structured event when the
      // injected divergence is outside the comparator's tolerance set.
      const persistenceViolations = warnings.filter(
        (w) =>
          w.includes('"event":"bridge-invariant-violation"') && w.includes('"site":"persistence"'),
      );
      expect(persistenceViolations.length).toBeGreaterThan(0);

      // Counter incremented (rate-limiter's first-emit path).
      expect(getMetrics().bridgeInvariantViolations).toBeGreaterThan(0);

      // (d) No throw escaped — if the test reached this point, the
      // suppressDevThrow opt-out worked end-to-end. (A throw would have
      // either surfaced from afterAllTransactions or blocked the disk
      // write that we asserted on.)

      conn.disconnect();
    } finally {
      console.warn = originalWarn;
      await server.destroy();
    }
  });

  test('mdManager.serialize THROWS at persistence-time → ytext bytes still land on disk + dedicated telemetry fires', async () => {
    // Pins the serialize-failure catch path: when the mdManager's
    // `serialize` throws inside the persistence pre-write sanity check
    // (schema-rejection — malformed remote-peer CRDT update, schema
    // drift, exotic Y.XmlElement types per the comment at the catch
    // site), the catch MUST: (a) increment
    // `persistenceSanityCheckSerializeFailures`, (b) emit a structured
    // `persistence-sanity-check-serialize-failed` event with
    // bounded-cardinality `doc.name`, (c) treat as definite divergence
    // (`normalizeEqual = false`) so `reconcileFragmentNow` queues,
    // (d) proceed to write Y.Text bytes verbatim — the hazard
    // mitigation.
    //
    // Without this lock-in, a future refactor that moves
    // `normalizeEqual = false` outside the try (or removes the
    // `incrementPersistenceSanityCheckSerializeFailures()` call) would
    // silently break the data-loss-via-skip-cascade contract.
    const docName = 'fr33-serialize-throw';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      warnings.push(msg);
    };

    // Per-test MarkdownManager whose `serialize` always throws — only the
    // persistence sanity check (which goes through `options.mdManager`)
    // hits this. Observer A baseline init, Observer B watchdog, and
    // reconcile use the real production singleton.
    const testMdManager = new MarkdownManager({ extensions: sharedExtensions });
    spyOn(testMdManager, 'serialize').mockImplementation(() => {
      throw new Error('synthetic schema-rejection: invalid Y.XmlElement type');
    });

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      mdManager: testMdManager,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-serialize-throw' } },
      };
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, 'survives-serialize-throw\n');
      }, userOrigin);

      await waitForCondition(() => {
        if (!existsSync(docPath)) return false;
        const bytes = readFileSync(docPath, 'utf-8');
        return bytes.includes('survives-serialize-throw');
      });

      // (a) ytext bytes land on disk — the throw inside the sanity check
      // does NOT block the write. R7 hazard mitigation: ytext is the
      // contract's source-of-truth.
      const diskBytes = readFileSync(docPath, 'utf-8');
      expect(diskBytes).toContain('survives-serialize-throw');

      // (b) Counter incremented — the dedicated failure-class signal.
      expect(getMetrics().persistenceSanityCheckSerializeFailures).toBeGreaterThan(0);

      // (c) Structured event fired with bounded-cardinality payload.
      const serializeFailEvents = warnings.filter((w) =>
        w.includes('"event":"persistence-sanity-check-serialize-failed"'),
      );
      expect(serializeFailEvents.length).toBeGreaterThan(0);
      const payload = JSON.parse(serializeFailEvents[0] ?? '{}') as Record<string, unknown>;
      expect(payload.event).toBe('persistence-sanity-check-serialize-failed');
      expect(payload['doc.name']).toBe(docName);

      // (d) No throw escaped — test reached this point.

      conn.disconnect();
    } finally {
      console.warn = originalWarn;
      await server.destroy();
    }
  });
});
