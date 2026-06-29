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

      expect(bWrites.length).toBe(1);
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

      expect(renamedWrites.length).toBe(1);
      expect(readFileSync(join(server.contentDir, 'referrer.md'), 'utf-8')).toContain(
        '[[renamed]]',
      );
    } finally {
      await server.cleanup();
    }
  }, 30_000);
});
