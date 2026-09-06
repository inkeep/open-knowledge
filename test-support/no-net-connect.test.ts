import { createServer } from 'node:http';
import { describe, expect, test, vi } from 'vitest';
import { installNoNetConnect, isLoopbackHostname, NetConnectBlockedError } from './no-net-connect';
import {
  REFUSED_LOOPBACK_ORIGIN,
  REFUSED_LOOPBACK_ORIGIN_ALT,
} from './refused-loopback.test-helper';

// Port 1 is on the WHATWG fetch blocked-port list. It is named only here, as the
// alternative the refused origin must NOT drift into.
const FETCH_BLOCKED_PORT_ORIGIN = 'http://127.0.0.1:1';

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

// Only the tests that trip the guard ON PURPOSE mute it, and each of them asserts
// the `[no-net-connect]` line was emitted. Muting block-wide would swallow an
// UNEXPECTED console.error from the tests that are meant to stay silent, and
// muting without asserting would leave the log line -- the enforcement mechanism
// behind the zero-lines invariant -- as the one thing here with no coverage.
async function blockedBy(run: () => Promise<unknown>): Promise<unknown> {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const outcome = await run().catch((e: unknown) => e);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[no-net-connect]'));
    return outcome;
  } finally {
    consoleError.mockRestore();
  }
}

describe('the installed fetch guard', () => {
  test('socketless schemes are allowed through without a host check', async () => {
    const res = await fetch('data:text/plain,hello');
    expect(await res.text()).toBe('hello');
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
      const err = await blockedBy(() => fetch('https://example.com'));
      expect(err).toBeInstanceOf(NetConnectBlockedError);
    } finally {
      globalThis.fetch = guarded;
    }
  });

  test('rejects a non-loopback request and names the offending test', async () => {
    const err = (await blockedBy(() =>
      fetch('https://intake.invalid-tld-for-test.invalid/api/bug-report'),
    )) as Error;
    expect(err).toBeInstanceOf(NetConnectBlockedError);
    expect(err.message).toMatch(/intake\.invalid-tld-for-test\.invalid/);
    expect(err.message).toMatch(/names the offending test/);
  });

  test('carries no errno-shaped `code`, so it cannot masquerade as a real transport error', async () => {
    const err = await blockedBy(() => fetch('https://example.com'));
    expect(err).toBeInstanceOf(NetConnectBlockedError);
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  test('lets a real loopback server through untouched', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('reachable');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(await res.text()).toBe('reachable');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test.each([
    REFUSED_LOOPBACK_ORIGIN,
    REFUSED_LOOPBACK_ORIGIN_ALT,
  ])('%s yields a real kernel-level transport error', async (origin) => {
    const err = (await fetch(`${origin}/api`).catch((e: unknown) => e)) as {
      name?: string;
      cause?: { code?: string; syscall?: string };
    };
    expect(err).not.toBeInstanceOf(NetConnectBlockedError);
    expect(err.name).toBe('TypeError');
    expect(err.cause?.code).toBe('ECONNREFUSED');
    expect(err.cause?.syscall).toBe('connect');
  });

  test.each([
    REFUSED_LOOPBACK_ORIGIN,
    REFUSED_LOOPBACK_ORIGIN_ALT,
  ])('%s sits below every ephemeral range, so listen(0) cannot hand it out', (origin) => {
    const port = Number(new URL(origin).port);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(32768);
  });

  test('a fetch-blocked port would NOT do: it fails with no errno at all', async () => {
    const err = (await fetch(`${FETCH_BLOCKED_PORT_ORIGIN}/api`).catch((e: unknown) => e)) as {
      name?: string;
      cause?: { code?: string };
    };
    expect(err.name).toBe('TypeError');
    expect(err.cause?.code).toBeUndefined();
  });
});
