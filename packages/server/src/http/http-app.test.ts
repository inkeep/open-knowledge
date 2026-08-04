import { createServer } from 'node:http';
import { describe, expect, test } from 'vitest';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import { type CreateHttpAppOptions, createHttpApp } from './http-app.ts';

/**
 * Adapter-boundary pins the composition suite cannot see: these assert
 * properties of the router mount itself — global-object hygiene, body
 * passthrough to the legacy dispatch, and error finalization after headers
 * are sent — independent of any real route behavior.
 */

const fakeLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => fakeLog,
} as never;

async function serveWith(legacyDispatch: CreateHttpAppOptions['legacyDispatch']) {
  const { requestListener } = createHttpApp({ legacyDispatch, log: fakeLog });
  const server = createServer(requestListener);
  const { baseUrl } = await listenOnLoopback(server);
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      }),
  };
}

describe('createHttpApp adapter boundary', () => {
  test('mounting and serving leaves globalThis.Request/Response untouched', async () => {
    const RequestBefore = globalThis.Request;
    const ResponseBefore = globalThis.Response;
    const rig = await serveWith((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    try {
      const res = await fetch(`${rig.baseUrl}/anything`);
      expect(res.status).toBe(204);
      expect(globalThis.Request).toBe(RequestBefore);
      expect(globalThis.Response).toBe(ResponseBefore);
    } finally {
      await rig.close();
    }
  });

  test('the catch-all leaves the request body for the legacy dispatch to consume', async () => {
    const rig = await serveWith((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(body);
      });
    });
    try {
      const payload = 'x'.repeat(64 * 1024);
      const res = await fetch(`${rig.baseUrl}/echo`, { method: 'POST', body: payload });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(payload);
    } finally {
      await rig.close();
    }
  });

  test('a handler throw after headers are sent finalizes the response instead of hanging', async () => {
    const rig = await serveWith((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      throw new Error('post-head boom');
    });
    try {
      // The onError fallback branch must end the response — a hang here
      // would leave the fetch pending until the test times out.
      const res = await fetch(`${rig.baseUrl}/partial`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    } finally {
      await rig.close();
    }
  });
});
