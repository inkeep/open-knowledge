import { expect, test } from 'vitest';
import { createControlledAuthCli, observeChildren } from './auth-child-lifecycle.test-helper';
import { createTestServer, type TestServer } from './test-harness';

test('server destruction ends a pending token sign-in child', async () => {
  const fixture = await createControlledAuthCli();
  const observer = observeChildren(fixture.cliArgs);
  let server: TestServer | undefined;
  const controller = new AbortController();
  let response: Promise<unknown> | undefined;
  try {
    server = await createTestServer({ localOpCliArgs: fixture.cliArgs });
    response = fetch(`${server.baseUrl}/api/local-op/auth/pat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'fixture-token', host: 'github.com' }),
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await fixture.ready;
    expect(observer.children).toHaveLength(1);
    await server.instance.destroy();
    expect(observer.runningPids()).toEqual([]);
  } finally {
    controller.abort();
    await fixture.release();
    await Promise.all(observer.children.map(({ closed }) => closed));
    await response;
    await server?.cleanup();
    observer.stop();
  }
});
