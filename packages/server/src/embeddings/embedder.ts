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
  checkEmbeddingsBaseUrl,
  DEFAULT_EMBEDDINGS_BASE_URL,
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
  /**
   * Vector length: the configured size, the size detected from the first
   * response, or `null` while auto-detecting and nothing has come back yet.
   * Hardcoding a default here is what made every non-1536 model fail its first
   * response, so an unset config means "whatever the provider returns".
   */
  readonly dims: number | null;
  /**
   * Adopt a length pinned by a previous run (from the vector cache's manifest)
   * so the first response of this run is checked against it rather than
   * silently re-pinning over a corpus of the old size. No-op once a length is
   * fixed. Absent on embedders whose size is inherent.
   */
  pinDims?(dims: number): void;
  /**
   * Embed a batch of texts. `role` distinguishes query vs document spend for
   * telemetry (the provider treats both identically — `text-embedding-3` is
   * symmetric). Returns one L2-normalized `Float32Array` of length
   * {@link Embedder.dims} per input, in input order.
   */
  embed(texts: readonly string[], opts: { role: EmbeddingRole }): Promise<Float32Array[]>;
}

/**
 * Read-only accessor for the embeddings API key. Implemented by the 0600
 * `~/.ok/secrets.yml` backend and injected into the server the same way as
 * `ProbeTokenStore`, so the server stays agnostic to where the key is stored.
 * Resolution is project + endpoint scoped: the key is bound to the exact
 * endpoint it was entered against, so it can never travel to a different host.
 */
export interface EmbeddingsKeyStore {
  /** Key bound to (projectDir, baseUrl), or `{ key: null }`. Never throws. */
  resolveForProject(
    projectDir: string,
    baseUrl: string,
  ): Promise<{ key: string | null; source?: string | null }>;
}

/**
 * A provider call that failed, carrying the classification `attemptOnce`
 * already computed. Without it the reason reaches the telemetry counter and
 * then evaporates, leaving callers (the Test-connection probe) to re-derive it
 * from a message string. Every error `embed()` throws is one of these.
 */
export class EmbeddingProviderError extends Error {
  constructor(
    readonly reason: EmbeddingErrorReason,
    message: string,
    /** Provider HTTP status when the failure was a response, else undefined. */
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EmbeddingProviderError';
  }
}

/**
 * Thrown when the provider returns vectors of a length other than the one in
 * force. Two distinct causes, and the caller must tell them apart:
 *  - `dimensions` is configured and the server ignores the request param
 *    (Ollama does) — a misconfiguration, re-embedding cannot fix it.
 *  - the size was auto-detected and has since changed (a model swapped behind
 *    an alias) — the cached corpus is stale and must be rebuilt.
 * Surfaced either way, never swallowed: mixing lengths corrupts scoring
 * silently, because cosine similarity truncates to the shorter vector.
 */
export class EmbeddingDimsMismatchError extends EmbeddingProviderError {
  readonly name = 'EmbeddingDimsMismatchError';
  constructor(
    readonly expected: number,
    readonly got: number,
  ) {
    super('dims_mismatch', `embeddings provider returned ${got}-dim vectors, expected ${expected}`);
  }
}

/** A provider response whose shape/length doesn't match the request. */
class MalformedEmbeddingResponseError extends EmbeddingProviderError {
  readonly name = 'MalformedEmbeddingResponseError';
  constructor(message: string) {
    super('malformed_response', message);
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
   * request param AND enforced on every response (a provider that ignores the
   * param fails loudly). When omitted the param is not sent and whatever length
   * the provider returns is accepted — the only way a non-1536 model works
   * without the user knowing its size up front.
   */
  dimensions?: number;
  /**
   * The provider API key (Bearer). Never logged. Optional: a loopback
   * self-hosted server (Ollama / LM Studio) needs no key, and omitting it sends
   * NO `Authorization` header at all rather than a bogus one. The caller decides
   * whether keyless is allowed for the target host (`loadOpenAiEmbedder` only
   * permits it for loopback); the client itself is agnostic.
   */
  apiKey?: string;
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
  // Rules are shared with the app + CLI via `checkEmbeddingsBaseUrl` so
  // client-side validation can never diverge from this server-side guard.
  const problem = checkEmbeddingsBaseUrl(baseUrl);
  if (problem === null) return;
  if (problem === 'invalid-url') {
    throw new Error(`embeddings baseUrl is not a valid URL: ${baseUrl}`);
  }
  // insecure-scheme — re-parse for the host detail (already proven parseable).
  const url = new URL(baseUrl);
  throw new Error(
    `refusing to send the embeddings API key to a non-HTTPS endpoint (${url.protocol}//${url.host}); ` +
      'use https:// (http:// is allowed only for localhost)',
  );
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

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
  // The length every response is held to. Starts `null` when `dimensions` is
  // unset — the provider decides, and the first clean response pins it for the
  // life of this embedder. Defaulting it to 1536 is what made every model that
  // isn't OpenAI-sized fail on its very first response.
  let pinnedDims = config.dimensions ?? null;
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
          // No key → no header (keyless loopback), never `Bearer undefined`.
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
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
        const error = new EmbeddingProviderError(
          reason,
          `embeddings request failed: HTTP ${res.status}`,
          res.status,
        );
        return RETRYABLE_STATUS.has(res.status)
          ? { kind: 'retry', reason, error }
          : { kind: 'fatal', reason, error };
      }
      // A 200 carrying something other than JSON is a configuration problem —
      // a base URL that landed on a proxy's HTML page or a site root rather
      // than an embeddings API. Left to the generic catch below it would read
      // as a transient network fault: retried four times, then reported as
      // "couldn't reach the endpoint" for a host that answered immediately.
      let json: OpenAiEmbeddingResponse;
      try {
        json = (await res.json()) as OpenAiEmbeddingResponse;
      } catch {
        throw new MalformedEmbeddingResponseError(
          'embeddings endpoint returned a non-JSON body — check the base URL',
        );
      }
      const parsed = parseEmbeddingResponse(json, expectedCount);
      // Commit the detection only once the WHOLE response parsed cleanly — a
      // response that turned out ragged must not leave its first vector's
      // length pinned behind it.
      pinnedDims ??= parsed.dims;
      recordEmbeddingTokens(roleLabel, json.usage?.total_tokens ?? 0);
      return { kind: 'ok', vectors: parsed.vectors };
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
      if (result.kind === 'fatal' || attempt >= maxRetries) {
        throw result.error instanceof EmbeddingProviderError
          ? result.error
          : new EmbeddingProviderError(result.reason, result.error.message, undefined, {
              cause: result.error,
            });
      }
      attempt += 1;
      // Full-jitter exponential backoff.
      const ceiling = backoffBaseMs * 2 ** (attempt - 1);
      await sleep(Math.round(ceiling / 2 + Math.random() * (ceiling / 2)));
    }
  }

  /** Parse + validate one response, reporting the length it settled on. */
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
    // Provider guarantees no order, but returns an `index` — sort defensively.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const out: Float32Array[] = [];
    // With nothing pinned yet the first vector sets the bar for the rest: a
    // length that varies within one response is incoherent under any config.
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
      // Each batch is validated against the pin the previous one established,
      // so a gateway that fails over mid-call can't hand back a mix of sizes
      // that the caller would happily write into one cache entry.
      for (const batch of batchInputs(texts)) {
        out.push(...(await embedOneBatch(batch, role)));
      }
      return out;
    },
  };
}

/** True when `baseUrl` is the built-in OpenAI endpoint (identity comparison). */
function isDefaultOpenAiEndpoint(baseUrl: string): boolean {
  return normalizeProviderId(baseUrl) === normalizeProviderId(DEFAULT_EMBEDDINGS_BASE_URL);
}

/** Where a resolved embeddings credential came from, or that none is needed/found. */
export type EmbeddingsCredentialSource = 'project' | 'file' | 'env' | 'none';

export interface ResolvedEmbeddingsCredential {
  /** The key to send, or `null`. */
  apiKey: string | null;
  /** No key, but the endpoint is loopback so it may be probed/embedded keyless. */
  keyless: boolean;
  source: EmbeddingsCredentialSource;
}

/**
 * THE single resolution seam — every path (warm-time embedder load, the Test
 * button, status) resolves a credential here so they can never disagree about
 * which key reaches which endpoint. Order:
 *   1. the project's stored key for this exact endpoint (structurally bound).
 *   2. `OK_EMBEDDINGS_API_KEY` — DEFAULT OpenAI endpoint ONLY. A machine-wide
 *      env key must never travel to a custom host; the store scopes the flat
 *      file key the same way.
 *   3. no key + loopback endpoint → keyless (Ollama / LM Studio need no key).
 *   4. otherwise no credential (→ semantic search stays unready).
 * Makes no network call — resolution is "is there a key", not "does it work".
 */
export async function resolveEmbeddingsCredential(
  keyStore: EmbeddingsKeyStore | null,
  projectDir: string,
  baseUrl: string,
): Promise<ResolvedEmbeddingsCredential> {
  const resolved = keyStore
    ? await keyStore.resolveForProject(projectDir, baseUrl).catch((err) => {
        // A read failure (unreadable/corrupt secrets file, EPERM) must not throw
        // on the warm path, but silently mapping it to "no key" would report
        // keyPresent:false for a key that IS stored — the user re-runs set-key
        // chasing a ghost. Log it so the degradation leaves a trail.
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
  /** Injected key store (the 0600 secrets file). `null` = no store; env/keyless only. */
  keyStore: EmbeddingsKeyStore | null;
  /** The running server's project directory — scopes key resolution. */
  projectDir: string;
  /** Non-secret provider config, read fresh so a config change re-warms cleanly. */
  config: Pick<OpenAiEmbedderConfig, 'baseUrl' | 'model' | 'dimensions'>;
  /** Embedder construction options (timeouts/batching/fetch — tests inject). */
  options?: OpenAiEmbedderOptions;
}

/**
 * Resolve the credential for this project + endpoint and build the embedder, or
 * `null` when there's no key and the endpoint isn't loopback (→ lexical). Makes
 * no network call, so warming is free.
 */
export async function loadOpenAiEmbedder(input: LoadOpenAiEmbedderInput): Promise<Embedder | null> {
  const cred = await resolveEmbeddingsCredential(
    input.keyStore,
    input.projectDir,
    input.config.baseUrl,
  );
  if (cred.apiKey) {
    return createOpenAiEmbedder({ ...input.config, apiKey: cred.apiKey }, input.options);
  }
  // Keyless loopback: construct with no key → no Authorization header.
  if (cred.keyless) return createOpenAiEmbedder({ ...input.config }, input.options);
  return null;
}

/**
 * The one string the connection probe embeds. Fixed and content-free — a probe
 * must never ship a page or a query to an endpoint the user is still testing.
 */
const EMBEDDINGS_PROBE_INPUT = 'OpenKnowledge embeddings connection test';

/** Probe budget. Short: this runs behind a button the user is waiting on. */
const PROBE_TIMEOUT_MS = 10_000;

export interface EmbeddingProbeInput {
  baseUrl: string;
  model: string;
  /** Explicit dimensions, if configured — probing with it exercises the same
   *  strict length check the real embed path would apply. */
  dimensions?: number;
  /** Omit for a keyless loopback endpoint — probes with no Authorization header. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type EmbeddingProbeResult =
  | { ok: true; dimensions: number }
  | { ok: false; reason: EmbeddingErrorReason | 'invalid_endpoint'; status?: number };

/**
 * One live embed against the configured endpoint, classified. The on-demand
 * answer to "is this thing actually working" — without it a wrong URL / key /
 * model is indistinguishable from a working setup that simply hasn't indexed
 * yet, because every failure degrades quietly to keyword search.
 *
 * No retries and a short timeout: a user waiting on a button wants the verdict,
 * not four backoffs. The detected vector length on success doubles as the
 * readout that replaces a hand-entered dimensions field.
 */
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
    // Construction only fails the base-URL guard (unparseable, or plaintext to
    // a non-loopback host) — nothing left the machine.
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
