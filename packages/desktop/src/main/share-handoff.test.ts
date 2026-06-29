import { describe, expect, test } from 'bun:test';
import {
  buildContinueUrl,
  classifyRedeemRequest,
  type FirstRunHandshakeDeps,
  generateNonce,
  type HandoffHttpRequest,
  type HandoffHttpResponse,
  type HandoffHttpServer,
  type HandoffOutcome,
  nonceMatches,
  parseRedeemRequestUrl,
  resolveContinueBase,
  startFirstRunHandshake,
} from './share-handoff.ts';

const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN = 'AWh0dHBzOi8vZ2l0aHViLmNvbS9pbmtlZXAvdGVjaC1pcG9z';

describe('nonce', () => {
  test('generateNonce returns 128 bits of hex (32 chars)', () => {
    const n = generateNonce();
    expect(n).toMatch(/^[a-f0-9]{32}$/);
    expect(generateNonce()).not.toBe(n);
  });

  test('nonceMatches is exact and false on null/length/value mismatch', () => {
    expect(nonceMatches(NONCE, NONCE)).toBe(true);
    expect(nonceMatches(NONCE, null)).toBe(false);
    expect(nonceMatches(NONCE, `${NONCE}0`)).toBe(false);
    expect(nonceMatches(NONCE, NONCE.replace('a', 'b'))).toBe(false);
  });
});

describe('classifyRedeemRequest', () => {
  test('non-redeem path is ignored (does not burn the nonce)', () => {
    expect(
      classifyRedeemRequest({
        pathname: '/favicon.ico',
        token: TOKEN,
        nonce: NONCE,
        expectedNonce: NONCE,
      }),
    ).toEqual({ kind: 'ignore' });
  });

  test('wrong nonce is invalid', () => {
    expect(
      classifyRedeemRequest({
        pathname: '/redeem',
        token: TOKEN,
        nonce: 'deadbeef',
        expectedNonce: NONCE,
      }),
    ).toEqual({ kind: 'invalid' });
  });

  test('malformed token is invalid', () => {
    expect(
      classifyRedeemRequest({
        pathname: '/redeem',
        token: 'has spaces!',
        nonce: NONCE,
        expectedNonce: NONCE,
      }),
    ).toEqual({ kind: 'invalid' });
  });

  test('valid request reconstructs the universal-link share URL + done hop', () => {
    const decision = classifyRedeemRequest({
      pathname: '/redeem',
      token: TOKEN,
      nonce: NONCE,
      expectedNonce: NONCE,
    });
    expect(decision).toEqual({
      kind: 'redeem',
      shareUrl: `https://openknowledge.ai/d/${TOKEN}`,
      doneLocation: 'https://openknowledge.ai/continue/done',
    });
  });
});

describe('resolveContinueBase (dev override, loopback-pinned)', () => {
  test('defaults to production when the env var is unset', () => {
    expect(resolveContinueBase({})).toBe('https://openknowledge.ai');
  });

  test.each([
    ['http://localhost:3010', 'http://localhost:3010'],
    ['http://127.0.0.1:3010/', 'http://127.0.0.1:3010'],
    ['https://localhost:3010', 'https://localhost:3010'],
    ['http://[::1]:3010', 'http://[::1]:3010'],
  ])('honors a loopback override %s → %s (trailing slash trimmed)', (input, expected) => {
    expect(resolveContinueBase({ OK_CONTINUE_URL_BASE: input })).toBe(expected);
  });

  test.each([
    ['https://evil.example.com'],
    ['http://192.168.1.5:3010'],
    ['http://openknowledge.ai.evil.com'],
    ['ftp://localhost'],
    ['not a url'],
    [''],
  ])('rejects non-loopback / malformed %s → falls back to production', (input) => {
    expect(resolveContinueBase({ OK_CONTINUE_URL_BASE: input })).toBe('https://openknowledge.ai');
  });
});

describe('url helpers', () => {
  test('buildContinueUrl targets the apex continue route with port+nonce', () => {
    expect(buildContinueUrl(52431, NONCE, 'https://openknowledge.ai')).toBe(
      `https://openknowledge.ai/continue?port=52431&nonce=${NONCE}`,
    );
  });

  test('buildContinueUrl honors a loopback base for local testing', () => {
    expect(buildContinueUrl(52431, NONCE, 'http://localhost:3010')).toBe(
      `http://localhost:3010/continue?port=52431&nonce=${NONCE}`,
    );
  });

  test('classifyRedeemRequest done hop follows the continue base; share URL stays on apex', () => {
    const decision = classifyRedeemRequest({
      pathname: '/redeem',
      token: TOKEN,
      nonce: NONCE,
      expectedNonce: NONCE,
      continueBase: 'http://localhost:3010',
    });
    expect(decision).toEqual({
      kind: 'redeem',
      shareUrl: `https://openknowledge.ai/d/${TOKEN}`,
      doneLocation: 'http://localhost:3010/continue/done',
    });
  });

  test('parseRedeemRequestUrl pulls token + nonce from the query', () => {
    const parsed = parseRedeemRequestUrl(
      `/redeem?token=${TOKEN}&nonce=${NONCE}`,
      'http://127.0.0.1',
    );
    expect(parsed).toEqual({ pathname: '/redeem', token: TOKEN, nonce: NONCE });
  });
});


class FakeResponse implements HandoffHttpResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body: string | undefined;
  ended = false;
  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  end(body?: string) {
    this.body = body;
    this.ended = true;
  }
}

class FakeServer implements HandoffHttpServer {
  handler: (req: HandoffHttpRequest, res: HandoffHttpResponse) => void;
  errorCb: ((err: NodeJS.ErrnoException) => void) | null = null;
  closed = false;
  listening = false;
  constructor(handler: (req: HandoffHttpRequest, res: HandoffHttpResponse) => void) {
    this.handler = handler;
  }
  listen(_port: number, _host: string, cb: () => void) {
    this.listening = true;
    cb();
  }
  on(_event: 'error', cb: (err: NodeJS.ErrnoException) => void) {
    this.errorCb = cb;
  }
  address() {
    return { port: 52431 };
  }
  close() {
    this.closed = true;
  }
  request(url: string): FakeResponse {
    const res = new FakeResponse();
    this.handler({ url }, res);
    return res;
  }
}

function harness(over: Partial<FirstRunHandshakeDeps> = {}) {
  const outcomes: HandoffOutcome[] = [];
  const opened: string[] = [];
  const routed: string[] = [];
  let server: FakeServer | undefined;
  const deps: FirstRunHandshakeDeps = {
    isFirstRun: () => true,
    createServer: (handler) => {
      server = new FakeServer(handler);
      return server;
    },
    openExternal: (url) => opened.push(url),
    routeShareUrl: (url) => routed.push(url),
    recordOutcome: (o) => outcomes.push(o),
    generateNonce: () => NONCE,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    ...over,
  };
  startFirstRunHandshake(deps);
  const getServer = (): FakeServer => {
    if (!server) throw new Error('handshake did not create a server');
    return server;
  };
  return { outcomes, opened, routed, getServer };
}

describe('startFirstRunHandshake', () => {
  test('not a first run → records skipped, opens nothing', () => {
    const h = harness({ isFirstRun: () => false });
    expect(h.outcomes).toEqual(['skipped']);
    expect(h.opened).toEqual([]);
  });

  test('arms a loopback listener and opens the continue URL with the nonce', () => {
    const h = harness();
    expect(h.opened).toEqual([`https://openknowledge.ai/continue?port=52431&nonce=${NONCE}`]);
    expect(h.outcomes).toEqual([]);
  });

  test('valid redemption routes the share URL, 302s to done, records redeemed', () => {
    const h = harness();
    const res = h.getServer().request(`/redeem?token=${TOKEN}&nonce=${NONCE}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('https://openknowledge.ai/continue/done');
    expect(h.routed).toEqual([`https://openknowledge.ai/d/${TOKEN}`]);
    expect(h.outcomes).toEqual(['redeemed']);
    expect(h.getServer().closed).toBe(true);
  });

  test('wrong nonce → invalid, no routing, friendly failure body', () => {
    const h = harness();
    const res = h.getServer().request(`/redeem?token=${TOKEN}&nonce=deadbeef`);
    expect(res.statusCode).toBe(400);
    expect(h.routed).toEqual([]);
    expect(h.outcomes).toEqual(['invalid']);
  });

  test('nonce is single-use: a second request after redemption gets 410', () => {
    const h = harness();
    const server = h.getServer();
    server.request(`/redeem?token=${TOKEN}&nonce=${NONCE}`);
    const second = server.request(`/redeem?token=${TOKEN}&nonce=${NONCE}`);
    expect(second.statusCode).toBe(410);
    expect(h.routed).toHaveLength(1);
  });

  test('non-redeem probe does not burn the nonce', () => {
    const h = harness();
    const server = h.getServer();
    const probe = server.request('/favicon.ico');
    expect(probe.statusCode).toBe(404);
    const res = server.request(`/redeem?token=${TOKEN}&nonce=${NONCE}`);
    expect(res.statusCode).toBe(302);
    expect(h.outcomes).toEqual(['redeemed']);
  });

  test('timeout closes the listener and records timeout', () => {
    let fire: (() => void) | null = null;
    const h = harness({
      setTimeout: (cb) => {
        fire = cb;
        return 0;
      },
    });
    if (!fire) throw new Error('timeout was not scheduled');
    fire();
    expect(h.outcomes).toEqual(['timeout']);
    expect(h.getServer().closed).toBe(true);
  });

  test('server error event records bind-failed; a second error does not double-record', () => {
    const h = harness();
    const server = h.getServer();
    server.errorCb?.({
      code: 'EADDRINUSE',
      name: 'Error',
      message: 'bind error',
    } as NodeJS.ErrnoException);
    expect(h.outcomes).toEqual(['bind-failed']);
    server.errorCb?.({
      code: 'EADDRINUSE',
      name: 'Error',
      message: 'bind error',
    } as NodeJS.ErrnoException);
    expect(h.outcomes).toHaveLength(1);
  });

  test('address() returning null in the listen callback records bind-failed and closes', () => {
    let closed = false;
    const h = harness({
      createServer: (_handler) => ({
        listen(_port: number, _host: string, cb: () => void) {
          cb();
        },
        on(_event: 'error', _cb: (err: NodeJS.ErrnoException) => void) {},
        address: () => null,
        close: () => {
          closed = true;
        },
      }),
    });
    expect(h.outcomes).toEqual(['bind-failed']);
    expect(closed).toBe(true);
  });

  test('routeShareUrl throwing after response does not propagate — records redeemed', () => {
    const h = harness({
      routeShareUrl: () => {
        throw new Error('downstream error');
      },
    });
    const res = h.getServer().request(`/redeem?token=${TOKEN}&nonce=${NONCE}`);
    expect(res.statusCode).toBe(302);
    expect(h.outcomes).toEqual(['redeemed']);
  });
});
