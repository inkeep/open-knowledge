import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspaceSearchDocument,
  type WorkspaceSearchDocument,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createOpenAiEmbedder } from './embedder.ts';
import {
  createFakeEmbeddingsFetch,
  type FakeEmbeddingsProviderOptions,
} from './fake-provider.test-helper.ts';
import { MAX_DIMS_DRIFT_RESETS, SemanticSearchService } from './semantic-search-service.ts';

const BASE_URL = 'https://fake-provider.test/v1';

function doc(path: string, content: string, modifiedTs = 1): WorkspaceSearchDocument {
  return createWorkspaceSearchDocument({ kind: 'page', path, title: path, content, modifiedTs });
}

const corpus = [
  doc('session-tokens', 'The session token refresh flow re-issues credentials when they expire.'),
  doc('sourdough', 'A recipe for sourdough bread with a long cold ferment.'),
];

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'ok-autodims-'));
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

interface Rig {
  service: SemanticSearchService;
  requests: { input: string[]; dimensions?: number }[];
}

function makeService(
  provider: FakeEmbeddingsProviderOptions,
  over: { dimensions?: number; model?: string } = {},
): Rig {
  const model = over.model ?? 'fake-model';
  const { fetchImpl, requests } = createFakeEmbeddingsFetch(provider);
  const service = new SemanticSearchService({
    loadEmbedder: () =>
      Promise.resolve(
        createOpenAiEmbedder(
          { baseUrl: BASE_URL, model, dimensions: over.dimensions, apiKey: 'sk-fake' },
          { fetchImpl, sleep: () => Promise.resolve() },
        ),
      ),
    cacheDir,
    enabled: true,
    providerFingerprint: `${BASE_URL}|${model}|${over.dimensions ?? 'auto'}`,
  });
  return { service, requests };
}

function readManifest(): { dims: number; identityDims: number | 'auto' } {
  return JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf-8'));
}

describe('auto-detected embedding dimensions', () => {
  test('a 1024-dim model with no configured size embeds and retrieves', async () => {
    const { service } = makeService({ dims: 1024 });
    await service.embedCorpus(corpus);

    expect(service.getStatus().embeddedCount).toBe(corpus.length);
    const scores = await service.queryScores('session credentials', corpus);
    expect(scores?.size).toBe(corpus.length);
    expect(readManifest().dims).toBe(1024);
  });

  test('the detected size survives a restart without re-embedding', async () => {
    const first = makeService({ dims: 1024 });
    await first.service.embedCorpus(corpus);
    const requestsAfterFirstRun = first.requests.length;
    expect(requestsAfterFirstRun).toBeGreaterThan(0);

    const second = makeService({ dims: 1024 });
    await second.service.embedCorpus(corpus);

    expect(second.requests).toHaveLength(0);
    expect(second.service.getStatus().embeddedCount).toBe(corpus.length);
  });

  test('identity is the "auto" sentinel, never the detected value', async () => {
    const { service } = makeService({ dims: 1024 });
    await service.embedCorpus(corpus);
    const manifest = readManifest();
    expect(manifest.identityDims).toBe('auto');
    expect(manifest.dims).toBe(1024);
  });

  test('a legacy manifest (no identityDims) is adopted, not re-embedded', async () => {
    const first = makeService({ dims: 1536 });
    await first.service.embedCorpus(corpus);

    const manifestPath = join(cacheDir, 'manifest.json');
    const legacy = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    delete legacy.identityDims;
    rmSync(manifestPath);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(manifestPath, JSON.stringify(legacy));

    const second = makeService({ dims: 1536 });
    await second.service.embedCorpus(corpus);
    expect(second.requests).toHaveLength(0);
    expect(second.service.getStatus().embeddedCount).toBe(corpus.length);
  });

  test('a provider that swaps model size mid-life rebuilds instead of dying', async () => {
    const { service, requests } = makeService({
      dims: 1024,
      driftDims: 1536,
      driftAfterRequests: 1,
    });
    await service.embedCorpus(corpus);
    expect(service.getStatus().embeddedCount).toBeGreaterThan(0);
    const afterFirst = requests.length;

    await service.embedCorpus(corpus.map((d) => doc(d.path, `${d.content} updated`, 2)));
    expect(requests.length).toBeGreaterThan(afterFirst);

    const updated = corpus.map((d) => doc(d.path, `${d.content} updated`, 2));
    await service.embedCorpus(updated);
    expect(service.getStatus().embeddedCount).toBe(updated.length);
    expect(readManifest().dims).toBe(1536);
  });

  test('a query-side size change recovers even when no document changed', async () => {
    const { service } = makeService({ dims: 1024, driftDims: 1536, driftAfterRequests: 1 });
    await service.embedCorpus(corpus);
    expect(service.getStatus().embeddedCount).toBe(corpus.length);

    expect(await service.queryScores('session credentials', corpus)).toBeNull();
    expect(service.getStatus().ready).toBe(false);

    await service.embedCorpus(corpus);
    const scores = await service.queryScores('session credentials', corpus);
    expect(scores?.size).toBe(corpus.length);
    expect(readManifest().dims).toBe(1536);
  });

  test('survives exactly MAX_DIMS_DRIFT_RESETS size changes, then gives up', async () => {
    expect(MAX_DIMS_DRIFT_RESETS).toBe(2);

    let servedDims = 1024;
    const requests: string[][] = [];
    const fetchImpl = ((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      requests.push(body.input);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: body.input.map((_t, index) => ({
              index,
              embedding: Array.from({ length: servedDims }, (_, i) => Math.sin(i + index)),
            })),
          }),
        text: () => Promise.resolve(''),
      } as Response);
    }) as unknown as typeof fetch;

    const service = new SemanticSearchService({
      loadEmbedder: () =>
        Promise.resolve(
          createOpenAiEmbedder(
            { baseUrl: BASE_URL, model: 'aliased', apiKey: 'sk-fake' },
            { fetchImpl, sleep: () => Promise.resolve() },
          ),
        ),
      cacheDir,
      enabled: true,
      providerFingerprint: `${BASE_URL}|aliased|auto`,
    });

    let version = 0;
    const nextCorpus = () => corpus.map((d) => doc(d.path, `${d.content} v${++version}`, version));

    await service.embedCorpus(nextCorpus());
    expect(service.getStatus().capable).toBe(true);

    for (let swap = 1; swap <= MAX_DIMS_DRIFT_RESETS; swap++) {
      servedDims = servedDims === 1024 ? 1536 : 1024;
      await service.embedCorpus(nextCorpus());
      await service.embedCorpus(nextCorpus());
      expect(service.getStatus().capable).toBe(true);
      expect(service.getStatus().embeddedCount).toBe(corpus.length);
    }

    servedDims = servedDims === 1024 ? 1536 : 1024;
    await service.embedCorpus(nextCorpus());
    expect(service.getStatus().capable).toBe(false);

    const spent = requests.length;
    await service.embedCorpus(nextCorpus());
    expect(await service.queryScores('session credentials', corpus)).toBeNull();
    expect(requests.length).toBe(spent);

    service.applyConfig({ enabled: true, providerFingerprint: `${BASE_URL}|other|auto` });
    await service.embedCorpus(nextCorpus());
    await service.embedCorpus(nextCorpus());
    expect(requests.length).toBeGreaterThan(spent);
    expect(service.getStatus().capable).toBe(true);
    expect(service.getStatus().embeddedCount).toBe(corpus.length);
  });

  test('changing the model resets coverage to zero, then refills at the new size', async () => {
    const first = makeService({ dims: 1536 });
    await first.service.embedCorpus(corpus);
    expect(first.service.getStatus().embeddedCount).toBe(corpus.length);

    first.service.applyConfig({
      enabled: true,
      providerFingerprint: `${BASE_URL}|another-model|auto`,
    });
    expect(first.service.getStatus().embeddedCount).toBe(0);

    const second = makeService({ dims: 1024 }, { model: 'another-model' });
    await second.service.embedCorpus(corpus);
    expect(second.service.getStatus().embeddedCount).toBe(corpus.length);
    expect(readManifest().dims).toBe(1024);
  });

  test('an explicitly configured size that the server ignores fails loudly, no rebuild', async () => {
    const { service, requests } = makeService(
      { dims: 1024, ignoreDimensionsParam: true },
      { dimensions: 1536 },
    );
    await service.embedCorpus(corpus);

    expect(requests[0]?.dimensions).toBe(1536);
    expect(service.getStatus().embeddedCount).toBe(0);
    expect(requests).toHaveLength(1);
  });
});
