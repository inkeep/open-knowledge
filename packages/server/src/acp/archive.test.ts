import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { downloadToFileWithSha } from './archive.ts';

const URL_UNDER_TEST = 'https://example.com/agent.zip';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function destination(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-archive-download-'));
  dirs.push(dir);
  return join(dir, 'archive.zip');
}

function payloadOf(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

type StreamEnd = 'close' | 'error' | 'hang';

function streamOf(
  bytes: Uint8Array,
  chunkSize: number,
  end: StreamEnd,
  failure: Error = new Error('socket hang up'),
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
        return;
      }
      if (end === 'close') controller.close();
      else if (end === 'error') controller.error(failure);
      else return new Promise<void>(() => {});
    },
  });
}

interface RecordedRequest {
  range: string | null;
  ifRange: string | null;
}

function scriptedFetch(responses: Array<(request: RecordedRequest) => Response>): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const request = { range: headers.get('range'), ifRange: headers.get('if-range') };
    requests.push(request);
    const respond = responses[Math.min(requests.length, responses.length) - 1];
    if (respond === undefined) throw new Error('no scripted response');
    return respond(request);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function stillRunningAfter(ms: number): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve('still running'), ms).unref());
}

describe('downloadToFileWithSha', () => {
  test('resumes from the received offset when the connection drops mid-transfer', async () => {
    const payload = payloadOf(4_096);
    const half = 2_048;
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, half), 512, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
      () =>
        new Response(streamOf(payload.slice(half), 512, 'close'), {
          status: 206,
          headers: {
            'content-length': String(payload.length - half),
            'content-range': `bytes ${half}-${payload.length - 1}/${payload.length}`,
          },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, {
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(sha).toBe(sha256(payload));
    expect(new Uint8Array(readFileSync(dest))).toEqual(payload);
    expect(requests).toEqual([
      { range: null, ifRange: null },
      { range: `bytes=${half}-`, ifRange: '"v1"' },
    ]);
  });

  test('restarts from the beginning when the server ignores the range request', async () => {
    const payload = payloadOf(3_000);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
      () =>
        new Response(streamOf(payload, 500, 'close'), {
          status: 200,
          headers: { 'content-length': String(payload.length) },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, {
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(sha).toBe(sha256(payload));
    expect(new Uint8Array(readFileSync(dest))).toEqual(payload);
    expect(requests.map((r) => r.range)).toEqual([null, 'bytes=1000-']);
  });

  test('retries a body that ends before its declared length', async () => {
    const payload = payloadOf(2_000);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_500), 500, 'close'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
      () =>
        new Response(streamOf(payload.slice(1_500), 500, 'close'), {
          status: 206,
          headers: { 'content-range': `bytes 1500-1999/${payload.length}` },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, {
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(sha).toBe(sha256(payload));
    expect(requests.map((r) => r.range)).toEqual([null, 'bytes=1500-']);
  });

  test('fails a transfer that stops sending data instead of waiting on it', async () => {
    const payload = payloadOf(1_024);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 512), 512, 'hang'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
      () =>
        new Response(streamOf(new Uint8Array(0), 512, 'hang'), {
          status: 206,
          headers: { 'content-range': `bytes 512-1023/${payload.length}` },
        }),
    ]);

    const download = downloadToFileWithSha(URL_UNDER_TEST, dest, {
      fetchImpl,
      stallTimeoutMs: 50,
      maxAttemptsWithoutProgress: 2,
      retryDelayMs: 0,
    });
    const outcome = await Promise.race([
      download.then(
        () => 'resolved',
        (err: Error) => err.message,
      ),
      stillRunningAfter(5_000),
    ]);

    expect(outcome).toMatch(/no data for 0\.05s/);
    expect(outcome).toMatch(/received 512 B of 1\.0 KB after 3 attempts/);
    expect(requests.map((r) => r.range)).toEqual([null, 'bytes=512-', 'bytes=512-']);
  });

  test('a transfer that keeps delivering data is never cut off by elapsed time', async () => {
    const payload = payloadOf(2_000);
    const dest = destination();
    let offset = 0;
    const slowBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= payload.length) {
          controller.close();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(payload.slice(offset, offset + 100));
        offset += 100;
      },
    });
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(slowBody, {
          status: 200,
          headers: { 'content-length': String(payload.length) },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, {
      fetchImpl,
      stallTimeoutMs: 200,
      retryDelayMs: 0,
    });

    expect(sha).toBe(sha256(payload));
    expect(requests).toHaveLength(1);
  });

  test('does not retry a request the server rejected', async () => {
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () => new Response('not found', { status: 404 }),
    ]);

    await expect(
      downloadToFileWithSha(URL_UNDER_TEST, dest, { fetchImpl, retryDelayMs: 0 }),
    ).rejects.toThrow(/HTTP 404/);
    expect(requests).toHaveLength(1);
  });

  test('retries a server error response', async () => {
    const payload = payloadOf(1_000);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () => new Response('unavailable', { status: 503 }),
      () =>
        new Response(streamOf(payload, 250, 'close'), {
          status: 200,
          headers: { 'content-length': String(payload.length) },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, {
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(sha).toBe(sha256(payload));
    expect(requests).toHaveLength(2);
  });

  test('stops without retrying once the caller aborts', async () => {
    const payload = payloadOf(1_000);
    const dest = destination();
    const caller = new AbortController();
    const { fetchImpl, requests } = scriptedFetch([
      () => {
        caller.abort(new Error('thread closed'));
        return new Response(streamOf(payload.slice(0, 500), 250, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length) },
        });
      },
    ]);

    await expect(
      downloadToFileWithSha(URL_UNDER_TEST, dest, {
        fetchImpl,
        signal: caller.signal,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  test('restarts when a resumed response describes a different file', async () => {
    const payload = payloadOf(2_000);
    const replaced = payloadOf(2_400).reverse();
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
      () =>
        new Response(streamOf(replaced.slice(1_000), 500, 'close'), {
          status: 206,
          headers: { 'content-range': `bytes 1000-2399/${replaced.length}` },
        }),
      () =>
        new Response(streamOf(replaced, 500, 'close'), {
          status: 200,
          headers: { 'content-length': String(replaced.length) },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, {
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(sha).toBe(sha256(replaced));
    expect(new Uint8Array(readFileSync(dest))).toEqual(replaced);
    expect(requests.map((r) => r.range)).toEqual([null, 'bytes=1000-', null]);
  });

  test('treats a range past the end of a complete body as done', async () => {
    const payload = payloadOf(1_500);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload, 500, 'error'), { status: 200, headers: { etag: '"v1"' } }),
      () =>
        new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${payload.length}` },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, {
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(sha).toBe(sha256(payload));
    expect(requests.map((r) => r.range)).toEqual([null, 'bytes=1500-']);
  });

  test('gives up when restarts never get past the furthest point reached', async () => {
    const payload = payloadOf(4_000);
    const dest = destination();
    const dropAfter = [2_000, 1_500, 1_800, 1_200, 1_900];
    const { fetchImpl, requests } = scriptedFetch(
      dropAfter.map(
        (bytes) => () =>
          new Response(streamOf(payload.slice(0, bytes), 100, 'error'), {
            status: 200,
            headers: { 'content-length': String(payload.length) },
          }),
      ),
    );

    await expect(
      downloadToFileWithSha(URL_UNDER_TEST, dest, {
        fetchImpl,
        maxAttemptsWithoutProgress: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/after 4 attempts/);
    expect(requests).toHaveLength(4);
  });

  test('gives up after repeated server errors', async () => {
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () => new Response('unavailable', { status: 503 }),
    ]);

    await expect(
      downloadToFileWithSha(URL_UNDER_TEST, dest, {
        fetchImpl,
        maxAttemptsWithoutProgress: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/HTTP 503 .*received 0 B of an unknown size after 3 attempts/);
    expect(requests).toHaveLength(3);
  });

  test('restarts instead of resuming when the server gave no validator', async () => {
    const payload = payloadOf(2_000);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length) },
        }),
      () =>
        new Response(streamOf(payload, 500, 'close'), {
          status: 200,
          headers: { 'content-length': String(payload.length) },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, { fetchImpl, retryDelayMs: 0 });

    expect(sha).toBe(sha256(payload));
    expect(requests).toEqual([
      { range: null, ifRange: null },
      { range: null, ifRange: null },
    ]);
  });

  test('never resumes from a weak entity tag', async () => {
    const payload = payloadOf(2_000);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: {
            'content-length': String(payload.length),
            etag: 'W/"v1"',
            'last-modified': 'Tue, 27 Oct 2026 09:04:42 GMT',
          },
        }),
      () =>
        new Response(streamOf(payload, 500, 'close'), {
          status: 200,
          headers: { 'content-length': String(payload.length) },
        }),
    ]);

    await downloadToFileWithSha(URL_UNDER_TEST, dest, { fetchImpl, retryDelayMs: 0 });

    expect(requests.map((r) => r.range)).toEqual([null, null]);
  });

  test('uses Last-Modified as the resume validator when there is no entity tag', async () => {
    const payload = payloadOf(2_000);
    const lastModified = 'Tue, 27 Oct 2026 09:04:42 GMT';
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length), 'last-modified': lastModified },
        }),
      () =>
        new Response(streamOf(payload.slice(1_000), 500, 'close'), {
          status: 206,
          headers: { 'content-range': `bytes 1000-1999/${payload.length}` },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, { fetchImpl, retryDelayMs: 0 });

    expect(sha).toBe(sha256(payload));
    expect(requests[1]).toEqual({ range: 'bytes=1000-', ifRange: lastModified });
  });

  test('restarts when a resumed response carries a different entity tag', async () => {
    const payload = payloadOf(2_000);
    const replaced = payloadOf(2_000).reverse();
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
      () =>
        new Response(streamOf(replaced.slice(1_000), 500, 'close'), {
          status: 206,
          headers: { 'content-range': `bytes 1000-1999/${replaced.length}`, etag: '"v2"' },
        }),
      () =>
        new Response(streamOf(replaced, 500, 'close'), {
          status: 200,
          headers: { 'content-length': String(replaced.length), etag: '"v2"' },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, { fetchImpl, retryDelayMs: 0 });

    expect(sha).toBe(sha256(replaced));
    expect(new Uint8Array(readFileSync(dest))).toEqual(replaced);
    expect(requests.map((r) => r.range)).toEqual([null, 'bytes=1000-', null]);
  });

  test('restarts when a range is unsatisfiable for a file of a different size', async () => {
    const payload = payloadOf(2_000);
    const smaller = payloadOf(800);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
      () =>
        new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${smaller.length}` },
        }),
      () =>
        new Response(streamOf(smaller, 400, 'close'), {
          status: 200,
          headers: { 'content-length': String(smaller.length), etag: '"v2"' },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, { fetchImpl, retryDelayMs: 0 });

    expect(sha).toBe(sha256(smaller));
    expect(requests.map((r) => r.range)).toEqual([null, 'bytes=1000-', null]);
  });

  test('never resumes a content-encoded response', async () => {
    const payload = payloadOf(2_000);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: { 'content-encoding': 'gzip', etag: '"v1"' },
        }),
      () =>
        new Response(streamOf(payload, 500, 'close'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
    ]);

    await downloadToFileWithSha(URL_UNDER_TEST, dest, { fetchImpl, retryDelayMs: 0 });

    expect(requests.map((r) => r.range)).toEqual([null, null]);
  });

  test('reports the furthest progress after a restart that fails before any data', async () => {
    const payload = payloadOf(2_000);
    const dest = destination();
    const { fetchImpl } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
      () =>
        new Response(null, {
          status: 416,
          headers: { 'content-range': 'bytes */1500' },
        }),
      () => new Response('unavailable', { status: 503 }),
    ]);
    const retries: Array<{
      receivedBytes: number;
      totalBytes: number | null;
      resumeFromBytes: number;
    }> = [];

    await expect(
      downloadToFileWithSha(URL_UNDER_TEST, dest, {
        fetchImpl,
        maxAttemptsWithoutProgress: 3,
        retryDelayMs: 0,
        onRetry: ({ receivedBytes, totalBytes, resumeFromBytes }) =>
          retries.push({ receivedBytes, totalBytes, resumeFromBytes }),
      }),
    ).rejects.toThrow(/HTTP 503 .*received 1000 B of 2\.0 KB after 4 attempts/);
    expect(retries).toEqual([
      { receivedBytes: 1_000, totalBytes: 2_000, resumeFromBytes: 1_000 },
      { receivedBytes: 1_000, totalBytes: 2_000, resumeFromBytes: 0 },
      { receivedBytes: 1_000, totalBytes: 2_000, resumeFromBytes: 0 },
    ]);
  });

  test('reports the offset the next attempt resumes from', async () => {
    const payload = payloadOf(2_000);
    const dest = destination();
    const { fetchImpl } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
      () =>
        new Response(streamOf(payload.slice(1_000), 500, 'close'), {
          status: 206,
          headers: { 'content-range': `bytes 1000-1999/${payload.length}`, etag: '"v1"' },
        }),
    ]);
    const resumeOffsets: number[] = [];

    await downloadToFileWithSha(URL_UNDER_TEST, dest, {
      fetchImpl,
      retryDelayMs: 0,
      onRetry: ({ resumeFromBytes }) => resumeOffsets.push(resumeFromBytes),
    });

    expect(resumeOffsets).toEqual([1_000]);
  });

  test('never resumes from an entity tag that is not a quoted strong tag', async () => {
    const payload = payloadOf(2_000);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: {
            'content-length': String(payload.length),
            etag: 'abc123',
            'last-modified': 'Tue, 27 Oct 2026 18:00:00 GMT',
          },
        }),
      () =>
        new Response(streamOf(payload, 500, 'close'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: 'abc123' },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, { fetchImpl, retryDelayMs: 0 });

    expect(sha).toBe(sha256(payload));
    expect(requests).toEqual([
      { range: null, ifRange: null },
      { range: null, ifRange: null },
    ]);
  });

  test('restarts when a range is unsatisfiable at a length short of the declared size', async () => {
    const payload = payloadOf(2_000);
    const dest = destination();
    const { fetchImpl, requests } = scriptedFetch([
      () =>
        new Response(streamOf(payload.slice(0, 1_000), 500, 'error'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
      () =>
        new Response(null, {
          status: 416,
          headers: { 'content-range': 'bytes */1000' },
        }),
      () =>
        new Response(streamOf(payload, 500, 'close'), {
          status: 200,
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        }),
    ]);

    const sha = await downloadToFileWithSha(URL_UNDER_TEST, dest, { fetchImpl, retryDelayMs: 0 });

    expect(sha).toBe(sha256(payload));
    expect(requests.map((r) => r.range)).toEqual([null, 'bytes=1000-', null]);
  });

  test('names the network error code behind a dropped connection', async () => {
    const dest = destination();
    const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const { fetchImpl } = scriptedFetch([
      () =>
        new Response(
          streamOf(
            new Uint8Array(0),
            500,
            'error',
            new TypeError('terminated', { cause: socketError }),
          ),
          { status: 200 },
        ),
    ]);

    await expect(
      downloadToFileWithSha(URL_UNDER_TEST, dest, {
        fetchImpl,
        maxAttemptsWithoutProgress: 1,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/^terminated \(UND_ERR_SOCKET\) \(received 0 B/);
  });

  test('names a local write failure code once', async () => {
    const dest = join(destination(), 'missing', 'archive.zip');
    const { fetchImpl } = scriptedFetch([
      () => new Response(streamOf(payloadOf(100), 100, 'close'), { status: 200 }),
    ]);

    const message = await downloadToFileWithSha(URL_UNDER_TEST, dest, {
      fetchImpl,
      retryDelayMs: 0,
    }).then(
      () => 'resolved',
      (err: Error) => err.message,
    );

    expect(message).toMatch(/could not write/);
    expect(message.match(/ENOENT/g)).toHaveLength(1);
  });
});
