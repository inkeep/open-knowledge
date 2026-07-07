import { afterEach, describe, expect, test } from 'bun:test';
import {
  cosineSimilarity,
  createOpenAiEmbedder,
  EMBEDDINGS_API_KEY_ENV,
  EmbeddingDimsMismatchError,
  loadOpenAiEmbedder,
  normalizeInPlace,
  normalizeProviderId,
} from './embedder.ts';

const KEY = 'sk-secret-test-key-do-not-log';

interface FetchCall {
  url: string;
  body: unknown;
  authHeader: string | undefined;
}

/** A stub fetch that records calls and replays a scripted sequence of replies. */
function stubFetch(replies: Array<{ status?: number; json?: unknown } | { abortable: true }>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = ((url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, body: JSON.parse(init.body as string), authHeader: headers?.Authorization });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if ('abortable' in reply) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    }
    const status = reply.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(reply.json),
      text: () => Promise.resolve(JSON.stringify(reply.json ?? { error: 'boom' })),
    } as Response);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Build a canned OpenAI embeddings response of `count` vectors of `dims`. */
function embeddingsResponse(count: number, dims: number, totalTokens = 7): unknown {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: dims }, (_, j) => (j === index % dims ? 1 : 0)),
    })),
    usage: { total_tokens: totalTokens },
  };
}

const noSleep = () => Promise.resolve();

afterEach(() => {
  delete process.env[EMBEDDINGS_API_KEY_ENV];
});

describe('createOpenAiEmbedder', () => {
  test('embeds, normalizes, and preserves input order', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: embeddingsResponse(2, 1536) }]);
    const embedder = createOpenAiEmbedder(
      { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', apiKey: KEY },
      { fetchImpl, sleep: noSleep },
    );
    const out = await embedder.embed(['alpha', 'beta'], { role: 'document' });
    expect(out.length).toBe(2);
    expect(out[0].length).toBe(1536);
    // L2-normalized → self-cosine ~1.
    expect(cosineSimilarity(out[0], out[0])).toBeCloseTo(1, 5);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/embeddings');
  });

  test('sends the key ONLY in the Authorization header, never in the body', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: embeddingsResponse(1, 1536) }]);
    const embedder = createOpenAiEmbedder(
      { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', apiKey: KEY },
      { fetchImpl, sleep: noSleep },
    );
    await embedder.embed(['hello'], { role: 'query' });
    expect(calls[0].authHeader).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(calls[0].body)).not.toContain(KEY);
  });

  test('splits large input into multiple provider requests (batching)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: embeddingsResponse(2, 8) },
      { json: embeddingsResponse(1, 8) },
    ]);
    const embedder = createOpenAiEmbedder(
      { baseUrl: 'https://x/v1', model: 'm', dimensions: 8, apiKey: KEY },
      { fetchImpl, sleep: noSleep, maxBatchSize: 2 },
    );
    const out = await embedder.embed(['a', 'b', 'c'], { role: 'document' });
    expect(out.length).toBe(3);
    expect(calls).toHaveLength(2);
    expect((calls[0].body as { input: string[] }).input).toEqual(['a', 'b']);
    expect((calls[1].body as { input: string[] }).input).toEqual(['c']);
  });

  test('sends the dimensions param only when configured', async () => {
    const withDims = stubFetch([{ json: embeddingsResponse(1, 512) }]);
    await createOpenAiEmbedder(
      { baseUrl: 'https://x/v1', model: 'm', dimensions: 512, apiKey: KEY },
      { fetchImpl: withDims.fetchImpl, sleep: noSleep },
    ).embed(['q'], { role: 'query' });
    expect((withDims.calls[0].body as { dimensions?: number }).dimensions).toBe(512);

    const noDims = stubFetch([{ json: embeddingsResponse(1, 1536) }]);
    await createOpenAiEmbedder(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: KEY },
      { fetchImpl: noDims.fetchImpl, sleep: noSleep },
    ).embed(['q'], { role: 'query' });
    expect('dimensions' in (noDims.calls[0].body as object)).toBe(false);
  });

  test('retries on 429 then succeeds (bounded backoff)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 429 },
      { status: 503 },
      { json: embeddingsResponse(1, 1536) },
    ]);
    const embedder = createOpenAiEmbedder(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: KEY },
      { fetchImpl, sleep: noSleep, maxRetries: 4 },
    );
    const out = await embedder.embed(['q'], { role: 'document' });
    expect(out.length).toBe(1);
    expect(calls).toHaveLength(3);
  });

  test('a non-retryable 401 throws immediately and leaks no key', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 401, json: { error: 'bad key' } }]);
    const embedder = createOpenAiEmbedder(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: KEY },
      { fetchImpl, sleep: noSleep, maxRetries: 4 },
    );
    let caught: Error | null = null;
    await embedder.embed(['q'], { role: 'document' }).catch((e) => {
      caught = e as Error;
    });
    expect(caught).not.toBeNull();
    expect((caught as unknown as Error).message).toContain('401');
    expect((caught as unknown as Error).message).not.toContain(KEY);
    expect(calls).toHaveLength(1); // no retry on 4xx
  });

  test('a provider error body echoing the key never leaks into the thrown error (R4)', async () => {
    // A misbehaving provider that reflects the request (key included) in its
    // error body. The embedder drains but never surfaces the body — only the
    // status — so the key cannot escape via an error message or a log.
    const { fetchImpl } = stubFetch([
      { status: 500, json: { error: `bad auth for Bearer ${KEY}` } },
    ]);
    const embedder = createOpenAiEmbedder(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: KEY },
      { fetchImpl, sleep: noSleep, maxRetries: 1 },
    );
    let caught: Error | null = null;
    await embedder.embed(['q'], { role: 'document' }).catch((e) => {
      caught = e as Error;
    });
    expect(caught).not.toBeNull();
    const err = caught as unknown as Error;
    expect(`${err.message}\n${err.stack ?? ''}`).not.toContain(KEY);
    expect(err.message).toContain('500');
  });

  test('times out a hung request and surfaces an error after retries', async () => {
    const { fetchImpl } = stubFetch([{ abortable: true }]);
    const embedder = createOpenAiEmbedder(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: KEY },
      { fetchImpl, sleep: noSleep, maxRetries: 1, queryTimeoutMs: 5, docTimeoutMs: 5 },
    );
    let caught: Error | null = null;
    await embedder.embed(['q'], { role: 'query' }).catch((e) => {
      caught = e as Error;
    });
    expect(caught).not.toBeNull();
  });

  test('throws EmbeddingDimsMismatchError when the provider returns the wrong size', async () => {
    const { fetchImpl } = stubFetch([{ json: embeddingsResponse(1, 768) }]);
    const embedder = createOpenAiEmbedder(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: KEY }, // declares default 1536
      { fetchImpl, sleep: noSleep },
    );
    let caught: unknown = null;
    await embedder.embed(['q'], { role: 'document' }).catch((e) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(EmbeddingDimsMismatchError);
  });

  test('empty input does not hit the network', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: embeddingsResponse(0, 1536) }]);
    const embedder = createOpenAiEmbedder(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: KEY },
      { fetchImpl },
    );
    expect(await embedder.embed([], { role: 'document' })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('normalizeProviderId', () => {
  test('normalizes host case + trailing slash, keeps path', () => {
    expect(normalizeProviderId('https://API.OpenAI.com/v1/')).toBe('https://api.openai.com/v1');
    expect(normalizeProviderId('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
  });
  test('distinguishes different providers', () => {
    expect(normalizeProviderId('https://api.openai.com/v1')).not.toBe(
      normalizeProviderId('https://my.azure.com/v1'),
    );
  });
});

describe('loadOpenAiEmbedder', () => {
  const config = { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' };

  test('returns null with no key store and no env var', async () => {
    const embedder = await loadOpenAiEmbedder({ keyStore: null, config });
    expect(embedder).toBeNull();
  });

  test('uses the key store when present', async () => {
    const keyStore = { get: () => Promise.resolve('sk-from-keyring') };
    const embedder = await loadOpenAiEmbedder({ keyStore, config });
    expect(embedder).not.toBeNull();
    expect(embedder?.modelId).toBe('text-embedding-3-small');
    expect(embedder?.dims).toBe(1536);
    expect(embedder?.providerId).toBe('https://api.openai.com/v1');
  });

  test('falls back to the env var when the store has no key', async () => {
    process.env[EMBEDDINGS_API_KEY_ENV] = 'sk-from-env';
    const keyStore = { get: () => Promise.resolve(null) };
    const embedder = await loadOpenAiEmbedder({ keyStore, config });
    expect(embedder).not.toBeNull();
  });

  test('a throwing key store degrades to the env fallback (never throws)', async () => {
    const keyStore = { get: () => Promise.reject(new Error('keyring exploded')) };
    expect(await loadOpenAiEmbedder({ keyStore, config })).toBeNull();
    process.env[EMBEDDINGS_API_KEY_ENV] = 'sk-env';
    expect(await loadOpenAiEmbedder({ keyStore, config })).not.toBeNull();
  });
});

describe('normalizeInPlace', () => {
  test('produces a unit vector; leaves a zero vector untouched', () => {
    const v = normalizeInPlace(Float32Array.from([3, 4]));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
    expect(Array.from(normalizeInPlace(Float32Array.from([0, 0])))).toEqual([0, 0]);
  });
});

describe('createOpenAiEmbedder — plaintext key guard', () => {
  const base = { model: 'text-embedding-3-small', apiKey: KEY };
  test('an https endpoint constructs', () => {
    expect(() =>
      createOpenAiEmbedder({ ...base, baseUrl: 'https://api.openai.com/v1' }),
    ).not.toThrow();
  });
  test('http:// is allowed only for loopback (local dev gateway / CI)', () => {
    expect(() =>
      createOpenAiEmbedder({ ...base, baseUrl: 'http://localhost:11434/v1' }),
    ).not.toThrow();
    expect(() =>
      createOpenAiEmbedder({ ...base, baseUrl: 'http://127.0.0.1:8080/v1' }),
    ).not.toThrow();
  });
  test('plaintext http:// to a non-loopback host throws — the key is never sent', () => {
    expect(() => createOpenAiEmbedder({ ...base, baseUrl: 'http://evil.example/v1' })).toThrow(
      /non-HTTPS/,
    );
  });
  test('a malformed baseUrl throws at construction', () => {
    expect(() => createOpenAiEmbedder({ ...base, baseUrl: 'not a url' })).toThrow(
      /not a valid URL/,
    );
  });
});
