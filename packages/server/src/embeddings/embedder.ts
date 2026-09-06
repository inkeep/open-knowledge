import {
  checkEmbeddingsBaseUrl,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE,
  sleep as defaultSleep,
  isLoopbackEmbeddingsUrl,
} from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';
import {
  type EmbeddingErrorReason,
  recordEmbeddingProviderError,
  recordEmbeddingRequestDuration,
  recordEmbeddingTokens,
} from './embeddings-telemetry.ts';

const log = getLogger('embeddings');

export const DEFAULT_EMBEDDINGS_DIMENSIONS = 1536;

export const EMBEDDINGS_API_KEY_ENV = 'OK_EMBEDDINGS_API_KEY';

export type EmbeddingRole = 'query' | 'document';

export interface Embedder {
  readonly providerId: string;
  readonly modelId: string;
  readonly dims: number | null;
  pinDims?(dims: number): void;
  embed(texts: readonly string[], opts: { role: EmbeddingRole }): Promise<Float32Array[]>;
}

export interface EmbeddingsKeyStore {
  resolveForProject(
    projectDir: string,
    baseUrl: string,
  ): Promise<{ key: string | null; source?: string | null }>;
}

export class EmbeddingProviderError extends Error {
  constructor(
    readonly reason: EmbeddingErrorReason,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EmbeddingProviderError';
  }
}

export class EmbeddingDimsMismatchError extends EmbeddingProviderError {
  readonly name = 'EmbeddingDimsMismatchError';
  constructor(
    readonly expected: number,
    readonly got: number,
  ) {
    super('dims_mismatch', `embeddings provider returned ${got}-dim vectors, expected ${expected}`);
  }
}

class MalformedEmbeddingResponseError extends EmbeddingProviderError {
  readonly name = 'MalformedEmbeddingResponseError';
  constructor(message: string) {
    super('malformed_response', message);
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
  apiKey?: string;
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
  maxBatchSize: DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE,
  maxBatchChars: DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS,
  docTimeoutMs: DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS,
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
  const problem = checkEmbeddingsBaseUrl(baseUrl);
  if (problem === null) return;
  if (problem === 'invalid-url') {
    throw new Error(`embeddings baseUrl is not a valid URL: ${baseUrl}`);
  }
  const url = new URL(baseUrl);
  throw new Error(
    `refusing to send the embeddings API key to a non-HTTPS endpoint (${url.protocol}//${url.host}); ` +
      'use https:// (http:// is allowed only for localhost)',
  );
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

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
  let pinnedDims = config.dimensions ?? null;
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
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body,
        signal: controller.signal,
      });
      recordEmbeddingRequestDuration(roleLabel, performance.now() - startedAt);

      if (!res.ok) {
        await res.text().catch(() => '');
        const reason: EmbeddingErrorReason = res.status === 429 ? 'rate_limit' : 'http_error';
        const error = new EmbeddingProviderError(
          reason,
          `embeddings request failed: HTTP ${res.status}`,
          res.status,
        );
        return RETRYABLE_STATUS.has(res.status)
          ? { kind: 'retry', reason, error }
          : { kind: 'fatal', reason, error };
      }
      let json: OpenAiEmbeddingResponse;
      try {
        json = (await res.json()) as OpenAiEmbeddingResponse;
      } catch {
        throw new MalformedEmbeddingResponseError(
          'embeddings endpoint returned a non-JSON body — check the base URL',
        );
      }
      const parsed = parseEmbeddingResponse(json, expectedCount);
      pinnedDims ??= parsed.dims;
      recordEmbeddingTokens(roleLabel, json.usage?.total_tokens ?? 0);
      return { kind: 'ok', vectors: parsed.vectors };
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
      if (result.kind === 'fatal' || attempt >= maxRetries) {
        throw result.error instanceof EmbeddingProviderError
          ? result.error
          : new EmbeddingProviderError(result.reason, result.error.message, undefined, {
              cause: result.error,
            });
      }
      attempt += 1;
      const ceiling = backoffBaseMs * 2 ** (attempt - 1);
      await sleep(Math.round(ceiling / 2 + Math.random() * (ceiling / 2)));
    }
  }

  function parseEmbeddingResponse(
    json: OpenAiEmbeddingResponse,
    expectedCount: number,
  ): { vectors: Float32Array[]; dims: number } {
    const data = json.data;
    if (!Array.isArray(data) || data.length !== expectedCount) {
      throw new MalformedEmbeddingResponseError(
        `embeddings response had ${data?.length ?? 0} vectors, expected ${expectedCount}`,
      );
    }
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const out: Float32Array[] = [];
    let requiredDims = pinnedDims;
    for (const item of ordered) {
      const emb = item.embedding;
      if (!Array.isArray(emb)) {
        throw new MalformedEmbeddingResponseError(
          'embeddings response contained a non-array embedding (expected float vectors)',
        );
      }
      requiredDims ??= emb.length;
      if (emb.length !== requiredDims) {
        throw new EmbeddingDimsMismatchError(requiredDims, emb.length);
      }
      out.push(normalizeInPlace(Float32Array.from(emb)));
    }
    if (requiredDims === null) {
      throw new MalformedEmbeddingResponseError('embeddings response contained no vectors');
    }
    return { vectors: out, dims: requiredDims };
  }

  return {
    providerId: normalizeProviderId(config.baseUrl),
    modelId: config.model,
    get dims() {
      return pinnedDims;
    },
    pinDims(next: number) {
      pinnedDims ??= next;
    },
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

function isDefaultOpenAiEndpoint(baseUrl: string): boolean {
  return normalizeProviderId(baseUrl) === normalizeProviderId(DEFAULT_EMBEDDINGS_BASE_URL);
}

export type EmbeddingsCredentialSource = 'project' | 'file' | 'env' | 'none';

export interface ResolvedEmbeddingsCredential {
  apiKey: string | null;
  keyless: boolean;
  source: EmbeddingsCredentialSource;
}

export async function resolveEmbeddingsCredential(
  keyStore: EmbeddingsKeyStore | null,
  projectDir: string,
  baseUrl: string,
): Promise<ResolvedEmbeddingsCredential> {
  const resolved = keyStore
    ? await keyStore.resolveForProject(projectDir, baseUrl).catch((err) => {
        log.warn({ err }, '[embeddings] failed to read the stored key — treating as unset');
        return null;
      })
    : null;
  if (resolved?.key) {
    const source = resolved.source === 'file' ? 'file' : 'project';
    return { apiKey: resolved.key, keyless: false, source };
  }
  if (isDefaultOpenAiEndpoint(baseUrl)) {
    const env = process.env[EMBEDDINGS_API_KEY_ENV];
    if (env) return { apiKey: env, keyless: false, source: 'env' };
  }
  if (isLoopbackEmbeddingsUrl(baseUrl)) return { apiKey: null, keyless: true, source: 'none' };
  return { apiKey: null, keyless: false, source: 'none' };
}

export interface LoadOpenAiEmbedderInput {
  keyStore: EmbeddingsKeyStore | null;
  projectDir: string;
  config: Pick<OpenAiEmbedderConfig, 'baseUrl' | 'model' | 'dimensions'>;
  options?: OpenAiEmbedderOptions;
}

export async function loadOpenAiEmbedder(input: LoadOpenAiEmbedderInput): Promise<Embedder | null> {
  const cred = await resolveEmbeddingsCredential(
    input.keyStore,
    input.projectDir,
    input.config.baseUrl,
  );
  if (cred.apiKey) {
    return createOpenAiEmbedder({ ...input.config, apiKey: cred.apiKey }, input.options);
  }
  if (cred.keyless) return createOpenAiEmbedder({ ...input.config }, input.options);
  return null;
}

const EMBEDDINGS_PROBE_INPUT = 'OpenKnowledge embeddings connection test';

const PROBE_TIMEOUT_MS = 10_000;

export interface EmbeddingProbeInput {
  baseUrl: string;
  model: string;
  dimensions?: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type EmbeddingProbeResult =
  | { ok: true; dimensions: number }
  | { ok: false; reason: EmbeddingErrorReason | 'invalid_endpoint'; status?: number };

export async function probeEmbeddingEndpoint(
  input: EmbeddingProbeInput,
): Promise<EmbeddingProbeResult> {
  let embedder: Embedder;
  try {
    embedder = createOpenAiEmbedder(
      {
        baseUrl: input.baseUrl,
        model: input.model,
        dimensions: input.dimensions,
        apiKey: input.apiKey,
      },
      {
        fetchImpl: input.fetchImpl,
        maxRetries: 0,
        queryTimeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS,
      },
    );
  } catch {
    return { ok: false, reason: 'invalid_endpoint' };
  }
  try {
    const [vector] = await embedder.embed([EMBEDDINGS_PROBE_INPUT], { role: 'query' });
    if (!vector || vector.length === 0) return { ok: false, reason: 'malformed_response' };
    return { ok: true, dimensions: vector.length };
  } catch (err) {
    if (err instanceof EmbeddingProviderError) {
      return { ok: false, reason: err.reason, status: err.status };
    }
    return { ok: false, reason: 'network' };
  }
}
