import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';

import { createTestServer } from './test-harness';

interface ForeignMarker {
  host: string;
  close: () => Promise<void>;
}

function tryBindForeignMarker(
  host: '127.0.0.1' | '::1',
  port: number,
  markerToken: string,
): Promise<ForeignMarker | 'rig-owned' | 'family-unavailable'> {
  return new Promise((resolve, reject) => {
    const s = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-foreign-marker': markerToken,
      });
      res.end(JSON.stringify({ foreignMarker: markerToken, answeredOn: host }));
    });
    s.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') resolve('rig-owned');
      else if (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')
        resolve('family-unavailable');
      else reject(err);
    });
    s.listen(port, host === '::1' ? '::1' : '127.0.0.1', () => {
      resolve({
        host,
        close: () => new Promise<void>((r) => s.close(() => r())),
      });
    });
  });
}

function dialedLoopbackAddresses(baseUrl: string): Array<'127.0.0.1' | '::1'> {
  const hostname = new URL(baseUrl).hostname;
  if (hostname === 'localhost') return ['127.0.0.1', '::1'];
  if (hostname === '127.0.0.1') return ['127.0.0.1'];
  if (hostname === '::1' || hostname === '[::1]') return ['::1'];
  throw new Error(`harness advertises a non-loopback dial host: ${hostname}`);
}

describe('test-harness loopback exclusivity', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (!fn) continue;
      try {
        await fn();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'loopback-exclusivity cleanup failed');
  });

  test('consumer dial reaches the harness server even when a foreign loopback-specific listener squats its port', async () => {
    const server = await createTestServer();
    cleanups.push(server.cleanup);

    const markerToken = `foreign-${crypto.randomUUID()}`;
    for (const host of ['127.0.0.1', '::1'] as const) {
      const marker = await tryBindForeignMarker(host, server.port, markerToken);
      if (typeof marker === 'object') cleanups.push(marker.close);
    }

    const res = await fetch(`${server.baseUrl}/api/documents`);
    const body = (await res.json()) as { documents?: unknown };

    expect(res.headers.get('x-foreign-marker')).toBeNull();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.documents)).toBe(true);
  });

  test('harness server exclusively owns every loopback address its consumer dial URL can resolve to', async () => {
    const server = await createTestServer();
    cleanups.push(server.cleanup);

    const squattable: string[] = [];
    for (const host of dialedLoopbackAddresses(server.baseUrl)) {
      const marker = await tryBindForeignMarker(host, server.port, 'exclusivity-probe');
      if (marker === 'family-unavailable') continue;
      if (typeof marker === 'object') {
        squattable.push(host);
        cleanups.push(marker.close);
      }
    }

    expect(squattable).toEqual([]);
  });
});
