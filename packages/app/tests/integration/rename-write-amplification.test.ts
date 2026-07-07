/**
 * Rename write-amplification contract: a managed file rename that does NOT
 * change the destination's content must write the destination exactly ONCE.
 *
 * The rename spine moves the file (W1, placing the source's bytes at the
 * destination) and then may write the reconciled content (W2:
 * `syncRenamedDocsToDisk` -> `tracedWriteFileSync`). W2 must be skipped when its
 * bytes are byte-identical to what W1 placed; otherwise a no-content-change
 * rename writes the destination twice. (A rename that rewrites wiki-link
 * references legitimately writes the destination twice — the move places the old
 * bytes, then the rewrite overwrites them — so this contract covers only the
 * no-content-change case; the self-link test below pins final-byte correctness,
 * not the write count.) The persistence path guards a RELATED single-write
 * contract via `persistence.ts`'s `markdownSemanticallyUnchanged`, but that
 * compares `normalizeBridge`-normalized content (semantic equality); the
 * rename-spine guard compares raw bytes.
 *
 * Instrument: a process-global OTel in-memory span exporter captures every
 * `fs-traced` disk op (the `fs-traced.ts` seam routes through the global OTel
 * tracer). These tests run gitEnabled:false, so the move falls through to
 * `renamePathOnDisk` -> `fs.renameSync` (a traced span); the git-mv branch
 * (`renameTrackedPathInGit`) shells out via simple-git and emits NO fs-traced
 * span, so the "exactly one full write to the destination" count below is
 * specific to the fs-move branch (a move is `fs.renameSync`, an overwrite is
 * `fs.writeFileSync`). Do NOT set OTEL_SDK_DISABLED=false — the server would
 * then init its own provider and tear it down on cleanup(), disabling the
 * global tracer after the first test.
 *
 * Tracer lifecycle: `test:integration` runs the whole tests/integration/ tree
 * in ONE bun process, and OTel's global tracer provider is process-global —
 * `setGlobalTracerProvider` is a no-op once one is registered, and any
 * `trace.disable()` (a sibling file's afterEach, or this suite's own
 * `server.cleanup()` -> `shutdownTelemetry()` once telemetry has been enabled
 * anywhere in the process) tears whatever is registered back down to a no-op.
 * So this file re-establishes its provider in beforeEach (after
 * `trace.disable()` clears any leftover) and tears it down in afterEach,
 * making span capture independent of file order AND surviving a mid-suite
 * teardown. Mirrors worktree-boot.test.ts; see packages/server/src/telemetry.ts
 * for the same cross-file leak class.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMetrics, resetMetrics } from '@inkeep/open-knowledge-server';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  awaitFileWatcherIndexed,
  createTestClient,
  createTestServer,
  getServerState,
  pollUntil,
  type TestServer,
  wait,
} from './test-harness';

let spanExporter = new InMemorySpanExporter();
let tracerProvider: BasicTracerProvider | null = null;

beforeEach(() => {
  // disable() first: setGlobalTracerProvider is a no-op when a provider is
  // already registered, and a prior test (here or in a sibling file) may have
  // registered and torn one down. Re-establishing per test binds the exporter
  // regardless of order and survives a `shutdownTelemetry()` teardown between
  // tests; otherwise the global tracer is left a no-op and every fs-traced span
  // here is silently dropped.
  trace.disable();
  spanExporter = new InMemorySpanExporter();
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);
});

afterEach(async () => {
  await tracerProvider?.shutdown();
  trace.disable();
  tracerProvider = null;
});

function destBasename(span: ReadableSpan): string {
  const p = span.attributes?.['fs.path'];
  if (typeof p !== 'string') return '';
  return p.split('/').pop() ?? '';
}

/** Full-file write ops (a move or an overwrite) landing on `<basename>`. */
function fullWritesTo(spans: ReadableSpan[], basename: string): ReadableSpan[] {
  return spans.filter(
    (s) =>
      (s.name === 'fs.renameSync' || s.name === 'fs.writeFileSync' || s.name === 'fs.rename') &&
      destBasename(s) === basename,
  );
}

function countByOp(spans: ReadableSpan[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of spans) out[s.name] = (out[s.name] ?? 0) + 1;
  return out;
}

async function renamePath(server: TestServer, fromPath: string, toPath: string): Promise<number> {
  const res = await fetch(`${server.baseUrl}/api/rename-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'file',
      fromPath,
      toPath,
      agentId: 'agent-rename-amp',
      agentName: 'RenameAmp',
    }),
  });
  return res.status;
}

describe('rename write-amplification — no-content-change rename writes destination once', () => {
  test('open provider, no self-link, no edit: destination written exactly once', async () => {
    const server = await createTestServer({ debounce: 200, maxDebounce: 1000 });
    let client: Awaited<ReturnType<typeof createTestClient>> | undefined;
    try {
      writeFileSync(join(server.contentDir, 'alpha.md'), '# Hello\n\nworld\n', 'utf-8');
      await awaitFileWatcherIndexed(server, 'alpha');

      client = await createTestClient(server.port, 'alpha');
      await pollUntil(() => getServerState(server, 'alpha') !== null, 8000, 25);
      await wait(700); // settle initial load/observers; NO edit performed

      spanExporter.reset();
      resetMetrics();

      expect(await renamePath(server, 'alpha.md', 'bravo.md')).toBe(200);
      await wait(2000); // post-rename reconcile window

      const spans = spanExporter.getFinishedSpans();
      const bWrites = fullWritesTo(spans, 'bravo.md');
      console.log(
        '[no-change] full writes to bravo.md =',
        bWrites.length,
        'byOp =',
        JSON.stringify(countByOp(bWrites)),
        '| persistenceDiskWrites =',
        getMetrics().persistenceDiskWrites,
      );

      // The move places the source bytes at the destination; with no content
      // change there is nothing to rewrite, so exactly one disk op should
      // touch the destination.
      expect(bWrites.length).toBe(1);
      // writeTracker no-regression: the move must be registerWrite()'d so the
      // file-watcher self-suppresses; a spurious reprocess would surface as an
      // async store write.
      expect(getMetrics().persistenceDiskWrites).toBe(0);
    } finally {
      await client?.cleanup();
      await server.cleanup();
    }
  }, 30_000);

  test('no open provider (control), no edit: destination written exactly once', async () => {
    const server = await createTestServer({ debounce: 200, maxDebounce: 1000 });
    try {
      writeFileSync(join(server.contentDir, 'gamma.md'), '# Hello\n\nworld\n', 'utf-8');
      await awaitFileWatcherIndexed(server, 'gamma');
      await wait(400); // deliberately no provider opened

      spanExporter.reset();
      resetMetrics();

      expect(await renamePath(server, 'gamma.md', 'delta.md')).toBe(200);
      await wait(2000);

      const dWrites = fullWritesTo(spanExporter.getFinishedSpans(), 'delta.md');
      console.log(
        '[control] full writes to delta.md =',
        dWrites.length,
        'byOp =',
        JSON.stringify(countByOp(dWrites)),
      );

      expect(dWrites.length).toBe(1);
      expect(getMetrics().persistenceDiskWrites).toBe(0);
    } finally {
      await server.cleanup();
    }
  }, 30_000);

  test('content DOES change (self-link rewrite): destination ends with correct bytes', async () => {
    // When the rename genuinely rewrites content ([[alpha]] -> [[bravo]]) the
    // second write is legitimate work — this test pins CORRECTNESS (final
    // bytes), not the write count, so the fix is not over-constrained into
    // breaking the content-changing path.
    const server = await createTestServer({ debounce: 200, maxDebounce: 1000 });
    let client: Awaited<ReturnType<typeof createTestClient>> | undefined;
    try {
      writeFileSync(join(server.contentDir, 'alpha.md'), '# Self\n\nlink to [[alpha]]\n', 'utf-8');
      await awaitFileWatcherIndexed(server, 'alpha');

      client = await createTestClient(server.port, 'alpha');
      await pollUntil(() => getServerState(server, 'alpha') !== null, 8000, 25);
      await wait(700);

      expect(await renamePath(server, 'alpha.md', 'bravo.md')).toBe(200);
      await wait(2000);

      const bravoFinal = readFileSync(join(server.contentDir, 'bravo.md'), 'utf-8');
      console.log('[content-change] final bravo.md =', JSON.stringify(bravoFinal));
      expect(bravoFinal).toContain('[[bravo]]');
      expect(bravoFinal).not.toContain('[[alpha]]');
    } finally {
      await client?.cleanup();
      await server.cleanup();
    }
  }, 30_000);

  test('doc with backlinks: the renamed destination is written exactly once', async () => {
    // referrer.md links to [[target]]; renaming target -> renamed rewrites
    // referrer's link (a legitimate single write to referrer) and must NOT
    // double-write the renamed doc's own destination.
    const server = await createTestServer({ debounce: 200, maxDebounce: 1000 });
    try {
      writeFileSync(join(server.contentDir, 'target.md'), '# Target\n\nbody\n', 'utf-8');
      writeFileSync(join(server.contentDir, 'referrer.md'), '# Ref\n\nsee [[target]]\n', 'utf-8');
      await awaitFileWatcherIndexed(server, 'target');
      await awaitFileWatcherIndexed(server, 'referrer');
      await wait(500);

      spanExporter.reset();
      resetMetrics();

      expect(await renamePath(server, 'target.md', 'renamed.md')).toBe(200);
      await wait(2000);

      const spans = spanExporter.getFinishedSpans();
      const renamedWrites = fullWritesTo(spans, 'renamed.md');
      console.log(
        '[backlinks] full writes to renamed.md =',
        renamedWrites.length,
        'byOp =',
        JSON.stringify(countByOp(renamedWrites)),
      );

      // The renamed doc's own content did not change → its destination is
      // written exactly once (the move).
      expect(renamedWrites.length).toBe(1);
      // referrer.md's link was rewritten → final content reflects the rename.
      expect(readFileSync(join(server.contentDir, 'referrer.md'), 'utf-8')).toContain(
        '[[renamed]]',
      );
    } finally {
      await server.cleanup();
    }
  }, 30_000);
});
