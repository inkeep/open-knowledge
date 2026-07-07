/**
 * The embedding capability the semantic-search subsystem depends on, plus the
 * production implementation: a thin HTTP client for an OpenAI-compatible
 * `/embeddings` endpoint (no SDK, no native addon).
 *
 * Two implementations satisfy `Embedder`:
 *  - `createOpenAiEmbedder()` — POSTs batched inputs to a remote provider
 *    (default `text-embedding-3-small`). Capability-gated on a present API key.
 *  - `createConceptEmbedder()` (concept-embedder.ts) — deterministic, offline,
 *    network-free; the injection seam for hermetic tests.
 *
 * The embedder is loaded LAZILY and only when the feature is enabled AND keyed:
 * `loadOpenAiEmbedder()` resolves the key (the injected store — the CLI's 0600
 * `~/.ok/secrets.yml` file — then the `OK_EMBEDDINGS_API_KEY` env fallback) and
 * constructs the client WITHOUT a probe API call, so warming the service costs
 * zero egress. A null return means "no key → degrade to lexical search".
 */

import {
  type EmbeddingErrorReason,
  recordEmbeddingProviderError,
  recordEmbeddingRequestDuration,
  recordEmbeddingTokens,
} from './embeddings-telemetry.ts';

/**
 * Default output dimensionality for `text-embedding-3-small`. Used when the
 * config leaves `dimensions` unset; also the concept embedder's default size.
 */
export const DEFAULT_EMBEDDINGS_DIMENSIONS = 1536;

/** Environment fallback for the provider key (the stored secrets file is primary). */
/** OK-namespaced deliberately so an ambient `OPENAI_API_KEY` can never cause egress. */
export const EMBEDDINGS_API_KEY_ENV = 'OK_EMBEDDINGS_API_KEY';

export type EmbeddingRole = 'query' | 'document';

/**
 * The minimal embedding capability the semantic-search service needs. Vectors
 * are L2-normalized and length {@link Embedder.dims}, so cosine similarity is a
 * plain dot product.
 */
export interface Embedder {
  /**
   * Provider identity — pinned into the vector-cache key so vectors from one
   * provider never score against another's query (e.g. OpenAI vs an Azure
   * deployment of the "same" model produce different vectors).
   */
  readonly providerId: string;
  /** Model identity — also part of the cache key (cross-model guard). */
  readonly modelId: string;
  /** Output dimensionality — also part of the cache key. */
  readonly dims: number;
  /**
   * Embed a batch of texts. `role` distinguishes query vs document spend for
   * telemetry (the provider treats both identically — `text-embedding-3` is
   * symmetric). Returns one L2-normalized `Float32Array` of length
   * {@link Embedder.dims} per input, in input order.
   */
  embed(texts: readonly string[], opts: { role: EmbeddingRole }): Promise<Float32Array[]>;
}

/**
 * Read-only accessor for the embeddings API key. Implemented in the CLI /
 * desktop wiring layer (reads the 0600 `~/.ok/secrets.yml` file) and injected
 * into the server the same way as `ProbeTokenStore`, so the server stays
 * agnostic to where the key is stored.
 */
export interface EmbeddingsKeyStore {
  /** Resolve the stored key, or `null` when none is set. Never throws. */
  get(): Promise<string | null>;
}

/**
 * Thrown when the provider returns vectors of an unexpected length — almost
 * always a misconfiguration (model whose native size ≠ the configured
 * `dimensions`). Surfaced (not swallowed) so the service can log it once and
 * degrade to lexical instead of corrupting the cache with ragged vectors.
 */
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

/** A provider response whose shape/length doesn't match the request. */
class MalformedEmbeddingResponseError extends Error {
  readonly name = 'MalformedEmbeddingResponseError';
  constructor(expected: number, got: number) {
    super(`embeddings response had ${got} vectors, expected ${expected}`);
  }
}

/**
 * Cosine similarity of two L2-normalized vectors — a dot product. Callers must
 * pass normalized, equal-length vectors (every `Embedder` guarantees this).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/** In-place L2 normalization. Zero vectors are left untouched (norm 0). */
export function normalizeInPlace(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/** Non-secret provider configuration (the secret key is resolved separately). */
export interface OpenAiEmbedderConfig {
  /** OpenAI-compatible API base URL, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Embeddings model id, e.g. `text-embedding-3-small`. */
  model: string;
  /**
   * Requested output dimensions. When set it is sent as the `dimensions`
   * request param AND used as the cache dims; when omitted the provider's
   * native size is used (defaulting the declared dims to
   * {@link DEFAULT_EMBEDDINGS_DIMENSIONS}) and the param is not sent.
   */
  dimensions?: number;
  /** The provider API key (Bearer). Never logged. */
  apiKey: string;
}

export interface OpenAiEmbedderOptions {
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Max inputs per API request (provider cap is large; this bounds memory). */
  maxBatchSize?: number;
  /** Char budget per API request — a token proxy that keeps batches under the */
  /** provider's per-request token limit without a tokenizer dependency. */
  maxBatchChars?: number;
  /** Per-request timeout for document (corpus) embeds. */
  docTimeoutMs?: number;
  /** Per-request timeout for query embeds — tighter, so search degrades fast. */
  queryTimeoutMs?: number;
  /** Max retries on a retryable failure (429 / 5xx / network / timeout). */
  maxRetries?: number;
  /** Base backoff delay; grows exponentially per attempt. */
  backoffBaseMs?: number;
  /** Sleep impl (injected for tests so backoff is instant). */
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

/** Normalize a base URL into a stable provider identity for the cache key. */
export function normalizeProviderId(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    // origin + path, trailing slash trimmed, lowercased host — distinguishes
    // openai vs azure vs a localhost gateway without leaking credentials.
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return baseUrl.trim().replace(/\/+$/, '');
  }
}

/**
 * Refuse to construct an embedder that would send the Bearer API key over
 * plaintext. `baseUrl` is user-set project-local config, so a stray `http://`
 * provider URL would leak the key on the wire. Require `https://`, allowing
 * `http://` only for loopback (a local dev gateway / CI proxy, where the key
 * never leaves the machine). Throws at construction → the service's warm()
 * catches it and degrades to lexical, so a misconfig never causes egress.
 */
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

/**
 * Build the OpenAI-compatible embedder. Pure construction — makes NO network
 * call, so it is safe to build at warm time (zero egress until an actual
 * embed). The first `embed()` is the first egress.
 */
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

  /** Split inputs into provider-request-sized batches (count + char budget). */
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

  /** One network attempt, classified into ok / retryable / fatal. Never throws. */
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
        // Drain the body so the socket frees, but NEVER surface it verbatim —
        // a provider error body can echo request fields. Keep only the status.
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
      // Parse-time config errors are fatal (no point retrying); network / abort
      // (timeout) are retryable.
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
      // Every non-ok attempt feeds the provider-error rate metric.
      recordEmbeddingProviderError(result.reason);
      if (result.kind === 'fatal' || attempt >= maxRetries) throw result.error;
      attempt += 1;
      // Full-jitter exponential backoff.
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
    // Provider guarantees no order, but returns an `index` — sort defensively.
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
  /** Injected key store (the CLI's secrets file). `null` = no store; env fallback only. */
  keyStore: EmbeddingsKeyStore | null;
  /** Non-secret provider config, read fresh so a config change re-warms cleanly. */
  config: Pick<OpenAiEmbedderConfig, 'baseUrl' | 'model' | 'dimensions'>;
  /** Embedder construction options (timeouts/batching/fetch — tests inject). */
  options?: OpenAiEmbedderOptions;
}

/**
 * Resolve the key (stored secrets file → `OK_EMBEDDINGS_API_KEY` env fallback)
 * and build the embedder, or `null` when no key is available (→ lexical). Makes no
 * network call — capability detection is "is there a key", not "does the API
 * answer", so warming is free.
 */
export async function loadOpenAiEmbedder(input: LoadOpenAiEmbedderInput): Promise<Embedder | null> {
  const stored = input.keyStore ? await input.keyStore.get().catch(() => null) : null;
  const apiKey = stored ?? process.env[EMBEDDINGS_API_KEY_ENV] ?? null;
  if (!apiKey) return null;
  return createOpenAiEmbedder({ ...input.config, apiKey }, input.options);
}
