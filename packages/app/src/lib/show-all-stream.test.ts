import { describe, expect, test } from 'vitest';
import {
  consumeShowAllStream,
  isNdjsonResponse,
  SHOW_ALL_NDJSON_ACCEPT,
  ShowAllStreamError,
} from './show-all-stream';

function docLine(docName: string): string {
  return `${JSON.stringify({
    kind: 'document',
    docName,
    docExt: '.md',
    size: 1,
    modified: '2026-01-01T00:00:00.000Z',
    isSymlink: false,
    canonicalDocName: null,
    targetPath: null,
  })}\n`;
}

function completeLine(truncated: boolean, count: number): string {
  return `${JSON.stringify({ type: 'complete', truncated, count })}\n`;
}

function ndjsonResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
}

function chunkedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
}

describe('isNdjsonResponse', () => {
  test('true for an ok x-ndjson response with a body', () => {
    expect(isNdjsonResponse(ndjsonResponse(completeLine(false, 0)))).toBe(true);
  });

  test('false for a JSON response (buffered fallback)', () => {
    const res = new Response('{"documents":[]}', {
      headers: { 'content-type': 'application/json' },
    });
    expect(isNdjsonResponse(res)).toBe(false);
  });

  test('false for a non-2xx response even if x-ndjson', () => {
    const res = new Response('boom', {
      status: 500,
      headers: { 'content-type': 'application/x-ndjson' },
    });
    expect(isNdjsonResponse(res)).toBe(false);
  });

  test('the Accept header opts into the stream', () => {
    expect(SHOW_ALL_NDJSON_ACCEPT.Accept).toContain('application/x-ndjson');
  });
});

describe('consumeShowAllStream', () => {
  test('parses entries and the terminal complete verdict', async () => {
    const body = docLine('alpha') + docLine('beta') + completeLine(false, 2);
    const { entries, truncated } = await consumeShowAllStream(ndjsonResponse(body));
    expect(entries.map((e) => e.docName)).toEqual(['alpha', 'beta']);
    expect(truncated).toBe(false);
  });

  test('surfaces truncated:true from the complete line', async () => {
    const body = docLine('alpha') + completeLine(true, 1);
    const { entries, truncated } = await consumeShowAllStream(ndjsonResponse(body));
    expect(entries.length).toBe(1);
    expect(truncated).toBe(true);
  });

  test('reassembles a line split across chunk boundaries', async () => {
    const full = docLine('alpha') + docLine('beta') + completeLine(false, 2);
    const mid = Math.floor(full.length / 2);
    const { entries, truncated } = await consumeShowAllStream(
      chunkedResponse([full.slice(0, mid), full.slice(mid)]),
    );
    expect(entries.map((e) => e.docName)).toEqual(['alpha', 'beta']);
    expect(truncated).toBe(false);
  });

  test('throws ShowAllStreamError on a mid-stream error event', async () => {
    const body =
      docLine('alpha') +
      `${JSON.stringify({ type: 'error', problem: { title: 'walk exploded' } })}\n`;
    await expect(consumeShowAllStream(ndjsonResponse(body))).rejects.toBeInstanceOf(
      ShowAllStreamError,
    );
  });

  test('drops an unparseable line but keeps the valid entries', async () => {
    const body = `${docLine('alpha')}not json at all\n${docLine('beta')}${completeLine(false, 2)}`;
    const { entries } = await consumeShowAllStream(ndjsonResponse(body));
    expect(entries.map((e) => e.docName)).toEqual(['alpha', 'beta']);
  });

  test('a stream that closes without a complete line returns the parsed prefix, untruncated', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(docLine('alpha') + docLine('beta')));
        controller.close();
      },
    });
    const res = new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
    const { entries, truncated } = await consumeShowAllStream(res);
    expect(entries.map((e) => e.docName)).toEqual(['alpha', 'beta']);
    expect(truncated).toBe(false);
  });

  test('a transport error mid-stream rejects so the caller can surface unreachable-server', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(docLine('alpha')));
        controller.error(new TypeError('connection reset'));
      },
    });
    const res = new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
    await expect(consumeShowAllStream(res)).rejects.toThrow('connection reset');
  });

  test('drops a schema-divergent entry line', async () => {
    const bad = `${JSON.stringify({ kind: 'document', docName: 'x', assetExt: 'png' })}\n`;
    const body = bad + docLine('beta') + completeLine(false, 1);
    const { entries } = await consumeShowAllStream(ndjsonResponse(body));
    expect(entries.map((e) => e.docName)).toEqual(['beta']);
  });

  test('onBatch delivers each chunk’s entries incrementally before completion', async () => {
    const res = chunkedResponse([
      docLine('alpha') + docLine('beta'),
      docLine('gamma') + completeLine(false, 3),
    ]);
    const batches: string[][] = [];
    const { entries } = await consumeShowAllStream(res, {
      onBatch: (batch) => batches.push(batch.map((e) => e.docName)),
    });
    expect(batches).toEqual([['alpha', 'beta'], ['gamma']]);
    expect(entries.map((e) => e.docName)).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('onBatch is not called for a chunk carrying only the terminal complete line', async () => {
    const res = chunkedResponse([docLine('alpha'), completeLine(false, 1)]);
    const batchSizes: number[] = [];
    await consumeShowAllStream(res, { onBatch: (batch) => batchSizes.push(batch.length) });
    expect(batchSizes).toEqual([1]);
  });

  test('a throw from onBatch propagates out of consumeShowAllStream', async () => {
    const res = chunkedResponse([docLine('alpha'), completeLine(false, 1)]);
    await expect(
      consumeShowAllStream(res, {
        onBatch: () => {
          throw new Error('consumer blew up');
        },
      }),
    ).rejects.toThrow('consumer blew up');
  });
});
