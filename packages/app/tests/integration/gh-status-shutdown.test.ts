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
  'an auth status result after shutdown cannot start gh discovery',
  async () => {
    const fixture = await createControlledGh({
      version: 'park',
      auth: 'park',
      lookup: 'park',
      status: 'park',
    });
    vi.stubEnv('PATH', `${fixture.dir}${delimiter}${process.env.PATH ?? ''}`);
    const observer = observeChildren(['gh']);
    const controller = new AbortController();
    let server: TestServer | undefined;
    let request: Promise<{ kind: 'response'; status: number }> | undefined;
    let destruction: Promise<void> | undefined;
    try {
      server = await createTestServer({ localOpCliArgs: ['gh'] });
      request = fetch(`${server.baseUrl}/api/local-op/auth/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: 'github.com' }),
        signal: controller.signal,
      })
        .then(async (response) => {
          await response.text();
          return { kind: 'response' as const, status: response.status };
        })
        .catch(() => ({ kind: 'response' as const, status: 0 }));
      const status = await fixture.next('status');
      expect(observer.children.some(({ pid }) => pid === status.pid)).toBe(true);
      destruction = server.instance.destroy();
      fixture.release('status');
      const first = await Promise.race([
        request,
        fixture.next('version').then(() => ({ kind: 'version' as const })),
      ]);
      expect(first.kind).toBe('response');
      if (first.kind === 'response') expect(first.status).toBe(503);
      expect(
        observer.children.filter(({ child }) => child.spawnargs.includes('--version')),
      ).toHaveLength(0);
      await destruction;
    } finally {
      controller.abort();
      await fixture.cleanup();
      await request;
      await destruction;
      await Promise.all(observer.children.map(({ closed }) => closed));
      await server?.cleanup();
      observer.stop();
      vi.unstubAllEnvs();
    }
  },
);
