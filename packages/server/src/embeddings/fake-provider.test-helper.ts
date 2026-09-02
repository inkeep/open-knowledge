import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeEmbeddingsProviderOptions {
  dims: number;
  driftDims?: number;
  driftAfterRequests?: number;
  ignoreDimensionsParam?: boolean;
  failWithStatus?: number;
  encodeAsBase64?: boolean;
}

interface FakeEmbeddingsRequest {
  model: string;
  input: string[];
  dimensions?: number;
  encodingFormat?: string;
  authorization?: string;
}

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
  baseUrl: string;
  requests: FakeEmbeddingsRequest[];
  close(): Promise<void>;
}

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
