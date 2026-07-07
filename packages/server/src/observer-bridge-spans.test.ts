/**
 * Integration tests for server-bridge spans.
 *
 * Registers a `BasicTracerProvider` with an `InMemorySpanExporter`,
 * exercises a representative bridge cycle (composeAndWriteRawBody under
 * a transact + observer A/B settlement dispatch), and asserts:
 *   - bridge.composeAndWriteRawBody appears with surface + body.bytes + doc.name
 *   - md.parseWithFallback appears with body.bytes + doc.name
 *   - observer.runASync / runBSync / dispatch appear with the expected
 *     enum-only attributes
 *   - no unbounded-cardinality attribute names slip in
 *
 * Bounded-enum + pre-validated string attributes only (STOP
 * rule: no raw paths, no doc content, no free-form user strings).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake';
import { mdManager, schema } from './md-manager';
import { setupServerObservers } from './server-observers';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function setupExporter(): void {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
}

async function teardownExporter(): Promise<void> {
  await provider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
}

function spansByName(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((s) => s.name === name);
}

const ALLOWED_BRIDGE_ATTRIBUTE_KEYS = new Set([
  'surface',
  'body.bytes',
  'doc.name',
  'observer.a.path',
  'observer.dispatch',
  'merge.bytes_changed',
]);

beforeEach(() => {
  setupExporter();
});

afterEach(async () => {
  await teardownExporter();
});

describe('FR6 / AC10 — server bridge spans', () => {
  it('emits bridge.composeAndWriteRawBody with surface, body.bytes, doc.name on agent write', () => {
    const doc = new Y.Doc();
    doc.gc = false;
    composeAndWriteRawBody(doc, '# Hello\n\nworld\n', 'agent');
    const span = spansByName('bridge.composeAndWriteRawBody')[0];
    expect(span).toBeDefined();
    expect(span?.attributes.surface).toBe('agent');
    expect(span?.attributes['body.bytes']).toBe(15);
    expect(typeof span?.attributes['doc.name']).toBe('string');
  });

  it('emits bridge.composeAndWriteRawBody with surface=file-watcher when called from disk path', () => {
    const doc = new Y.Doc();
    doc.gc = false;
    composeAndWriteRawBody(doc, 'body\n', 'file-watcher');
    const span = spansByName('bridge.composeAndWriteRawBody')[0];
    expect(span?.attributes.surface).toBe('file-watcher');
  });

  it('emits md.parseWithFallback with body.bytes + doc.name as a child of compose', () => {
    const doc = new Y.Doc();
    doc.gc = false;
    composeAndWriteRawBody(doc, '---\nfoo: bar\n---\nbody\n', 'agent');
    const parse = spansByName('md.parseWithFallback')[0];
    expect(parse).toBeDefined();
    // body excludes frontmatter, so byte count is just 'body\n' (5).
    expect(parse?.attributes['body.bytes']).toBe(5);
  });

  it('observer.runASync / runBSync / dispatch fire with bounded-cardinality attrs', () => {
    const doc = new Y.Doc();
    doc.gc = false;
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager,
      schema,
      docName: 'README',
    });
    try {
      // A non-paired Y.Text mutation forces Observer B to run on dispatch.
      doc.transact(() => {
        ytext.insert(0, '# Hi\n');
      });
      const dispatch = spansByName('observer.dispatch')[0];
      expect(dispatch).toBeDefined();
      const obDispatch = dispatch?.attributes['observer.dispatch'];
      expect(['a', 'b', 'a-then-b', 'none']).toContain(obDispatch as string);
      // runBSync should fire because the Y.Text mutation triggers Observer B.
      const runB = spansByName('observer.runBSync')[0];
      expect(runB).toBeDefined();
      expect(runB?.attributes['doc.name']).toBe('README');
    } finally {
      cleanup();
    }
  });

  it('no unbounded-cardinality attribute names appear on bridge spans', () => {
    const doc = new Y.Doc();
    doc.gc = false;
    composeAndWriteRawBody(doc, '# T\n', 'agent');
    const compose = spansByName('bridge.composeAndWriteRawBody')[0];
    const parse = spansByName('md.parseWithFallback')[0];
    for (const span of [compose, parse]) {
      if (!span) continue;
      for (const key of Object.keys(span.attributes)) {
        // Allow well-known telemetry-base attrs (otel.* / sdk.*) through.
        if (key.startsWith('otel.') || key.startsWith('sdk.')) continue;
        expect(ALLOWED_BRIDGE_ATTRIBUTE_KEYS.has(key)).toBe(true);
      }
    }
  });
});
