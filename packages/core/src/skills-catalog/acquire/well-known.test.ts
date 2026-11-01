import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { SKILL_IMPORT_MAX_FILE_BYTES, SKILL_IMPORT_MAX_TOTAL_BYTES } from '../import-limits.ts';
import { fetchWellKnownSkill, readWellKnownIndex } from './well-known.ts';

const origin = 'https://skills.example.com';
const mib = 1024 * 1024;

function streamedResponse(size: number, headers?: HeadersInit) {
  let consumed = 0;
  let cancelled = false;
  const chunk = new Uint8Array(mib / 4);
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (consumed === size) {
            controller.close();
            return;
          }
          const bytes = chunk.subarray(0, Math.min(chunk.length, size - consumed));
          consumed += bytes.length;
          controller.enqueue(bytes);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers },
  );
  return { response, consumed: () => consumed, cancelled: () => cancelled };
}

function indexFor(files: string[]) {
  return {
    basePath: '/.well-known/skills',
    skills: [{ name: 'alpha', description: '', files }],
  };
}

describe('website skill streaming budgets', () => {
  test('cancels oversized indexes before consuming the whole body, including fallback', async () => {
    const streams: ReturnType<typeof streamedResponse>[] = [];
    const fetchImpl: typeof fetch = async () => {
      const stream = streamedResponse(2 * mib);
      streams.push(stream);
      return stream.response;
    };
    await expect(readWellKnownIndex(origin, { fetchImpl })).rejects.toThrow('1048576 bytes');
    expect(streams).toHaveLength(2);
    for (const stream of streams) {
      expect(stream.cancelled()).toBe(true);
      expect(stream.consumed()).toBeLessThanOrEqual(mib + mib / 4);
    }
  });

  test('accepts an index at the exact byte limit and preserves UTF-8 text', async () => {
    const json = JSON.stringify({
      skills: [{ name: 'alpha', description: 'café', files: ['SKILL.md'] }],
    });
    const raw = json + ' '.repeat(mib - Buffer.byteLength(json));
    const fetchImpl: typeof fetch = async () => new Response(raw);
    await expect(readWellKnownIndex(origin, { fetchImpl })).resolves.toEqual({
      basePath: '/.well-known/agent-skills',
      skills: [{ name: 'alpha', description: 'café', files: ['SKILL.md'] }],
    });
  });

  test.each([undefined, { 'content-length': '1' }])(
    'cancels a file exceeding the actual byte cap with headers %j',
    async (headers) => {
      const stream = streamedResponse(2 * SKILL_IMPORT_MAX_FILE_BYTES, headers);
      const fetchImpl: typeof fetch = async () => stream.response;
      await expect(
        fetchWellKnownSkill(
          { kind: 'well-known', origin, skill: 'alpha' },
          { fetchImpl, index: indexFor(['SKILL.md']) },
        ),
      ).rejects.toThrow(`file exceeds ${SKILL_IMPORT_MAX_FILE_BYTES} bytes`);
      expect(stream.cancelled()).toBe(true);
      expect(stream.consumed()).toBeLessThanOrEqual(SKILL_IMPORT_MAX_FILE_BYTES + mib / 4);
    },
  );

  test('rejects an oversized declared file without reading its body', async () => {
    const stream = streamedResponse(mib, {
      'content-length': String(SKILL_IMPORT_MAX_FILE_BYTES + 1),
    });
    const fetchImpl: typeof fetch = async () => stream.response;
    await expect(
      fetchWellKnownSkill(
        { kind: 'well-known', origin, skill: 'alpha' },
        { fetchImpl, index: indexFor(['SKILL.md']) },
      ),
    ).rejects.toThrow('file exceeds');
    expect(stream.consumed()).toBe(0);
    expect(stream.cancelled()).toBe(true);
  });

  test('enforces the bundle budget across partial concurrent files and aborts peers', async () => {
    const files = ['SKILL.md', ...Array.from({ length: 9 }, (_, n) => `file-${n}.bin`)];
    const streams: ReturnType<typeof streamedResponse>[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      signals.push(init?.signal);
      const stream = streamedResponse(SKILL_IMPORT_MAX_FILE_BYTES);
      streams.push(stream);
      return stream.response;
    };
    await expect(
      fetchWellKnownSkill(
        { kind: 'well-known', origin, skill: 'alpha' },
        { fetchImpl, index: indexFor(files) },
      ),
    ).rejects.toThrow(`bundle exceeds ${SKILL_IMPORT_MAX_TOTAL_BYTES} bytes`);
    expect(streams).toHaveLength(8);
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
    expect(streams.every((stream) => stream.cancelled())).toBe(true);
    expect(streams.reduce((sum, stream) => sum + stream.consumed(), 0)).toBeLessThanOrEqual(
      SKILL_IMPORT_MAX_TOTAL_BYTES + (8 * mib) / 4,
    );
  });

  test('accepts exact per-file and bundle limits and cleans up binary files', async () => {
    const files = ['SKILL.md', 'a.bin', 'b.bin', 'c.bin'];
    const fetchImpl: typeof fetch = async () =>
      streamedResponse(SKILL_IMPORT_MAX_FILE_BYTES).response;
    const fetched = await fetchWellKnownSkill(
      { kind: 'well-known', origin, skill: 'alpha' },
      { fetchImpl, index: indexFor(files) },
    );
    try {
      for (const file of files) {
        expect(
          readFileSync(join(fetched.dir, file)).equals(Buffer.alloc(SKILL_IMPORT_MAX_FILE_BYTES)),
        ).toBe(true);
      }
    } finally {
      fetched.cleanup();
    }
    expect(existsSync(fetched.dir)).toBe(false);
  });

  test('does not request queued files when peers finish after another worker aborts', async () => {
    const files = ['SKILL.md', ...Array.from({ length: 9 }, (_, n) => `file-${n}.bin`)];
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requested.push(String(input));
      if (String(input).endsWith('SKILL.md')) {
        return new Response('oversized', {
          headers: { 'content-length': String(SKILL_IMPORT_MAX_FILE_BYTES + 1) },
        });
      }
      const signal = init?.signal;
      if (!signal) throw new Error('Missing request signal');
      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      return new Response('peer finished');
    };
    await expect(
      fetchWellKnownSkill(
        { kind: 'well-known', origin, skill: 'alpha' },
        { fetchImpl, index: indexFor(files) },
      ),
    ).rejects.toThrow('file exceeds');
    expect(requested).toHaveLength(8);
  });

  test('waits for aborted peers to settle before rejecting the bundle', async () => {
    const { promise: aborted, resolve: observeAbort } = Promise.withResolvers<void>();
    const { promise: cleanup, resolve: finishCleanup } = Promise.withResolvers<void>();
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).endsWith('SKILL.md')) {
        return new Response('oversized', {
          headers: { 'content-length': String(SKILL_IMPORT_MAX_FILE_BYTES + 1) },
        });
      }
      const signal = init?.signal;
      if (!signal) throw new Error('Missing request signal');
      signal.addEventListener('abort', () => observeAbort(), { once: true });
      await cleanup;
      signal.throwIfAborted();
      throw new Error('Peer was not aborted');
    };
    let settled = false;
    const outcome = fetchWellKnownSkill(
      { kind: 'well-known', origin, skill: 'alpha' },
      { fetchImpl, index: indexFor(['SKILL.md', 'peer.bin']) },
    ).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await Promise.race([aborted, outcome]);
      await setImmediate();
      expect(settled).toBe(false);
    } finally {
      finishCleanup();
      await outcome;
    }
    expect(await outcome).toHaveProperty('message', expect.stringContaining('file exceeds'));
  });

  test('rejects decoded overflow and aborts an in-flight native-fetch peer', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const { promise: peerClosed, resolve: closePeer } = Promise.withResolvers<void>();
    const { promise: peerStarted, resolve: startOversized } = Promise.withResolvers<void>();
    const compressed = gzipSync(Buffer.alloc(SKILL_IMPORT_MAX_FILE_BYTES + 1));
    const server = createServer((request, response) => {
      if (request.url?.endsWith('peer.bin')) {
        response.on('close', closePeer);
        response.write('waiting');
        startOversized();
      } else {
        void peerStarted.then(() => {
          response.writeHead(200, { 'content-encoding': 'gzip' });
          response.end(compressed);
        });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing TCP address');
    const fetchImpl: typeof fetch = (input, init) => {
      signals.push(init?.signal);
      return fetch(`http://127.0.0.1:${address.port}${new URL(String(input)).pathname}`, init);
    };
    try {
      await expect(
        fetchWellKnownSkill(
          { kind: 'well-known', origin, skill: 'alpha' },
          { fetchImpl, index: indexFor(['SKILL.md', 'peer.bin']) },
        ),
      ).rejects.toThrow(`file exceeds ${SKILL_IMPORT_MAX_FILE_BYTES} bytes`);
      expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
      await peerClosed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
