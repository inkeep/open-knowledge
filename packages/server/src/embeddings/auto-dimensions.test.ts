/**
 * Auto-detected vector dimensions, end to end: the real HTTP embedder against
 * the fake provider (`fake-provider.test-helper.ts`), driven by the real
 * service and persisted through the real cache.
 *
 * What this is guarding: with `search.semantic.dimensions` unset, the embedder
 * used to declare 1536 and reject every response from any model of another
 * size, which surfaced to the user as "semantic search silently does nothing".
 * Nothing below uses the concept embedder — it bypasses the HTTP client, so it
 * cannot see this class of bug at all.
 */

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

/** A service wired to the real embedder over a fake provider socket-alike. */
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

    // Same config, same cache dir — a fresh process.
    const second = makeService({ dims: 1024 });
    await second.service.embedCorpus(corpus);

    expect(second.requests).toHaveLength(0); // nothing re-embedded
    expect(second.service.getStatus().embeddedCount).toBe(corpus.length);
  });

  test('identity is the "auto" sentinel, never the detected value', async () => {
    const { service } = makeService({ dims: 1024 });
    await service.embedCorpus(corpus);
    const manifest = readManifest();
    // The two must differ in kind: folding the detected length into the
    // identity is what would make every restart look like a config change.
    expect(manifest.identityDims).toBe('auto');
    expect(manifest.dims).toBe(1024);
  });

  test('a legacy manifest (no identityDims) is adopted, not re-embedded', async () => {
    const first = makeService({ dims: 1536 });
    await first.service.embedCorpus(corpus);

    // Rewrite the manifest in the pre-split shape an older build wrote.
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
    // Serve the first pass at 1024, then answer everything at 1536.
    const { service, requests } = makeService({
      dims: 1024,
      driftDims: 1536,
      driftAfterRequests: 1,
    });
    await service.embedCorpus(corpus);
    expect(service.getStatus().embeddedCount).toBeGreaterThan(0);
    const afterFirst = requests.length;

    // The drift shows up on the next pass; the service discards and re-warms.
    await service.embedCorpus(corpus.map((d) => doc(d.path, `${d.content} updated`, 2)));
    expect(requests.length).toBeGreaterThan(afterFirst);

    // A further pass now succeeds at the new size rather than staying dead.
    const updated = corpus.map((d) => doc(d.path, `${d.content} updated`, 2));
    await service.embedCorpus(updated);
    expect(service.getStatus().embeddedCount).toBe(updated.length);
    expect(readManifest().dims).toBe(1536);
  });

  test('a query-side size change recovers even when no document changed', async () => {
    const { service } = makeService({ dims: 1024, driftDims: 1536, driftAfterRequests: 1 });
    await service.embedCorpus(corpus);
    expect(service.getStatus().embeddedCount).toBe(corpus.length);

    // The corpus is unchanged, so every embed pass is a no-op reconcile: the
    // query path is the only place the size change can be noticed. Without
    // recovery here, semantic search stays silently dead until a doc changes.
    expect(await service.queryScores('session credentials', corpus)).toBeNull();
    expect(service.getStatus().ready).toBe(false); // warm state dropped

    await service.embedCorpus(corpus);
    const scores = await service.queryScores('session credentials', corpus);
    expect(scores?.size).toBe(corpus.length);
    expect(readManifest().dims).toBe(1536);
  });

  test('survives exactly MAX_DIMS_DRIFT_RESETS size changes, then gives up', async () => {
    // Pinned deliberately: the budget is a spend ceiling AND the headroom a
    // legitimate model update needs. A silent change to either side should
    // require touching this line.
    expect(MAX_DIMS_DRIFT_RESETS).toBe(2);

    // A provider whose size changes only when the test says so, so each drift
    // event is one deliberate step rather than a side effect of call ordering.
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

    // Each iteration is one size change the service is expected to absorb.
    for (let swap = 1; swap <= MAX_DIMS_DRIFT_RESETS; swap++) {
      servedDims = servedDims === 1024 ? 1536 : 1024;
      await service.embedCorpus(nextCorpus()); // drift → discard + re-warm
      await service.embedCorpus(nextCorpus()); // rebuild at the new size
      expect(service.getStatus().capable).toBe(true);
      expect(service.getStatus().embeddedCount).toBe(corpus.length);
    }

    // One more than the budget allows: give up rather than keep paying.
    servedDims = servedDims === 1024 ? 1536 : 1024;
    await service.embedCorpus(nextCorpus());
    expect(service.getStatus().capable).toBe(false);

    // And staying given-up costs nothing: no further provider calls, no scores.
    const spent = requests.length;
    await service.embedCorpus(nextCorpus());
    expect(await service.queryScores('session credentials', corpus)).toBeNull();
    expect(requests.length).toBe(spent);

    // A deliberate provider change is a fresh start, not a permanently spent
    // budget. Asserting `capable` directly is what catches the budget reset
    // being moved into `resetWarm`, which drift recovery calls itself.
    service.applyConfig({ enabled: true, providerFingerprint: `${BASE_URL}|other|auto` });
    await service.embedCorpus(nextCorpus()); // drifts again — only recoverable on a refunded budget
    await service.embedCorpus(nextCorpus()); // rebuilds at the current size
    expect(requests.length).toBeGreaterThan(spent);
    expect(service.getStatus().capable).toBe(true);
    expect(service.getStatus().embeddedCount).toBe(corpus.length);
  });

  test('changing the model resets coverage to zero, then refills at the new size', async () => {
    const first = makeService({ dims: 1536 });
    await first.service.embedCorpus(corpus);
    expect(first.service.getStatus().embeddedCount).toBe(corpus.length);

    // What the Settings coverage panel reads after an endpoint/model change.
    first.service.applyConfig({
      enabled: true,
      providerFingerprint: `${BASE_URL}|another-model|auto`,
    });
    expect(first.service.getStatus().embeddedCount).toBe(0);

    const second = makeService({ dims: 1024 }, { model: 'another-model' });
    await second.service.embedCorpus(corpus);
    expect(second.service.getStatus().embeddedCount).toBe(corpus.length);
    expect(readManifest().dims).toBe(1024); // the old 1536 vectors are gone
  });

  test('an explicitly configured size that the server ignores fails loudly, no rebuild', async () => {
    const { service, requests } = makeService(
      { dims: 1024, ignoreDimensionsParam: true },
      { dimensions: 1536 },
    );
    await service.embedCorpus(corpus);

    expect(requests[0]?.dimensions).toBe(1536); // we asked
    expect(service.getStatus().embeddedCount).toBe(0); // it lied; nothing cached
    // Re-embedding cannot fix a server that ignores the param, so the pass
    // stops after one rejected batch instead of paying for the whole corpus.
    expect(requests).toHaveLength(1);
  });
});
