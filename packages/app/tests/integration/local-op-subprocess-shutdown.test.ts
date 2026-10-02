import { expect, test } from 'vitest';
import { createControlledAuthCli, observeChildren } from './auth-child-lifecycle.test-helper';
import { createTestServer, type TestServer } from './test-harness';

test.each(['status', 'repos', 'signout'])(
  'server destruction ends its pending auth %s subprocess',
  async (operation) => {
    const fixture = await createControlledAuthCli();
    const observer = observeChildren(fixture.cliArgs);
    const controller = new AbortController();
    let server: TestServer | undefined;
    let request: Promise<unknown> | undefined;
    try {
      server = await createTestServer({ localOpCliArgs: fixture.cliArgs });
      request = fetch(`${server.baseUrl}/api/local-op/auth/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: 'github.com' }),
        signal: controller.signal,
      })
        .then((response) => response.text())
        .catch((error: unknown) => error);
      await fixture.ready;
      expect(observer.children).toHaveLength(1);
      await server.instance.destroy();
      expect(observer.runningPids()).toEqual([]);
    } finally {
      controller.abort();
      await fixture.release();
      await Promise.all(observer.children.map(({ closed }) => closed));
      await request;
      await server?.cleanup();
      observer.stop();
    }
  },
);

test.each(['pat', 'status', 'repos', 'signout'])(
  'a pending auth %s request after server destruction starts no subprocess',
  async (operation) => {
    const fixture = await createControlledAuthCli();
    const observer = observeChildren(fixture.cliArgs);
    const controller = new AbortController();
    let server: TestServer | undefined;
    let request: Promise<{ kind: 'response'; status: number }> | undefined;
    try {
      server = await createTestServer({ localOpCliArgs: fixture.cliArgs });
      await server.instance.destroy();
      request = fetch(`${server.baseUrl}/api/local-op/auth/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: 'github.com',
          ...(operation === 'pat' ? { token: 'fixture-token' } : {}),
        }),
        signal: controller.signal,
      })
        .then(async (response) => {
          await response.text();
          return { kind: 'response' as const, status: response.status };
        })
        .catch(() => ({ kind: 'response' as const, status: 0 }));
      const first = await Promise.race([
        request,
        fixture.ready.then(() => ({ kind: 'child' as const })),
      ]);
      expect(first.kind).toBe('response');
      if (first.kind === 'response') expect(first.status).toBe(503);
      expect(observer.children).toHaveLength(0);
    } finally {
      controller.abort();
      await fixture.release();
      await Promise.all(observer.children.map(({ closed }) => closed));
      await request;
      await server?.cleanup();
      observer.stop();
    }
  },
);
