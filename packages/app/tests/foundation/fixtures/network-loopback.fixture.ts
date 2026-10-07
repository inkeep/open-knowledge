import { expect, test, vi } from 'vitest';
import { stubApiRoutes } from '../api-routes.test-helper';
import { describeBoth } from './mock-consumer';

vi.mock('./mock-subject', () => ({ alpha: 'mocked-alpha', beta: 'mocked-beta' }));

test('requests to the test server, another loopback address, a stubbed API route and a mocked module', async () => {
  expect((await fetch(location.href)).ok).toBe(true);
  const samePageOnAnotherLoopbackAddress = new URL(location.href);
  samePageOnAnotherLoopbackAddress.hostname = '127.0.0.1';
  await fetch(samePageOnAnotherLoopbackAddress, { mode: 'no-cors' }).catch(() => undefined);
  stubApiRoutes({ '/api/ping': () => new Response('pong') });
  expect(await (await fetch('/api/ping')).text()).toBe('pong');
  expect(describeBoth()).toBe('mocked-alpha+mocked-beta');
});
