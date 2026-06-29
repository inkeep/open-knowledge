
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

interface RigSeam {
  server: Server;
  port: number;
  baseUrl: string;
}

async function bootRigSeam(handler: RequestListener): Promise<RigSeam> {
  const server = createServer(handler);
  const { port, baseUrl } = await listenOnLoopback(server);
  return { server, port, baseUrl };
}

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
  throw new Error(`rig advertises a non-loopback dial host: ${hostname}`);
}

describe('rig loopback exclusivity', () => {
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
    if (errors.length > 0)
      throw new AggregateError(errors, 'rig-loopback-exclusivity cleanup failed');
  });

  test('client dial reaches the rig even when a foreign loopback-specific listener squats the rig port', async () => {
    const rigToken = randomUUID();
    const { server, port, baseUrl } = await bootRigSeam((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ rigToken }));
    });
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));

    const markerToken = `foreign-${randomUUID()}`;
    for (const host of ['127.0.0.1', '::1'] as const) {
      const marker = await tryBindForeignMarker(host, port, markerToken);
      if (typeof marker === 'object') cleanups.push(marker.close);
    }

    const res = await fetch(`${baseUrl}/whoami`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.headers.get('x-foreign-marker')).toBeNull();
    expect(body).toEqual({ rigToken });
  });

  test('rig exclusively owns every loopback address its client URL can resolve to', async () => {
    const { server, port, baseUrl } = await bootRigSeam((_req, res) => {
      res.end('ok');
    });
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));

    const squattable: string[] = [];
    for (const host of dialedLoopbackAddresses(baseUrl)) {
      const marker = await tryBindForeignMarker(host, port, 'exclusivity-probe');
      if (marker === 'family-unavailable') continue;
      if (typeof marker === 'object') {
        squattable.push(host);
        cleanups.push(marker.close);
      }
    }

    expect(squattable).toEqual([]);
  });
});
