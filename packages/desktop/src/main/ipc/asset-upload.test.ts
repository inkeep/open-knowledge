import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { handleAssetUpload } from './asset-upload.ts';

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const stubServers: Server[] = [];

afterEach(async () => {
  while (stubServers.length > 0) {
    const server = stubServers.pop();
    if (server === undefined) continue;
    await new Promise<void>((done) => server.close(() => done()));
  }
});

async function startIntakeStub(
  overrides: { mintStatus?: number; putStatus?: number; mintBody?: unknown } = {},
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  let url = '';
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const method = req.method ?? '';
      const path = req.url ?? '';
      requests.push({ method, path, headers: { ...req.headers }, body: Buffer.concat(chunks) });
      const respond = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (method === 'POST' && path === '/api/feedback/attachment') {
        return respond(
          overrides.mintStatus ?? 200,
          overrides.mintBody ?? {
            uploadUrl: `${url}/upload/dest`,
            assetUrl: 'https://uploads.example.invalid/asset/dest',
            headers: { 'x-goog-content-length-range': '0,16777216' },
          },
        );
      }
      if (method === 'PUT' && path === '/upload/dest') {
        return respond(overrides.putStatus ?? 200, {});
      }
      respond(404, { error: 'unexpected request' });
    });
  });
  stubServers.push(server);
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        fail(new Error('stub server did not bind a port'));
        return;
      }
      url = `http://127.0.0.1:${address.port}`;
      done({ url, requests });
    });
  });
}

const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);

describe('handleAssetUpload', () => {
  test('mints against the feedback route and PUTs the bytes itself', async () => {
    const stub = await startIntakeStub();

    const result = await handleAssetUpload(
      { intakeBaseUrl: stub.url },
      {
        kind: 'upload-image',
        contentType: 'image/png',
        bytes: IMAGE,
        filename: 'feedback-1.png',
      },
    );

    expect(result).toEqual({ assetUrl: 'https://uploads.example.invalid/asset/dest' });
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/feedback/attachment',
      'PUT /upload/dest',
    ]);
    expect(JSON.parse(stub.requests[0]?.body.toString('utf8') ?? '')).toEqual({
      filename: 'feedback-1.png',
      sizeBytes: IMAGE.byteLength,
      contentType: 'image/png',
    });
    expect(stub.requests[1]?.headers['content-type']).toBe('image/png');
    expect(stub.requests[1]?.body.equals(Buffer.from(IMAGE))).toBe(true);
  });

  test('the mint body carries no report metadata', async () => {
    const stub = await startIntakeStub();
    await handleAssetUpload(
      { intakeBaseUrl: stub.url },
      { kind: 'upload-image', contentType: 'image/webp', bytes: IMAGE, filename: 'f.webp' },
    );
    const body = JSON.parse(stub.requests[0]?.body.toString('utf8') ?? '') as Record<
      string,
      unknown
    >;
    expect('metadata' in body).toBe(false);
  });

  test.each([
    ['a foreign content type', { contentType: 'image/gif' }],
    ['a path-bearing filename', { filename: '../escape.png' }],
    ['an empty filename', { filename: '' }],
    ['empty bytes', { bytes: new Uint8Array(0) }],
    ['bytes over the parity cap', { bytes: new Uint8Array(3 * 1024 * 1024 + 1) }],
  ])('refuses %s without any network call', async (_label, override) => {
    const stub = await startIntakeStub();

    const result = await handleAssetUpload(
      { intakeBaseUrl: stub.url },
      {
        kind: 'upload-image',
        contentType: 'image/png',
        bytes: IMAGE,
        filename: 'feedback-1.png',
        ...override,
      },
    );

    expect(result).toEqual({ error: 'invalid-request' });
    expect(stub.requests).toHaveLength(0);
  });

  test('refuses a non-transport-safe intake URL', async () => {
    const result = await handleAssetUpload(
      { intakeBaseUrl: 'http://intake.example.com' },
      { kind: 'upload-image', contentType: 'image/png', bytes: IMAGE, filename: 'a.png' },
    );
    expect(result).toEqual({ error: 'unconfigured' });
  });

  test('maps a refused mint and a refused PUT to an upload error', async () => {
    for (const overrides of [{ mintStatus: 500 }, { putStatus: 500 }]) {
      const stub = await startIntakeStub(overrides);
      const result = await handleAssetUpload(
        { intakeBaseUrl: stub.url },
        { kind: 'upload-image', contentType: 'image/png', bytes: IMAGE, filename: 'a.png' },
      );
      expect(result).toEqual({ error: 'upload' });
    }
  });

  test('refuses a mint that names a non-https upload URL', async () => {
    const stub = await startIntakeStub({
      mintBody: {
        uploadUrl: 'ftp://uploads.example.invalid/dest',
        assetUrl: 'https://uploads.example.invalid/asset/dest',
        headers: {},
      },
    });
    const result = await handleAssetUpload(
      { intakeBaseUrl: stub.url },
      { kind: 'upload-image', contentType: 'image/png', bytes: IMAGE, filename: 'a.png' },
    );
    expect(result).toEqual({ error: 'upload' });
  });
});
