/**
 * Pins the test-rig socket-ownership invariant: the address a rig's test
 * client dials must be an address the rig's server socket EXCLUSIVELY owns
 * for the lifetime of the test.
 *
 * The prevailing rig-boot convention in this package's tests
 * (`server.listen(0)` + dial `http://localhost:${port}`) violates it: on
 * macOS, a bare `listen(0)` binds a single IPv6 wildcard socket (`::`), and
 * the kernel deliberately allows loopback-SPECIFIC binds (`127.0.0.1:p`,
 * `[::1]:p`) on the same port number to coexist with it — no EADDRINUSE.
 * Any process holding such a bind answers the rig's `localhost` dials
 * (most-specific bound socket wins), so the test asserts against a foreign
 * server's response. On dev machines with long-lived loopback listeners
 * (`ok ui`, the desktop server, concurrent agent sessions) this surfaces as
 * the rotating share/git-context suite flake.
 *
 * These tests make the foreign listener deterministic instead of waiting on
 * the ephemeral-port allocator: bind marker responders on the
 * loopback-specific slots of the very port the rig received, then require
 * that the rig — not a marker — answers the client dial. Real kernel
 * sockets throughout; nothing is mocked. Markers only ever attempt a FRESH
 * bind; no existing listener is touched, so a genuinely foreign holder of
 * the port degrades to the same failure the invariant forbids.
 *
 * `bootRigSeam` below replicates the boot + client-URL seam this package's
 * test files hand-roll (publish.integration.test.ts, construct-url.test.ts,
 * api-extension*.test.ts, …). When a shared loopback-listen helper replaces
 * those hand-rolled seams, point `bootRigSeam` at the helper — this file
 * then becomes the helper's contract test. The companion source scan
 * (loopback-bind-discipline.test.ts) enumerates the sites that must
 * migrate.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

interface RigSeam {
  server: Server;
  port: number;
  /** Base URL the rig's HTTP helpers dial (the seam's client half). */
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
  throw new Error(`rig advertises a non-loopback dial host: ${hostname}`);
}

describe('rig loopback exclusivity', () => {
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

    // A marker (or any foreign process) answering here means the rig never
    // saw the request — the cross-process interception behind the rotating
    // share/git-context assertion flakes.
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
      // An absent family can't be squatted (nor dialed) — exclude it
      // explicitly rather than counting it as rig-owned.
      if (marker === 'family-unavailable') continue;
      if (typeof marker === 'object') {
        squattable.push(host);
        cleanups.push(marker.close);
      }
    }

    // Every dialable slot must already be owned by the rig (the marker bind
    // must fail EADDRINUSE). Each entry here is an address a foreign process
    // could bind and silently intercept this rig's client traffic on.
    expect(squattable).toEqual([]);
  });
});
