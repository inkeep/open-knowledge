/**
 * Telemetry assertions for the rename + rollback handlers — locks in the
 * `ok.rename.attribution_kind` counter shape (per-rename increment with
 * `kind` ∈ {rename-file, rename-folder, rollback} × `attribution_kind` ∈
 * {agent, principal, anonymous}). A regression that drops the counter
 * call, mistypes the attribute keys, or fires on a 400-validation path
 * would silently degrade observability without these assertions.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { Principal } from '@inkeep/open-knowledge-core';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { __resetRenameTelemetryForTesting, createApiExtension } from './api-extension.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { swapContributors } from './contributor-tracker.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { resetMetrics } from './metrics.ts';

function buildFileIndex(contentDir: string): ReadonlyMap<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const stat = statSync(fullPath);
      const docName = fullPath.slice(contentDir.length + 1).replace(/\.md$/, '');
      index.set(docName, { size: stat.size, modified: stat.mtime.toISOString() });
    }
  }
  walk(contentDir);
  return index;
}

interface CapturedResponse {
  status: number;
  body: string;
}

function makeReq(url: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const readable = Readable.from(Buffer.from(raw)) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function buildBacklinkIndex(contentDir: string): Promise<BacklinkIndex> {
  const index = new BacklinkIndex({ projectDir: contentDir, contentDir });
  await index.rebuildFromDisk();
  return index;
}

let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;
let provider: MeterProvider;

beforeAll(() => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  __resetRenameTelemetryForTesting();
});

afterAll(async () => {
  await provider.shutdown();
  metrics.disable();
});

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-rename-telem-'));
  swapContributors();
  resetMetrics();
  exporter.reset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface CallOpts {
  getPrincipal?: () => Principal | null;
}

async function callApi(
  contentDir: string,
  url: string,
  body: unknown,
  opts: CallOpts = {},
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus: {
      documents: new Map(),
      closeConnections() {},
      unloadDocument: async () => {},
      debouncer: {
        isDebounced: () => false,
        executeNow: async () => undefined,
      },
    } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {
      closeSession: async () => {},
      closeAllForDoc: async () => {},
    } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    getFileIndex: () => buildFileIndex(contentDir),
    backlinkIndex: await buildBacklinkIndex(contentDir),
    ...(opts.getPrincipal ? { getPrincipal: opts.getPrincipal } : {}),
  });
  const req = makeReq(url, body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

interface CounterPoint {
  value: number;
  attributes: Record<string, unknown>;
}

async function collectAttributionPoints(): Promise<CounterPoint[]> {
  exporter.reset();
  await reader.forceFlush();
  const collected = exporter.getMetrics();
  const points: CounterPoint[] = [];
  // Only the latest export — `exporter.reset()` clears prior accumulations
  // so each call returns the cumulative state at this moment, not the
  // history of every prior collect (which compounds the apparent value).
  for (const rm of collected) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.descriptor.name !== 'ok.rename.attribution_kind') continue;
        for (const dp of metric.dataPoints as Array<DataPoint<number>>) {
          points.push({ value: dp.value, attributes: { ...dp.attributes } });
        }
      }
    }
  }
  return points;
}

describe('ok.rename.attribution_kind counter — rename', () => {
  test('file rename without identity records anonymous attribution', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
    });
    expect(response.status).toBe(200);

    const points = await collectAttributionPoints();
    const anonFile = points.find(
      (p) => p.attributes.kind === 'rename-file' && p.attributes.attribution_kind === 'anonymous',
    );
    expect(anonFile?.value).toBeGreaterThanOrEqual(1);
  });

  test('file rename with body.agentId records agent attribution', async () => {
    writeFileSync(join(tmpDir, 'auth.md'), '# Auth\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'auth',
      toPath: 'sso',
      agentId: 'claude-1',
      agentName: 'Claude',
    });
    expect(response.status).toBe(200);

    const points = await collectAttributionPoints();
    const agentFile = points.find(
      (p) => p.attributes.kind === 'rename-file' && p.attributes.attribution_kind === 'agent',
    );
    expect(agentFile?.value).toBeGreaterThanOrEqual(1);
  });

  test('file rename with loaded principal (no agentId) records principal attribution', async () => {
    writeFileSync(join(tmpDir, 'auth.md'), '# Auth\n', 'utf-8');
    const principal: Principal = {
      id: 'principal-fixture',
      display_name: 'Miles',
      display_email: 'miles@example.com',
      source: 'principal.json',
      created_at: '2026-04-29T00:00:00.000Z',
    };
    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'file', fromPath: 'auth', toPath: 'sso' },
      { getPrincipal: () => principal },
    );
    expect(response.status).toBe(200);

    const points = await collectAttributionPoints();
    const principalFile = points.find(
      (p) => p.attributes.kind === 'rename-file' && p.attributes.attribution_kind === 'principal',
    );
    expect(principalFile?.value).toBeGreaterThanOrEqual(1);
  });

  test('folder rename increments the rename-folder kind label', async () => {
    mkdirSync(join(tmpDir, 'articles'));
    writeFileSync(join(tmpDir, 'articles', 'auth.md'), '# Auth\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'folder',
      fromPath: 'articles',
      toPath: 'essays',
    });
    expect(response.status).toBe(200);

    const points = await collectAttributionPoints();
    const folder = points.find((p) => p.attributes.kind === 'rename-folder');
    expect(folder?.value).toBeGreaterThanOrEqual(1);
  });

  test('400 invalid-summary path does NOT increment the counter', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const baseline = await collectAttributionPoints();
    const baselineSum = baseline.reduce((acc, p) => acc + (p.value as number), 0);

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
      summary: 42,
    });
    expect(response.status).toBe(400);

    const after = await collectAttributionPoints();
    const afterSum = after.reduce((acc, p) => acc + (p.value as number), 0);
    expect(afterSum).toBe(baselineSum);
  });
});
