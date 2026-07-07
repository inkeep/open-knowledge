import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashContent, VectorCache } from './vector-cache.ts';

const DIMS = 4;
function vec(...xs: number[]): Float32Array {
  return Float32Array.from(xs);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ok-veccache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCache(
  over: Partial<{ providerId: string; modelId: string; chunkConfigId: string }> = {},
): VectorCache {
  return new VectorCache({
    cacheDir: dir,
    providerId: over.providerId ?? 'https://api.test/v1',
    modelId: over.modelId ?? 'test-model',
    dims: DIMS,
    chunkConfigId: over.chunkConfigId ?? 'c1-o0',
  });
}

describe('VectorCache', () => {
  test('store → persist → re-init round-trips vectors', async () => {
    const a = makeCache();
    await a.init();
    const hash = hashContent('hello');
    a.store('page:doc-a', hash, 100, [vec(1, 0, 0, 0), vec(0, 1, 0, 0)]);
    await a.persist();
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(dir, 'vec', `${hash}.bin`))).toBe(true);

    const b = makeCache();
    await b.init();
    const loaded = b.getVectors('page:doc-a');
    expect(loaded?.length).toBe(2);
    expect(Array.from(loaded?.[0])).toEqual([1, 0, 0, 0]);
    expect(b.isFresh('page:doc-a', 100)).toBe(true);
    expect(b.isFresh('page:doc-a', 101)).toBe(false); // mtime moved
  });

  test('link reuses identical content across docs (content-addressed dedup)', async () => {
    const c = makeCache();
    await c.init();
    const hash = hashContent('shared body');
    c.store('page:a', hash, 1, [vec(1, 1, 1, 1)]);
    // A different doc with the same content reuses the blob without embedding.
    expect(c.link('page:b', hash, 2)).toBe(true);
    expect(c.getVectors('page:b')).toBeDefined();
    await c.persist();
    // Only one blob on disk for the shared hash.
    const blobs = readdirSync(join(dir, 'vec'));
    expect(blobs).toEqual([`${hash}.bin`]);
  });

  test('link returns false when no vectors are held for the hash', async () => {
    const c = makeCache();
    await c.init();
    expect(c.link('page:a', hashContent('never embedded'), 1)).toBe(false);
  });

  test('model-id change invalidates the whole cache on init', async () => {
    const a = makeCache({ modelId: 'model-1' });
    await a.init();
    a.store('page:a', hashContent('x'), 1, [vec(1, 0, 0, 0)]);
    await a.persist();

    const b = makeCache({ modelId: 'model-2' });
    await b.init();
    expect(b.getVectors('page:a')).toBeUndefined();
    expect(b.embeddedCount).toBe(0);
  });

  test('provider change invalidates the cache (cross-provider vector guard)', async () => {
    const a = makeCache({ providerId: 'https://api.openai.com/v1' });
    await a.init();
    a.store('page:a', hashContent('x'), 1, [vec(1, 0, 0, 0)]);
    await a.persist();
    // Same model + dims + chunking, but a different provider produces different
    // vectors — the cache must not score one against the other.
    const b = makeCache({ providerId: 'https://my-azure.openai.azure.com/v1' });
    await b.init();
    expect(b.getVectors('page:a')).toBeUndefined();
    expect(b.embeddedCount).toBe(0);
  });

  test('chunk-config change invalidates the cache', async () => {
    const a = makeCache({ chunkConfigId: 'c8000-o400' });
    await a.init();
    a.store('page:a', hashContent('x'), 1, [vec(1, 0, 0, 0)]);
    await a.persist();
    const b = makeCache({ chunkConfigId: 'c800-o100' });
    await b.init();
    expect(b.getVectors('page:a')).toBeUndefined();
  });

  test('retain + persist GCs entries and orphaned blobs for removed docs', async () => {
    const c = makeCache();
    await c.init();
    const hashA = hashContent('a');
    const hashB = hashContent('b');
    c.store('page:a', hashA, 1, [vec(1, 0, 0, 0)]);
    c.store('page:b', hashB, 1, [vec(0, 1, 0, 0)]);
    await c.persist();
    expect(readdirSync(join(dir, 'vec')).length).toBe(2);

    // doc-b removed from the corpus.
    c.retain(new Set(['page:a']));
    await c.persist();
    expect(c.getVectors('page:b')).toBeUndefined();
    expect(readdirSync(join(dir, 'vec'))).toEqual([`${hashA}.bin`]);
  });

  test('embeddedCount counts docs with non-empty vectors', async () => {
    const c = makeCache();
    await c.init();
    c.store('page:a', hashContent('a'), 1, [vec(1, 0, 0, 0)]);
    c.store('page:blank', hashContent(''), 1, []); // blank doc, no chunks
    expect(c.embeddedCount).toBe(1);
  });

  test('memory-only mode (cacheDir null) works without touching disk', async () => {
    const c = new VectorCache({
      cacheDir: null,
      providerId: 'p',
      modelId: 'm',
      dims: DIMS,
      chunkConfigId: 'c',
    });
    await c.init();
    c.store('page:a', hashContent('a'), 1, [vec(1, 0, 0, 0)]);
    expect(c.getVectors('page:a')).toBeDefined();
    await c.persist(); // no-op, no throw
    expect(readdirSync(dir).length).toBe(0);
  });
});
