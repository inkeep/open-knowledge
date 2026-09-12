import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { Agent, Dispatcher, MockAgent } from 'undici';
import { describe, expect, test } from 'vitest';
import {
  type DispatcherRequestInit,
  expectBlockedNetworkRequest,
  installNoNetConnect,
  isLoopbackHostname,
  NetConnectBlockedError,
} from './no-net-connect';
import {
  REFUSED_LOOPBACK_ORIGIN,
  REFUSED_LOOPBACK_ORIGIN_ALT,
} from './refused-loopback.test-helper';

const FETCH_BLOCKED_PORT_ORIGIN = 'http://127.0.0.1:1';

type ListeningServer = {
  origin: string;
  server: Server;
  close: () => Promise<void>;
};

async function listen(handler: RequestListener): Promise<ListeningServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Server has no TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function blockedBy(
  hostname: string,
  run: () => Promise<unknown>,
): Promise<NetConnectBlockedError> {
  expectBlockedNetworkRequest(hostname);
  const outcome = await run().catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(NetConnectBlockedError);
  return outcome as NetConnectBlockedError;
}

describe('isLoopbackHostname', () => {
  test.each([
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.1.2.3',
    '127.255.255.255',
    '::1',
    '[::1]',
    'app.localhost',
  ])('%s is loopback', (host) => expect(isLoopbackHostname(host)).toBe(true));

  test.each([
    'example.com',
    'intake.invalid-tld-for-test.invalid',
    '127.0.0.1.evil.com',
    'notlocalhost',
    '10.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '::',
    '127.999.0.1',
    '127.0.0.256',
  ])('%s is not loopback', (host) => expect(isLoopbackHostname(host)).toBe(false));
});

describe('the installed fetch guard', () => {
  test('socketless schemes are allowed through without a host check', async () => {
    const response = await fetch('data:text/plain,hello');
    expect(await response.text()).toBe('hello');
  });

  test('installing twice is a no-op because the marker rides the wrapper', () => {
    const before = globalThis.fetch;
    installNoNetConnect();
    expect(globalThis.fetch).toBe(before);
  });

  test('reinstalling over an unmarked reassignment re-wraps rather than trusting a stale global', async () => {
    const guarded = globalThis.fetch;
    const unmarked = (async () => new Response('bypassed')) as typeof globalThis.fetch;
    globalThis.fetch = unmarked;
    try {
      installNoNetConnect();
      expect(globalThis.fetch).not.toBe(unmarked);
      const error = await blockedBy('example.com', () => fetch('https://example.com'));
      expect(error.message).toContain('example.com');
    } finally {
      globalThis.fetch = guarded;
    }
  });

  test('passes a full Dispatcher instance to the underlying fetch', async () => {
    const guarded = globalThis.fetch;
    let captured: Dispatcher | undefined;
    const underlying: typeof globalThis.fetch = async (_input, init) => {
      captured = (init as DispatcherRequestInit).dispatcher;
      return new Response('captured');
    };
    globalThis.fetch = underlying;
    try {
      installNoNetConnect();
      const response = await fetch('http://localhost/resource');
      expect(await response.text()).toBe('captured');
      expect(captured).toBeInstanceOf(Dispatcher);
      for (const method of ['dispatch', 'compose', 'request', 'close', 'destroy'] as const) {
        expect(typeof captured?.[method]).toBe('function');
      }
    } finally {
      globalThis.fetch = guarded;
    }
  });

  test('blocks a dispatch whose origin it cannot verify', async () => {
    const guarded = globalThis.fetch;
    let captured: Dispatcher | undefined;
    const underlying: typeof globalThis.fetch = async (_input, init) => {
      captured = (init as DispatcherRequestInit).dispatcher;
      return new Response('captured');
    };
    globalThis.fetch = underlying;
    try {
      installNoNetConnect();
      await fetch('http://localhost/resource');
      expectBlockedNetworkRequest('<unverifiable-origin>');
      let rejection: unknown;
      try {
        captured?.dispatch({ path: '/resource', method: 'GET' }, {});
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(NetConnectBlockedError);
      expect((rejection as Error).message).toContain('<unverifiable-origin>');
    } finally {
      globalThis.fetch = guarded;
    }
  });

  test('blocks a relative dispatch origin even when a document base would make it loopback', async () => {
    const guarded = globalThis.fetch;
    let captured: Dispatcher | undefined;
    const underlying: typeof globalThis.fetch = async (_input, init) => {
      captured = (init as DispatcherRequestInit).dispatcher;
      return new Response('captured');
    };
    globalThis.fetch = underlying;
    const hadLocation = 'location' in globalThis;
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'http://localhost/page' },
      configurable: true,
      writable: true,
    });
    try {
      installNoNetConnect();
      await fetch('http://localhost/resource');
      expectBlockedNetworkRequest('<unverifiable-origin>');
      let rejection: unknown;
      try {
        captured?.dispatch({ path: '/resource', method: 'GET', origin: 'relative-origin' }, {});
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(NetConnectBlockedError);
      expect((rejection as Error).message).toContain('<unverifiable-origin>');
    } finally {
      globalThis.fetch = guarded;
      if (!hadLocation) Reflect.deleteProperty(globalThis, 'location');
    }
  });

  test('forwards a caller dispatcher for an allowed request', async () => {
    let targetHits = 0;
    const target = await listen((_request, response) => {
      targetHits += 1;
      response.end('through dispatcher');
    });
    const targetPort = new URL(target.origin).port;
    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, _options, callback) {
          callback(null, [{ address: '127.0.0.1', family: 4 }]);
        },
      },
    });
    try {
      const response = await fetch(`http://allowed.localhost:${targetPort}/destination`, {
        dispatcher,
      } as DispatcherRequestInit);
      expect(await response.text()).toBe('through dispatcher');
      expect(targetHits).toBe(1);
    } finally {
      await dispatcher.close();
      await target.close();
    }
  });

  test('preserves caller MockAgent matching and consumes its interceptor', async () => {
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    dispatcher
      .get('http://mocked.localhost')
      .intercept({ method: 'GET', path: '/resource' })
      .reply(200, 'mocked response');
    try {
      const response = await fetch('http://mocked.localhost/resource', {
        dispatcher,
      } as DispatcherRequestInit);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('mocked response');
      dispatcher.assertNoPendingInterceptors();
    } finally {
      await dispatcher.close();
    }
  });

  test('preserves caller MockAgent body matching and the body a reply callback reads', async () => {
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    let observedBody: unknown;
    dispatcher
      .get('http://mocked.localhost')
      .intercept({ method: 'POST', path: '/resource', body: 'declared body' })
      .reply(200, (options: { body?: unknown }) => {
        observedBody = options.body;
        return 'matched on body';
      });
    try {
      const response = await fetch('http://mocked.localhost/resource', {
        method: 'POST',
        body: 'declared body',
        dispatcher,
      } as DispatcherRequestInit);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('matched on body');
      expect(observedBody).toBe('declared body');
      dispatcher.assertNoPendingInterceptors();
    } finally {
      await dispatcher.close();
    }
  });

  test('declared blocked requests consume the exact hostname expectation', async () => {
    const error = await blockedBy('example.com', () => fetch('https://example.com'));
    expect(error.message).toContain('example.com');
  });

  test('rejects a non-loopback request and names the offending test', async () => {
    const hostname = 'intake.invalid-tld-for-test.invalid';
    const error = await blockedBy(hostname, () => fetch(`https://${hostname}/api/bug-report`));
    expect(error.message).toContain(hostname);
    expect(error.message).toMatch(/names the offending test/);
  });

  test('carries no errno-shaped code, so it cannot masquerade as a real transport error', async () => {
    const error = await blockedBy('example.com', () => fetch('https://example.com'));
    expect((error as { code?: unknown }).code).toBeUndefined();
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  test('lets a real loopback server through untouched', async () => {
    const target = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('reachable');
    });
    try {
      const response = await fetch(target.origin);
      expect(await response.text()).toBe('reachable');
    } finally {
      await target.close();
    }
  });

  test.each([REFUSED_LOOPBACK_ORIGIN, REFUSED_LOOPBACK_ORIGIN_ALT])(
    '%s yields a real kernel-level transport error',
    async (origin) => {
      const error = (await fetch(`${origin}/api`).catch((caught: unknown) => caught)) as {
        name?: string;
        cause?: { code?: string; syscall?: string };
      };
      expect(error).not.toBeInstanceOf(NetConnectBlockedError);
      expect(error.name).toBe('TypeError');
      expect(error.cause?.code).toBe('ECONNREFUSED');
      expect(error.cause?.syscall).toBe('connect');
    },
  );

  test.each([REFUSED_LOOPBACK_ORIGIN, REFUSED_LOOPBACK_ORIGIN_ALT])(
    '%s sits below every ephemeral range, so listen(0) cannot hand it out',
    (origin) => {
      const port = Number(new URL(origin).port);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(32768);
    },
  );

  test('a fetch-blocked port would not do because it fails with no errno at all', async () => {
    const error = (await fetch(`${FETCH_BLOCKED_PORT_ORIGIN}/api`).catch(
      (caught: unknown) => caught,
    )) as {
      name?: string;
      cause?: { code?: string };
    };
    expect(error.name).toBe('TypeError');
    expect(error.cause?.code).toBeUndefined();
  });
});

describe('native fetch redirect semantics', () => {
  test.each(['manual', 'error'] as const)(
    'honors redirect mode %s from a Request input',
    async (redirect) => {
      let targetHits = 0;
      const target = await listen((_request, response) => {
        targetHits += 1;
        response.end('followed');
      });
      const source = await listen((_request, response) => {
        response.writeHead(302, { location: `${target.origin}/destination` });
        response.end();
      });
      try {
        const request = new Request(`${source.origin}/source`, { redirect });
        if (redirect === 'manual') {
          const response = await fetch(request);
          expect(response.status).toBe(302);
          expect(response.headers.get('location')).toBe(`${target.origin}/destination`);
        } else {
          const error = await fetch(request).catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(TypeError);
        }
        expect(targetHits).toBe(0);
      } finally {
        await Promise.all([source.close(), target.close()]);
      }
    },
  );

  test('follows a relative redirect and reports the final response URL', async () => {
    const target = await listen((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: '/final' });
        response.end();
        return;
      }
      response.end('arrived');
    });
    try {
      const response = await fetch(`${target.origin}/start`);
      expect(await response.text()).toBe('arrived');
      expect(response.url).toBe(`${target.origin}/final`);
      expect(response.redirected).toBe(true);
    } finally {
      await target.close();
    }
  });

  test.each([302, 303])('rewrites POST to GET after a %i redirect', async (status) => {
    const received: Array<{ method: string | undefined; body: string }> = [];
    const target = await listen(async (request, response) => {
      if (request.url === '/start') {
        await readBody(request);
        response.writeHead(status, { location: '/final' });
        response.end();
        return;
      }
      received.push({ method: request.method, body: await readBody(request) });
      response.end('arrived');
    });
    try {
      const response = await fetch(`${target.origin}/start`, {
        method: 'POST',
        body: 'original-body',
      });
      expect(await response.text()).toBe('arrived');
      expect(received).toEqual([{ method: 'GET', body: '' }]);
    } finally {
      await target.close();
    }
  });

  test('preserves POST method and body after a 307 redirect', async () => {
    const received: Array<{ method: string | undefined; body: string }> = [];
    const target = await listen(async (request, response) => {
      if (request.url === '/start') {
        await readBody(request);
        response.writeHead(307, { location: '/final' });
        response.end();
        return;
      }
      received.push({ method: request.method, body: await readBody(request) });
      response.end('arrived');
    });
    try {
      const response = await fetch(`${target.origin}/start`, {
        method: 'POST',
        body: 'original-body',
      });
      expect(await response.text()).toBe('arrived');
      expect(received).toEqual([{ method: 'POST', body: 'original-body' }]);
    } finally {
      await target.close();
    }
  });

  test('strips credentials when a redirect crosses origins', async () => {
    let receivedHeaders: IncomingMessage['headers'] | undefined;
    const target = await listen((request, response) => {
      receivedHeaders = request.headers;
      response.end('arrived');
    });
    const source = await listen((_request, response) => {
      response.writeHead(302, { location: `${target.origin}/final` });
      response.end();
    });
    try {
      const response = await fetch(`${source.origin}/start`, {
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'proxy-authorization': 'Basic secret',
        },
      });
      expect(await response.text()).toBe('arrived');
      expect(receivedHeaders?.authorization).toBeUndefined();
      expect(receivedHeaders?.cookie).toBeUndefined();
      expect(receivedHeaders?.['proxy-authorization']).toBeUndefined();
    } finally {
      await Promise.all([source.close(), target.close()]);
    }
  });

  test('returns a nonredirect 304 response without another request', async () => {
    let requests = 0;
    const target = await listen((request, response) => {
      requests += 1;
      if (request.url === '/destination') {
        response.end('incorrectly followed');
        return;
      }
      response.writeHead(304, { location: '/destination' });
      response.end();
    });
    try {
      const response = await fetch(target.origin);
      expect(response.status).toBe(304);
      expect(response.redirected).toBe(false);
      expect(requests).toBe(1);
    } finally {
      await target.close();
    }
  });

  test('allows twenty redirects and rejects the twenty-first', async () => {
    const hits = new Map<number, number>();
    const target = await listen((request, response) => {
      const match = /^\/(\d+)\/(\d+)$/.exec(request.url ?? '');
      if (match === null) throw new Error(`Unexpected redirect path ${request.url}`);
      const total = Number(match[1]);
      const step = Number(match[2]);
      hits.set(total, (hits.get(total) ?? 0) + 1);
      if (step < total) {
        response.writeHead(302, { location: `/${total}/${step + 1}` });
        response.end();
        return;
      }
      response.end('arrived');
    });
    try {
      const allowed = await fetch(`${target.origin}/20/0`);
      expect(await allowed.text()).toBe('arrived');
      const rejected = await fetch(`${target.origin}/21/0`).catch((caught: unknown) => caught);
      expect(rejected).toBeInstanceOf(TypeError);
      expect(hits.get(20)).toBe(21);
      expect(hits.get(21)).toBe(21);
    } finally {
      await target.close();
    }
  });

  test('blocks a redirected external hostname before its dispatcher can reach loopback', async () => {
    let targetHits = 0;
    const target = await listen((_request, response) => {
      targetHits += 1;
      response.end('guard bypassed');
    });
    const targetPort = new URL(target.origin).port;
    let sourceHits = 0;
    const source = await listen((request, response) => {
      sourceHits += 1;
      response.writeHead(302, {
        location:
          request.url === '/source'
            ? '/allowed-hop'
            : `http://blocked.invalid:${targetPort}/destination`,
      });
      response.end();
    });
    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, _options, callback) {
          callback(null, [{ address: '127.0.0.1', family: 4 }]);
        },
      },
    });
    try {
      const error = await blockedBy('blocked.invalid', () =>
        fetch(`${source.origin}/source`, { dispatcher } as DispatcherRequestInit),
      );
      expect(error.message).toContain('blocked.invalid');
      expect(sourceHits).toBe(2);
      expect(targetHits).toBe(0);
    } finally {
      await dispatcher.close();
      await Promise.all([source.close(), target.close()]);
    }
  });
});
