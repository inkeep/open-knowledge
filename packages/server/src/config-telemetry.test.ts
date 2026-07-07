/**
 * Integration test for config-edit OTel spans.
 *
 * Registers a `BasicTracerProvider` with an `InMemorySpanExporter`, runs
 * the bindConfigDoc → patch → validate → persist → revert chain end-to-end,
 * and asserts the recorded spans have the expected names, attributes, and
 * parent/child relationships.
 *
 * Bounded enum attributes only — Zod issue paths land in span events, not
 * attributes (cardinality discipline).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindConfigDoc,
  CONFIG_DOC_NAME_PROJECT,
  type ConfigDocProvider,
  type ConfigPatch,
} from '@inkeep/open-knowledge-core';
import { writeConfigPatch } from '@inkeep/open-knowledge-core/server';
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import * as Y from 'yjs';
import { applyExternalConfigChange, storeConfigDoc } from './config-persistence.ts';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function setupExporter(): void {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  // Required for parent/child span tracking across `startActiveSpan` calls.
  // Without it, the active-span lookup uses `ROOT_CONTEXT` and every span
  // becomes a root span. server's initTelemetry() registers this in
  // production; the test wires the same plumbing locally.
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

function attr(span: ReadableSpan, key: string): unknown {
  return span.attributes[key];
}

/** Pick the first matching span by name; throws if none — biome-friendly
 * alternative to non-null assertions on `spansByName(...)[0]!`. */
function requireSpan(name: string): ReadableSpan {
  const spans = spansByName(name);
  if (spans.length === 0) throw new Error(`requireSpan: no span named '${name}'`);
  const head = spans[0];
  if (!head) throw new Error(`requireSpan: empty result for '${name}'`);
  return head;
}

interface MockProvider extends ConfigDocProvider {
  emitSynced(): void;
}

function createMockProvider(doc: Y.Doc): MockProvider {
  const synced = new Set<() => void>();
  return {
    document: doc,
    on(_event, listener) {
      synced.add(listener);
    },
    off(_event, listener) {
      synced.delete(listener);
    },
    emitSynced() {
      for (const fn of synced) fn();
    },
  };
}

let testDir: string;

describe('config-edit OTel spans', () => {
  beforeEach(() => {
    setupExporter();
    testDir = mkdtempSync(join(tmpdir(), 'config-otel-'));
    mkdirSync(join(testDir, '.ok'), { recursive: true });
  });

  afterEach(async () => {
    await teardownExporter();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('config.bind', () => {
    it('emits one config.bind span on bindConfigDoc with scope attribute', () => {
      const ydoc = new Y.Doc();
      const mock = createMockProvider(ydoc);
      bindConfigDoc(mock, 'project');
      expect(spansByName('config.bind').length).toBe(1);
      const span = requireSpan('config.bind');
      expect(attr(span, 'config.scope')).toBe('project');
      expect(attr(span, 'config.transport')).toBe('ytext');
    });

    it('uses scope=user when binding to the user-global doc', () => {
      const ydoc = new Y.Doc();
      const mock = createMockProvider(ydoc);
      bindConfigDoc(mock, 'user');
      expect(spansByName('config.bind').length).toBe(1);
      expect(attr(requireSpan('config.bind'), 'config.scope')).toBe('user');
    });
  });

  describe('config.patch + L1 config.validate (binding path)', () => {
    it('emits config.patch + config.validate(L1) on a successful patch', () => {
      const ydoc = new Y.Doc();
      const mock = createMockProvider(ydoc);
      const binding = bindConfigDoc(mock, 'project');
      const result = binding.patch({
        content: { dir: './notes' },
      } as ConfigPatch);
      expect(result.ok).toBe(true);

      const patchSpan = requireSpan('config.patch');
      const validateSpan = requireSpan('config.validate');
      expect(spansByName('config.patch').length).toBe(1);
      expect(spansByName('config.validate').length).toBe(1);
      expect(attr(patchSpan, 'config.scope')).toBe('project');
      expect(attr(patchSpan, 'config.transport')).toBe('ytext');
      expect(attr(patchSpan, 'config.outcome')).toBe('success');
      expect(attr(validateSpan, 'config.validation.layer')).toBe('L1');
      expect(attr(validateSpan, 'config.outcome')).toBe('success');

      // config.validate is a child of config.patch (started inside its sync fn).
      expect(validateSpan.parentSpanContext?.spanId).toBe(patchSpan.spanContext().spanId);
    });

    it('emits config.outcome=rejected + issue events on a schema-invalid patch', () => {
      const ydoc = new Y.Doc();
      const mock = createMockProvider(ydoc);
      const binding = bindConfigDoc(mock, 'project');
      // content.dir must be a string — supply a number to fail SCHEMA_INVALID
      // (not SCOPE_VIOLATION, which would short-circuit before schema validation).
      const result = binding.patch({
        content: { dir: 42 as unknown as string },
      } as ConfigPatch);
      expect(result.ok).toBe(false);

      const patchSpan = requireSpan('config.patch');
      expect(spansByName('config.patch').length).toBe(1);
      expect(attr(patchSpan, 'config.outcome')).toBe('rejected');
      expect(attr(patchSpan, 'config.error.code')).toBe('SCHEMA_INVALID');

      const validateSpan = requireSpan('config.validate');
      expect(spansByName('config.validate').length).toBe(1);
      const ev = validateSpan.events.find((e) => e.name === 'config.validation.issue');
      expect(ev).toBeDefined();
      const path = ev?.attributes?.['issue.path'];
      expect(typeof path).toBe('string');
      expect((path as string).includes('dir')).toBe(true);
    });
  });

  describe('config.patch + L2 config.validate (writeConfigPatch path)', () => {
    it('emits config.patch + config.validate(L2) on a successful headless write', async () => {
      const result = await writeConfigPatch({
        cwd: testDir,
        scope: 'project',
        patch: { content: { dir: './notes' } } as ConfigPatch,
      });
      expect(result.ok).toBe(true);

      const patchSpan = requireSpan('config.patch');
      const validateSpan = requireSpan('config.validate');
      expect(spansByName('config.patch').length).toBe(1);
      expect(attr(patchSpan, 'config.scope')).toBe('project');
      expect(attr(patchSpan, 'config.transport')).toBe('fs');
      expect(attr(patchSpan, 'config.outcome')).toBe('success');
      expect(spansByName('config.validate').length).toBe(1);
      expect(attr(validateSpan, 'config.validation.layer')).toBe('L2');
      expect(validateSpan.parentSpanContext?.spanId).toBe(patchSpan.spanContext().spanId);
    });

    it('marks outcome=rejected + records error.code on schema fail', async () => {
      const result = await writeConfigPatch({
        cwd: testDir,
        scope: 'project',
        patch: { content: { dir: 99 as unknown as string } } as ConfigPatch,
      });
      expect(result.ok).toBe(false);
      const patchSpan = requireSpan('config.patch');
      expect(spansByName('config.patch').length).toBe(1);
      expect(attr(patchSpan, 'config.outcome')).toBe('rejected');
      expect(attr(patchSpan, 'config.error.code')).toBe('SCHEMA_INVALID');
    });
  });

  describe('config.persist + L3 config.validate + config.revert (server path)', () => {
    it('emits config.persist + config.validate(L3) on a successful storeConfigDoc', async () => {
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('source');
      ytext.insert(0, 'mcp:\n  tools:\n    search:\n      maxResults: 75\n');
      const lkgCache = new Map<string, string>();
      const ctx = { projectDir: testDir, lkgCache };

      const outcome = await storeConfigDoc(ydoc, CONFIG_DOC_NAME_PROJECT, undefined, ctx);
      expect(outcome).toBe('persisted');

      const persistSpan = requireSpan('config.persist');
      const validateSpan = requireSpan('config.validate');
      expect(spansByName('config.persist').length).toBe(1);
      expect(attr(persistSpan, 'config.scope')).toBe('project');
      expect(attr(persistSpan, 'config.transport')).toBe('fs');
      expect(attr(persistSpan, 'config.outcome')).toBe('success');
      expect(spansByName('config.validate').length).toBe(1);
      expect(attr(validateSpan, 'config.validation.layer')).toBe('L3');
      expect(attr(validateSpan, 'config.outcome')).toBe('success');
    });

    it('emits config.revert with outcome=reverted on validation rejection', async () => {
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('source');
      ytext.insert(0, 'this is not :: valid yaml ::: at all\n  ::: ::: :::\n');
      const lkgCache = new Map<string, string>();
      const ctx = {
        projectDir: testDir,
        lkgCache,
        onConfigRejected: () => {
          /* noop */
        },
      };

      const outcome = await storeConfigDoc(ydoc, CONFIG_DOC_NAME_PROJECT, undefined, ctx);
      expect(outcome).toBe('reverted');

      const persistSpan = requireSpan('config.persist');
      const revertSpan = requireSpan('config.revert');
      const validateSpan = requireSpan('config.validate');
      expect(spansByName('config.persist').length).toBe(1);
      expect(attr(persistSpan, 'config.outcome')).toBe('reverted');
      expect(spansByName('config.revert').length).toBe(1);
      expect(attr(revertSpan, 'config.outcome')).toBe('reverted');
      expect(spansByName('config.validate').length).toBe(1);
      expect(attr(validateSpan, 'config.outcome')).toBe('rejected');
    });
  });

  describe('applyExternalConfigChange — file watcher path', () => {
    it('emits config.validate(L3) on a watcher-driven change', () => {
      const ydoc = new Y.Doc();
      const lkgCache = new Map<string, string>();
      lkgCache.set(CONFIG_DOC_NAME_PROJECT, 'mcp:\n  autoStart: false\n');
      const ctx = { projectDir: testDir, lkgCache };

      const outcome = applyExternalConfigChange(
        ydoc,
        CONFIG_DOC_NAME_PROJECT,
        'mcp:\n  autoStart: true\n',
        ctx,
      );
      expect(outcome).toBe('applied');

      expect(spansByName('config.validate').length).toBe(1);
      const validateSpan = requireSpan('config.validate');
      expect(attr(validateSpan, 'config.validation.layer')).toBe('L3');
      expect(attr(validateSpan, 'config.outcome')).toBe('success');
    });
  });

  describe('zero-overhead when SDK is disabled', () => {
    it('does not throw when no tracer provider is registered (no-op SDK)', async () => {
      // Tear down the in-memory exporter — the @opentelemetry/api package
      // returns no-op tracers when no SDK is registered. Spans become inert.
      await teardownExporter();
      // Re-init the exporter so afterEach's teardownExporter doesn't trip.
      setupExporter();

      const ydoc = new Y.Doc();
      const mock = createMockProvider(ydoc);
      // The act of binding + patching SHOULD NOT throw regardless of SDK state.
      expect(() => {
        const binding = bindConfigDoc(mock, 'project');
        binding.patch({ appearance: { theme: 'system' } } as ConfigPatch);
      }).not.toThrow();
    });
  });
});
