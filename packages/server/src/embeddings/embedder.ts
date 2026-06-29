
import {
  type EmbeddingErrorReason,
  recordEmbeddingProviderError,
  recordEmbeddingRequestDuration,
  recordEmbeddingTokens,
} from './embeddings-telemetry.ts';

export const DEFAULT_EMBEDDINGS_DIMENSIONS = 1536;

export const EMBEDDINGS_API_KEY_ENV = 'OK_EMBEDDINGS_API_KEY';

export type EmbeddingRole = 'query' | 'document';

export interface Embedder {
  readonly providerId: string;
  readonly modelId: string;
  readonly dims: number;
  embed(texts: readonly string[], opts: { role: EmbeddingRole }): Promise<Float32Array[]>;
}

export interface EmbeddingsKeyStore {
  get(): Promise<string | null>;
}

export class EmbeddingDimsMismatchError extends Error {
  readonly name = 'EmbeddingDimsMismatchError';
  constructor(
    readonly expected: number,
    readonly got: number,
  ) {
    super(
      `embeddings provider returned ${got}-dim vectors, expected ${expected}. ` +
        `Set search.semantic.dimensions to ${got} (or point at the right model).`,
    );
  }
}

class MalformedEmbeddingResponseError extends Error {
  readonly name = 'MalformedEmbeddingResponseError';
  constructor(expected: number, got: number) {
    super(`embeddings response had ${got} vectors, expected ${expected}`);
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

export function normalizeInPlace(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

export interface OpenAiEmbedderConfig {
  baseUrl: string;
  model: string;
  dimensions?: number;
  apiKey: string;
}

export interface OpenAiEmbedderOptions {
  fetchImpl?: typeof fetch;
  maxBatchSize?: number;
  maxBatchChars?: number;
  docTimeoutMs?: number;
  queryTimeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  maxBatchSize: 96,
  maxBatchChars: 96_000,
  docTimeoutMs: 30_000,
  queryTimeoutMs: 8_000,
  maxRetries: 4,
  backoffBaseMs: 500,
} as const;

interface OpenAiEmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  usage?: { total_tokens?: number; prompt_tokens?: number };
}

export function normalizeProviderId(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return baseUrl.trim().replace(/\/+$/, '');
  }
}

function assertSafeEmbeddingsBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`embeddings baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol === 'https:') return;
  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (url.protocol === 'http:' && isLoopback) return;
  throw new Error(
    `refusing to send the embeddings API key to a non-HTTPS endpoint (${url.protocol}//${url.host}); ` +
      'use https:// (http:// is allowed only for localhost)',
  );
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOpenAiEmbedder(
  config: OpenAiEmbedderConfig,
  options: OpenAiEmbedderOptions = {},
): Embedder {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxBatchSize = options.maxBatchSize ?? DEFAULTS.maxBatchSize;
  const maxBatchChars = options.maxBatchChars ?? DEFAULTS.maxBatchChars;
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
  const docTimeoutMs = options.docTimeoutMs ?? DEFAULTS.docTimeoutMs;
  const queryTimeoutMs = options.queryTimeoutMs ?? DEFAULTS.queryTimeoutMs;

  assertSafeEmbeddingsBaseUrl(config.baseUrl);
  const dims = config.dimensions ?? DEFAULT_EMBEDDINGS_DIMENSIONS;
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;

  function batchInputs(texts: readonly string[]): string[][] {
    const batches: string[][] = [];
    let current: string[] = [];
    let chars = 0;
    for (const t of texts) {
      if (
        current.length > 0 &&
        (current.length >= maxBatchSize || chars + t.length > maxBatchChars)
      ) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(t);
      chars += t.length;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  type AttemptResult =
    | { kind: 'ok'; vectors: Float32Array[] }
    | { kind: 'retry'; reason: EmbeddingErrorReason; error: Error }
    | { kind: 'fatal'; reason: EmbeddingErrorReason; error: Error };

  async function attemptOnce(
    body: string,
    expectedCount: number,
    roleLabel: 'query' | 'document',
    timeoutMs: number,
  ): Promise<AttemptResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = performance.now();
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
      recordEmbeddingRequestDuration(roleLabel, performance.now() - startedAt);

      if (!res.ok) {
        await res.text().catch(() => '');
        const reason: EmbeddingErrorReason = res.status === 429 ? 'rate_limit' : 'http_error';
        const error = new Error(`embeddings request failed: HTTP ${res.status}`);
        return RETRYABLE_STATUS.has(res.status)
          ? { kind: 'retry', reason, error }
          : { kind: 'fatal', reason, error };
      }
      const json = (await res.json()) as OpenAiEmbeddingResponse;
      const vectors = parseEmbeddingResponse(json, expectedCount, dims);
      recordEmbeddingTokens(roleLabel, json.usage?.total_tokens ?? 0);
      return { kind: 'ok', vectors };
    } catch (err) {
      if (err instanceof EmbeddingDimsMismatchError) {
        return { kind: 'fatal', reason: 'dims_mismatch', error: err };
      }
      if (err instanceof MalformedEmbeddingResponseError) {
        return { kind: 'fatal', reason: 'malformed_response', error: err };
      }
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const error = err instanceof Error ? err : new Error(String(err));
      return { kind: 'retry', reason: isAbort ? 'timeout' : 'network', error };
    } finally {
      clearTimeout(timer);
    }
  }

  async function embedOneBatch(batch: string[], role: EmbeddingRole): Promise<Float32Array[]> {
    const timeoutMs = role === 'query' ? queryTimeoutMs : docTimeoutMs;
    const roleLabel = role === 'query' ? 'query' : 'document';
    const body = JSON.stringify({
      model: config.model,
      input: batch,
      encoding_format: 'float',
      ...(config.dimensions !== undefined ? { dimensions: config.dimensions } : {}),
    });

    let attempt = 0;
    for (;;) {
      const result = await attemptOnce(body, batch.length, roleLabel, timeoutMs);
      if (result.kind === 'ok') return result.vectors;
      recordEmbeddingProviderError(result.reason);
      if (result.kind === 'fatal' || attempt >= maxRetries) throw result.error;
      attempt += 1;
      const ceiling = backoffBaseMs * 2 ** (attempt - 1);
      await sleep(Math.round(ceiling / 2 + Math.random() * (ceiling / 2)));
    }
  }

  function parseEmbeddingResponse(
    json: OpenAiEmbeddingResponse,
    expectedCount: number,
    expectedDims: number,
  ): Float32Array[] {
    const data = json.data;
    if (!Array.isArray(data) || data.length !== expectedCount) {
      throw new MalformedEmbeddingResponseError(expectedCount, data?.length ?? 0);
    }
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const out: Float32Array[] = [];
    for (const item of ordered) {
      const emb = item.embedding;
      if (!Array.isArray(emb)) throw new MalformedEmbeddingResponseError(expectedCount, 0);
      if (emb.length !== expectedDims)
        throw new EmbeddingDimsMismatchError(expectedDims, emb.length);
      out.push(normalizeInPlace(Float32Array.from(emb)));
    }
    return out;
  }

  return {
    providerId: normalizeProviderId(config.baseUrl),
    modelId: config.model,
    dims,
    async embed(texts, { role }) {
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];
      for (const batch of batchInputs(texts)) {
        out.push(...(await embedOneBatch(batch, role)));
      }
      return out;
    },
  };
}

export interface LoadOpenAiEmbedderInput {
  keyStore: EmbeddingsKeyStore | null;
  config: Pick<OpenAiEmbedderConfig, 'baseUrl' | 'model' | 'dimensions'>;
  options?: OpenAiEmbedderOptions;
}

export async function loadOpenAiEmbedder(input: LoadOpenAiEmbedderInput): Promise<Embedder | null> {
  const stored = input.keyStore ? await input.keyStore.get().catch(() => null) : null;
  const apiKey = stored ?? process.env[EMBEDDINGS_API_KEY_ENV] ?? null;
  if (!apiKey) return null;
  return createOpenAiEmbedder({ ...input.config, apiKey }, input.options);
}
