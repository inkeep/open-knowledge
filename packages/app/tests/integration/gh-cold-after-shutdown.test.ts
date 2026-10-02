import { delimiter } from 'node:path';
import { expect, test, vi } from 'vitest';
import { observeChildren } from './auth-child-lifecycle.test-helper';
import { createControlledGh } from './gh-process-lifecycle.test-helper';
import { createTestServer, type TestServer } from './test-harness';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { guardAbsoluteGhLaunches } = await import('./gh-process-safety.test-helper');
  return guardAbsoluteGhLaunches(original);
});

test.skipIf(process.platform === 'win32')(
  'a cold gh sign-in request after shutdown starts no gh child',
  async () => {
    const fixture = await createControlledGh({ version: 'park', auth: 'park', lookup: 'park' });
    vi.stubEnv('PATH', `${fixture.dir}${delimiter}${process.env.PATH ?? ''}`);
    const observer = observeChildren(['gh']);
    const controller = new AbortController();
    let server: TestServer | undefined;
    let request: Promise<{ kind: 'response'; status: number; body: string }> | undefined;
    try {
      server = await createTestServer();
      await server.instance.destroy();
      request = fetch(`${server.baseUrl}/api/local-op/auth/gh-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      })
        .then(async (response) => ({
          kind: 'response' as const,
          status: response.status,
          body: await response.text(),
        }))
        .catch(() => ({ kind: 'response' as const, status: 0, body: '' }));
      const first = await Promise.race([
        request,
        fixture.next('version').then(() => ({ kind: 'version' as const })),
      ]);
      expect(first.kind).toBe('response');
      if (first.kind === 'response') expect(first.status).toBe(503);
      expect(observer.children).toHaveLength(0);
    } finally {
      controller.abort();
      await fixture.cleanup();
      await request;
      await Promise.all(observer.children.map(({ closed }) => closed));
      await server?.cleanup();
      observer.stop();
      vi.unstubAllEnvs();
    }
  },
);
