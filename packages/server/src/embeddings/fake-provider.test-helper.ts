/**
 * A stand-in for a real OpenAI-compatible embeddings server, with the quirks
 * that actually break us.
 *
 * The concept embedder is a fake `Embedder` — it bypasses the HTTP client
 * entirely, so it can never exercise the response handling where custom
 * endpoints go wrong. This fakes the wire instead: the production
 * `createOpenAiEmbedder` runs unmodified against it, so batching, retries,
 * parsing, and dimension detection are the real code paths.
 *
 * Modelled on observed behaviour of self-hosted servers:
 *  - a native vector size that is not 1536 (most non-OpenAI models),
 *  - accepting and then ignoring the `dimensions` request param (Ollama),
 *  - changing size partway through a run (a model swapped behind an alias).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeEmbeddingsProviderOptions {
  /** Native vector length the model returns. */
  dims: number;
  /** Length returned from `driftAfterRequests` onward — an alias swap. */
  driftDims?: number;
  /** Successful requests served at `dims` before `driftDims` takes over. */
  driftAfterRequests?: number;
  /** Accept the `dimensions` param and return the native size anyway. */
  ignoreDimensionsParam?: boolean;
  /** Fail every request with this status instead of embedding. */
  failWithStatus?: number;
  /** Reply with base64 strings instead of float arrays. */
  encodeAsBase64?: boolean;
}

interface FakeEmbeddingsRequest {
  model: string;
  input: string[];
  dimensions?: number;
  encodingFormat?: string;
  authorization?: string;
}

/** A deterministic unit-ish vector so callers can assert on real numbers. */
function fakeVector(text: string, dims: number): number[] {
  const out = new Array<number>(dims);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  for (let i = 0; i < dims; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    out[i] = (h % 1000) / 1000 - 0.5;
  }
  return out;
}

interface FakeResponse {
  status: number;
  body: unknown;
}

/** The provider's decision for one request, shared by both drivers below. */
function makeProvider(options: FakeEmbeddingsProviderOptions) {
  const requests: FakeEmbeddingsRequest[] = [];
  let served = 0;

  function respond(request: FakeEmbeddingsRequest): FakeResponse {
    requests.push(request);
    if (options.failWithStatus !== undefined) {
      return { status: options.failWithStatus, body: { error: { message: 'nope' } } };
    }
    const drifted =
      options.driftDims !== undefined && served >= (options.driftAfterRequests ?? 1)
        ? options.driftDims
        : null;
    served += 1;
    // The `ignoreDimensionsParam` server takes the param and returns its native
    // size regardless — the failure mode an explicit `dimensions` has to catch.
    const dims =
      drifted ??
      (options.ignoreDimensionsParam ? options.dims : (request.dimensions ?? options.dims));
    return {
      status: 200,
      body: {
        data: request.input.map((text, index) => {
          const vector = fakeVector(text, dims);
          return {
            index,
            embedding: options.encodeAsBase64
              ? Buffer.from(new Float32Array(vector).buffer).toString('base64')
              : vector,
          };
        }),
        usage: { total_tokens: request.input.length * 3 },
      },
    };
  }

  return { requests, respond };
}

function parseRequest(body: string, authorization: string | undefined): FakeEmbeddingsRequest {
  const parsed = JSON.parse(body) as {
    model: string;
    input: string[];
    dimensions?: number;
    encoding_format?: string;
  };
  return {
    model: parsed.model,
    input: parsed.input,
    dimensions: parsed.dimensions,
    encodingFormat: parsed.encoding_format,
    authorization,
  };
}

export interface FakeEmbeddingsFetch {
  fetchImpl: typeof fetch;
  requests: FakeEmbeddingsRequest[];
}

/** In-process driver: pass `fetchImpl` straight to `createOpenAiEmbedder`. */
export function createFakeEmbeddingsFetch(
  options: FakeEmbeddingsProviderOptions,
): FakeEmbeddingsFetch {
  const { requests, respond } = makeProvider(options);
  const fetchImpl = ((_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string> | undefined;
    const reply = respond(parseRequest(init.body as string, headers?.Authorization));
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(reply.body),
      text: () => Promise.resolve(JSON.stringify(reply.body)),
    } as Response);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

export interface FakeEmbeddingsServer {
  /** Loopback base URL to configure as `search.semantic.baseUrl`. */
  baseUrl: string;
  requests: FakeEmbeddingsRequest[];
  close(): Promise<void>;
}

/**
 * Real-socket driver, for the paths that go through the HTTP API rather than an
 * injected `fetchImpl` (the Test-connection route). Loopback, so the
 * plaintext-key guard permits `http://`.
 */
export async function startFakeEmbeddingsServer(
  options: FakeEmbeddingsProviderOptions,
): Promise<FakeEmbeddingsServer> {
  const { requests, respond } = makeProvider(options);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const reply = respond(
        parseRequest(Buffer.concat(chunks).toString('utf-8'), req.headers.authorization),
      );
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
