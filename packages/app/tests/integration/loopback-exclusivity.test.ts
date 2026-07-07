/**
 * Pins the test-rig socket-ownership invariant against the REAL shared
 * harness boundary (`createTestServer`): the address harness clients dial
 * must be an address the harness's HTTP server socket EXCLUSIVELY owns for
 * the lifetime of the test.
 *
 * Before this fix the harness booted via a hostless probe bind followed by
 * a hostless `httpServer.listen(port)` — an IPv6 wildcard (`::`) bind whose
 * loopback-specific slots (`127.0.0.1:p`, `[::1]:p`) the kernel leaves
 * bindable by foreign processes, with no EADDRINUSE — and consumers dialed
 * the ambiguous name `localhost`, which Bun resolves `::1`-first: exactly
 * the slot a foreign loopback-specific listener can hold. That foreign
 * listener silently answered the test's requests: the rotating
 * share/git-context flake. The harness now binds `127.0.0.1` at both the
 * probe and the rebind and advertises the bound literal (`server.baseUrl`);
 * this test pins that the rig exclusively owns every address its dial URL
 * can resolve to.
 *
 * These tests plant the foreign listener deterministically (marker
 * responders on the loopback-specific slots of the harness's own port)
 * instead of waiting for the ephemeral-port allocator to collide. Real
 * kernel sockets, real harness server; nothing is mocked. Markers only ever
 * attempt a FRESH bind — no existing listener is touched.
 *
 * Sibling (same invariant, hand-rolled server-package seam):
 * packages/server/src/rig-loopback-exclusivity.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';

import { createTestServer } from './test-harness';

interface ForeignMarker {
  host: string;
  close: () => Promise<void>;
}

/**
 * Attempt to bind a foreign-process stand-in on a loopback-specific address.
 * 'rig-owned' means the bind was refused EADDRINUSE — exclusive ownership by
 * the rig is exactly what the invariant demands, so a refused bind is
 * evidence FOR the invariant, never a test error. 'family-unavailable'
 * (EADDRNOTAVAIL / EAFNOSUPPORT — no IPv6 loopback on this host) is kept
 * distinct so an unprobeable family is excluded explicitly instead of being
 * laundered into ownership evidence; any other errno rejects.
 */
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
    // Host literals inline (not the parameter) so the bind-discipline source
    // scan can verify this bind is loopback-specific.
    s.listen(port, host === '::1' ? '::1' : '127.0.0.1', () => {
      resolve({
        host,
        close: () => new Promise<void>((r) => s.close(() => r())),
      });
    });
  });
}

/**
 * The loopback addresses a client dialing this URL may actually connect to.
 * `localhost` is ambiguous across address families (Bun dials `::1` first),
 * so the rig must own BOTH slots for the dial to be safe; an explicit
 * literal pins a single family.
 */
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
    // Run every cleanup even when one throws — an aborted stack leaks marker
    // listeners into subsequent tests, which is precisely the foreign-listener
    // condition this suite detects.
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

    // A marker (or any foreign process) answering here means the harness
    // server never saw the request — the cross-process interception behind
    // the rotating integration-suite assertion flakes.
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
      // An absent family can't be squatted (nor dialed) — exclude it
      // explicitly rather than counting it as rig-owned.
      if (marker === 'family-unavailable') continue;
      if (typeof marker === 'object') {
        squattable.push(host);
        cleanups.push(marker.close);
      }
    }

    // Every dialable slot must already be owned by the harness server (the
    // marker bind must fail EADDRINUSE). Each entry here is an address a
    // foreign process could bind and silently intercept consumer traffic on.
    expect(squattable).toEqual([]);
  });
});
